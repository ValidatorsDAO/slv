import { dirname } from '@std/path'
import {
  gatewayConfigPath,
  GATEWAY_DEFAULT_PORT,
} from '/src/gateway/paths.ts'
import { randomHex } from '/lib/randomHex.ts'

/**
 * Gateway config persisted at ~/.slv/gateway/gateway.json.
 *
 * - `port` defaults to {@link GATEWAY_DEFAULT_PORT} (20026).
 * - `token` is a 256-bit random hex string (64 chars) generated on
 *   first run. Clients (TUI, future web UI) read this to authenticate
 *   WS connections.
 * - `mode: 'local'` is a hard gate — the gateway refuses to start if
 *   missing, so misconfigured instances can't accidentally bind to a
 *   public interface. Future modes like `lan` or `tailnet` would
 *   bypass the loopback bind.
 */
export type GatewayMode = 'local'

export type GatewayConfig = {
  port: number
  token: string
  mode: GatewayMode
}

// 256 bits of entropy → 64 hex chars.
const TOKEN_MIN_LEN = 64

const defaults = (): GatewayConfig => ({
  port: GATEWAY_DEFAULT_PORT,
  token: randomHex(32),
  mode: 'local',
})

/**
 * Thrown by {@link parseEnvPort} when `SLV_GATEWAY_PORT` is malformed.
 * Separate class so runForeground can give a targeted error message
 * instead of pointing the user at gateway.json (which isn't the
 * problem).
 */
export class GatewayEnvPortError extends Error {
  override name = 'GatewayEnvPortError'
}

/**
 * Atomic write: stage to `<path>.tmp.<pid>` then `rename` onto the
 * target. On POSIX `rename` is atomic within the same filesystem, so
 * a SIGKILL mid-write leaves either the old file or the new one —
 * never a half-written one. Critical for first-run: a crashed write
 * would otherwise wedge the gateway in EX_CONFIG on every retry.
 */
const atomicWrite = async (path: string, text: string): Promise<void> => {
  await Deno.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${Deno.pid}`
  try {
    await Deno.writeTextFile(tmp, text, { mode: 0o600 })
    await Deno.rename(tmp, path)
  } catch (err) {
    await Deno.remove(tmp).catch(() => {})
    throw err
  }
}

/**
 * Read the on-disk config. Throws {@link Deno.errors.NotFound} if the
 * file doesn't exist — callers use {@link ensureGatewayConfig} to
 * create-on-miss.
 */
export const loadGatewayConfig = async (): Promise<GatewayConfig> => {
  const raw = await Deno.readTextFile(gatewayConfigPath)
  const parsed = JSON.parse(raw) as Partial<GatewayConfig>
  if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port)) {
    throw new Error('gateway.json: port must be an integer')
  }
  if (
    typeof parsed.token !== 'string' ||
    parsed.token.length < TOKEN_MIN_LEN
  ) {
    throw new Error(
      `gateway.json: token missing or shorter than ${TOKEN_MIN_LEN} chars (256-bit)`,
    )
  }
  if (parsed.mode !== 'local') {
    throw new Error(`gateway.json: mode must be 'local' (got ${parsed.mode})`)
  }
  return { port: parsed.port, token: parsed.token, mode: parsed.mode }
}

/**
 * Return the persisted config, writing a fresh one with a random
 * token if the file doesn't exist yet. Applies the
 * `SLV_GATEWAY_PORT` env override last.
 */
export const ensureGatewayConfig = async (): Promise<GatewayConfig> => {
  let base: GatewayConfig
  try {
    base = await loadGatewayConfig()
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
    base = defaults()
    await atomicWrite(gatewayConfigPath, JSON.stringify(base, null, 2) + '\n')
  }
  const envPort = parseEnvPort(Deno.env.get('SLV_GATEWAY_PORT'))
  return envPort === null ? base : { ...base, port: envPort }
}

const parseEnvPort = (raw: string | undefined): number | null => {
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new GatewayEnvPortError(
      `SLV_GATEWAY_PORT must be a valid port (1-65535), got "${raw}"`,
    )
  }
  return n
}

