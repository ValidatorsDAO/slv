import { colors } from '@cliffy/colors'
import { Hono } from '@hono/hono'
import { loadOrInitGatewayConfig } from '/src/gateway/config.ts'
import {
  acquireGatewayLock,
  releaseGatewayLock,
} from '/src/gateway/lock.ts'
import { gatewayConfigPath, gatewayPidPath } from '/src/gateway/paths.ts'

// Exit codes align with sysexits.h so a future systemd unit can set
// RestartPreventExitStatus=78 to avoid crash-looping on a bad config.
const EX_CONFIG = 78
const EX_TEMPFAIL = 75
const EX_UNAVAILABLE = 69

type RunOptions = {
  force?: boolean // future: --force to evict a live holder
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
export const runGatewayForeground = async (
  _options: RunOptions = {},
): Promise<number> => {
  let config
  try {
    config = await loadOrInitGatewayConfig()
  } catch (err) {
    console.error(
      colors.red(
        `❌ gateway config is invalid: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    )
    console.error(
      colors.white(`   Fix or delete ${gatewayConfigPath()} and retry.`),
    )
    return EX_CONFIG
  }

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

  const app = new Hono()
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      pid: Deno.pid,
      port: config.port,
      startedAt: lock.record.startedAt,
    }))

  // Root endpoint returns a stub so clients probing the port can tell
  // this is an slv gateway (not some other service that happens to
  // share 18789).
  app.get('/', (c) =>
    c.json({
      service: 'slv-gateway',
      version: '1',
      note: 'WS endpoints arrive in Phase 1B',
    }))

  // Start listening on loopback explicitly. Deno.serve defaults to
  // 0.0.0.0 — which would be a serious security footgun for a process
  // that executes shell tools on the host.
  let server: { shutdown: () => Promise<void>; finished: Promise<void> }
  try {
    server = Deno.serve(
      { port: config.port, hostname: '127.0.0.1' },
      app.fetch,
    )
  } catch (err) {
    await releaseGatewayLock()
    // EADDRINUSE at the OS level — pidfile didn't know about whoever
    // owns the port. Rare but possible (someone started a non-slv
    // server on 18789). Surface clearly.
    console.error(
      colors.red(
        `❌ failed to bind 127.0.0.1:${config.port}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    )
    return EX_TEMPFAIL
  }

  console.log(
    colors.green(
      `✅ slv gateway running on http://127.0.0.1:${config.port} (pid=${Deno.pid})`,
    ),
  )
  console.log(colors.gray(`   config:  ${gatewayConfigPath()}`))
  console.log(colors.gray(`   pidfile: ${gatewayPidPath()}`))
  console.log(colors.gray(`   healthz: curl http://127.0.0.1:${config.port}/healthz`))

  // Graceful shutdown. We listen for both SIGTERM (service managers)
  // and SIGINT (Ctrl+C in foreground). Either signal stops the HTTP
  // listener, waits for the `finished` promise to settle, removes the
  // pidfile, and exits 0. If the signal fires twice, the second one
  // hits the Deno default handler which is an immediate exit.
  let shuttingDown = false
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(
      colors.yellow(`\n⏸  received ${signal}, shutting down...`),
    )
    try {
      await server.shutdown()
    } catch { /* ignore */ }
    await releaseGatewayLock()
    console.log(colors.green('✅ gateway stopped'))
    Deno.exit(0)
  }
  Deno.addSignalListener('SIGTERM', () => void gracefulShutdown('SIGTERM'))
  Deno.addSignalListener('SIGINT', () => void gracefulShutdown('SIGINT'))

  await server.finished
  await releaseGatewayLock()
  return 0
}
