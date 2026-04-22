import { colors } from '@cliffy/colors'
import type { Context } from '@hono/hono'
import { Hono } from '@hono/hono'
import {
  ensureGatewayConfig,
  GatewayEnvPortError,
  hostnameForMode,
} from '/src/gateway/config.ts'
import {
  acquireGatewayLock,
  releaseGatewayLock,
} from '/src/gateway/lock.ts'
import {
  gatewayConfigPath,
  gatewayPidPath,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SERVICE_ID,
} from '/src/gateway/paths.ts'
import { registerWsRoutes } from '/src/gateway/ws/server.ts'
import { renderChatHtml } from '/src/gateway/ui/static.ts'
import { errToString } from '/lib/errToString.ts'

// Exit codes align with sysexits.h so a future systemd unit can set
// RestartPreventExitStatus=78 to avoid crash-looping on a bad config.
const EX_CONFIG = 78
const EX_TEMPFAIL = 75
const EX_UNAVAILABLE = 69

/**
 * Whether a Host header refers to the loopback interface. Matters for
 * token-inlining policy on `/ui/`: loopback requests get the token
 * pre-filled; any other Host must go through the paste-gate. Uses
 * URL's parser so `127.0.0.1.evil.com` doesn't match as `127.0.0.1.*`
 * and IPv6 bracket-stripping is handled correctly.
 */
