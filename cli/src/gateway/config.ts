import { dirname } from '@std/path'
import { gatewayConfigPath, GATEWAY_DEFAULT_PORT } from '/src/gateway/paths.ts'

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

// 256 bits of entropy → 64 hex chars. Enforced both on write (below)
// and on read (`TOKEN_MIN_LEN` check in readOrCreate).
const TOKEN_MIN_LEN = 64

const randomToken = (): string => {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

const defaults = (): GatewayConfig => ({
  port: GATEWAY_DEFAULT_PORT,
  token: randomToken(),
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
 * Load the on-disk config. If the file is missing, writes a fresh one
 * (with a random token) and returns it. If the file exists but is
 * malformed, throws — callers should `Deno.exit(78)` (EX_CONFIG).
 *
 * `SLV_GATEWAY_PORT` env var overrides the persisted port at runtime
 * (handy for local testing when the default 18789 is taken). Token
 * and mode are always read from the file.
 */
export const loadOrInitGatewayConfig = async (): Promise<GatewayConfig> => {
  const path = gatewayConfigPath()
  const base = await readOrCreate(path)
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

const readOrCreate = async (path: string): Promise<GatewayConfig> => {
  try {
    const raw = await Deno.readTextFile(path)
    const parsed = JSON.parse(raw) as Partial<GatewayConfig>
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port)) {
      throw new Error('gateway.json: port must be an integer')
    }
    if (typeof parsed.token !== 'string' || parsed.token.length < TOKEN_MIN_LEN) {
      throw new Error(
        `gateway.json: token missing or shorter than ${TOKEN_MIN_LEN} chars (256-bit)`,
      )
    }
    if (parsed.mode !== 'local') {
      throw new Error(`gateway.json: mode must be 'local' (got ${parsed.mode})`)
    }
    return {
      port: parsed.port,
      token: parsed.token,
      mode: parsed.mode,
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
    const fresh = defaults()
    await Deno.mkdir(dirname(path), { recursive: true })
    await Deno.writeTextFile(path, JSON.stringify(fresh, null, 2) + '\n')
    await Deno.chmod(path, 0o600).catch(() => {})
    return fresh
  }
}

