import { dirname } from '@std/path'
import { gatewayConfigPath, GATEWAY_DEFAULT_PORT } from '/src/gateway/paths.ts'

/**
 * Gateway config persisted at ~/.slv/gateway/gateway.json.
 *
 * - `port` defaults to 18789 (matches OpenClaw for documentation parity).
 * - `token` is a 256-bit random hex string generated on first run. Clients
 *   (TUI, future web UI) read this to authenticate WS connections.
 * - `mode: 'local'` is a hard gate — the gateway refuses to start if
 *   missing, so misconfigured instances can't accidentally bind to a
 *   public interface. Future modes like `lan` or `tailnet` would bypass
 *   the loopback bind.
 *
 * Stored as JSON rather than YAML to match OpenClaw's precedent and
 * because web clients will need to read it too.
 */
export type GatewayMode = 'local'

export type GatewayConfig = {
  port: number
  token: string
  mode: GatewayMode
}

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
    throw new Error(
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
    if (typeof parsed.token !== 'string' || parsed.token.length < 32) {
      throw new Error('gateway.json: token missing or too short')
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