const isLoopbackHost = (header: string | undefined): boolean => {
  if (!header) return false
  let hostname: string
  try {
    hostname = new URL(`http://${header}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' ||
    hostname === '::1'
}

/**
 * Foreground gateway runner. Phase 1A scope: bind loopback HTTP with a
 * /healthz endpoint, acquire the pidfile lock, install signal handlers
 * for graceful shutdown. WS upgrade + session core come in Phase 1B.
 *
 * Intended as the ExecStart of a future launchd/systemd unit — the
 * process runs in the foreground, logs to stdout/stderr, and exits
 * cleanly on SIGTERM/SIGINT.
 */
export const runGatewayForeground = async (): Promise<number> => {
  const config = await loadConfigOrFail()
  if (typeof config === 'number') return config

  const lock = await acquireGatewayLock(config.port)
  if (lock.state === 'held') {
    console.error(
      colors.red(
        `❌ gateway is already running (pid=${lock.holder.pid}, ` +
          `since ${lock.holder.startedAt}, port=${lock.holder.port}).`,
      ),
    )
    console.error(
      colors.white(
        `   Stop it with \`slv gateway stop\` (Phase 1B) or \`kill ${lock.holder.pid}\`.`,
      ),
    )
    return EX_TEMPFAIL
  }
  if (lock.state === 'failed') {
    console.error(colors.red(`❌ failed to acquire gateway lock: ${lock.err}`))
    return EX_UNAVAILABLE
  }

  // Signal handlers MUST be in place before we spend time binding the
  // HTTP listener — otherwise a SIGTERM during the bind window would
  // hit Deno's default handler and exit without releasing the pidfile,
  // stranding the lock. The `serverRef` box lets the handler observe
  // whether the listener is live yet.
  const serverRef: {
    server:
      | { shutdown: () => Promise<void>; finished: Promise<void> }
      | null
  } = { server: null }
  let shuttingDown = false
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(colors.yellow(`\n⏸  received ${signal}, shutting down...`))
    // If the listener isn't up yet, release the lock directly. The
    // main flow's bind attempt will see `shuttingDown` via the server
    // ref and bail.
    if (serverRef.server === null) {
      releaseGatewayLock()
        .catch(() => {})
        .finally(() => Deno.exit(0))
      return
    }
    // Listener is up — tell it to stop accepting. `finished` will
    // resolve, the main flow reaches the releaseGatewayLock + return 0
    // path naturally, and the process exits via program.parse
    // settling.
    serverRef.server.shutdown().catch(() => {})
  }
  // Capture the bound callbacks so we can remove them on clean exit —
  // matters if this function is ever called twice in one process
  // (hot reload, integration test harness) where leaked listeners
  // would race `Deno.exit(0)`.
  const sigtermHandler = () => gracefulShutdown('SIGTERM')
  const sigintHandler = () => gracefulShutdown('SIGINT')
  Deno.addSignalListener('SIGTERM', sigtermHandler)
  Deno.addSignalListener('SIGINT', sigintHandler)
  const removeSignalHandlers = () => {
    try {
      Deno.removeSignalListener('SIGTERM', sigtermHandler)
      Deno.removeSignalListener('SIGINT', sigintHandler)
    } catch { /* already removed / process exiting */ }
  }

  if (shuttingDown) {
    // A signal fired between addSignalListener calls and here.
    // Release the lock and bail cleanly.
    removeSignalHandlers()
    await releaseGatewayLock()
    return 0
  }

  const app = new Hono()
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      pid: Deno.pid,
      port: config.port,
      startedAt: lock.record.startedAt,
    }))
  app.get('/', (c) =>
    c.json({
      service: GATEWAY_SERVICE_ID,
      version: GATEWAY_PROTOCOL_VERSION,
      ws: '/v1/session/ws',
    }))

  // WebSocket endpoint: `/v1/session/ws`. Clients authenticate
  // first-message via the token in ~/.slv/gateway/gateway.json.
  registerWsRoutes(app, { token: config.token })

  // Browser chat demo at /ui/. In `local` mode the gateway only
  // binds loopback so the HTML can safely inline the token for
  // convenience. In `lan` mode, the HTML is served without the
  // token inlined — the client-side JS reads it from localStorage
  // or prompts the user to paste it once. Heuristic for "is this
  // request from loopback": Host header names `127.0.0.1` /
  // `localhost`. Not bulletproof against a forged Host header,
  // but an attacker with network access to the bound port can
  // already try every other endpoint anyway.
  const uiHandler = async (c: Context) => {
    try {
      return c.html(
        await renderChatHtml({
          token: isLoopbackHost(c.req.header('host')) ? config.token : null,
          mode: config.mode,
        }),
      )
    } catch (err) {
      console.error(colors.red(`/ui/ render failed: ${errToString(err)}`))
      return c.text(
        'SLV gateway: /ui/ is temporarily unavailable. Check the gateway logs.',
        500,
      )
    }
  }
  app.get('/ui', uiHandler)
  app.get('/ui/', uiHandler)

  // Bind loopback explicitly. Deno.serve defaults to 0.0.0.0 — a
  // serious footgun for a process that executes shell tools.
  try {
    serverRef.server = Deno.serve(
      { port: config.port, hostname: hostnameForMode(config.mode) },
      app.fetch,
    )
  } catch (err) {
    removeSignalHandlers()
    await releaseGatewayLock()
    console.error(
      colors.red(
        `❌ failed to bind 127.0.0.1:${config.port}: ${errToString(err)}`,
      ),
    )
    return EX_TEMPFAIL
  }

  const bindHost = hostnameForMode(config.mode)
  const displayHost = config.mode === 'lan' ? '<this-host-ip>' : '127.0.0.1'
  console.log(
    colors.green(
      `✅ slv gateway running on http://${displayHost}:${config.port} (pid=${Deno.pid}, mode=${config.mode})`,
    ),
  )
  if (config.mode === 'lan') {
    console.log(
      colors.yellow(
        `   ⚠️  lan mode: bound to ${bindHost} — token auth still required`,
      ),
    )
  }
  console.log(colors.gray(`   config:  ${gatewayConfigPath}`))
  console.log(colors.gray(`   pidfile: ${gatewayPidPath}`))
  console.log(
    colors.gray(`   healthz: curl http://127.0.0.1:${config.port}/healthz`),
  )

  await serverRef.server.finished
  removeSignalHandlers()
  await releaseGatewayLock()
  console.log(colors.green('✅ gateway stopped'))
  return 0
}

/**
 * Load the persisted config with focused error reporting:
 * - Bad `SLV_GATEWAY_PORT` → targeted env-var message (don't blame
 *   the file the user didn't touch).
 * - Anything else → EX_CONFIG pointing at the real config file.
 */
const loadConfigOrFail = async (): Promise<
  Awaited<ReturnType<typeof ensureGatewayConfig>> | number
> => {
  try {
    return await ensureGatewayConfig()
  } catch (err) {
    if (err instanceof GatewayEnvPortError) {
      console.error(colors.red(`❌ ${err.message}`))
      return EX_CONFIG
    }
    console.error(
      colors.red(`❌ gateway config is invalid: ${errToString(err)}`),
    )
    console.error(
      colors.white(`   Fix or delete ${gatewayConfigPath} and retry.`),
    )
    return EX_CONFIG
  }
}
