import { colors } from '@cliffy/colors'
import {
  ensureGatewayConfig,
  type GatewayConfig,
} from '/src/gateway/config.ts'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { installAction } from '/src/gateway/install.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Make sure the local gateway daemon is up, starting it if needed.
 *
 * This is the "zero-config" entry point for any feature that needs
 * the gateway — `slv c --via-gateway` today, future web UI launcher
 * tomorrow. The chat is aimed at non-engineer users: they shouldn't
 * need to know the daemon exists or understand the lifecycle
 * commands. If it's not running, we just start it; if it's not
 * installed, we install it first (as a per-user launchd/systemd
 * service — no sudo needed).
 *
 * All user-visible messages avoid jargon. "systemd-user-unit" is a
 * detail; "background service" is what lands.
 */
export type EnsureOutcome = {
  ok: true
  config: GatewayConfig
  // True if this call started/installed the daemon (not merely
  // confirmed it was already running). Callers can use this to
  // show a one-time welcome message on the initial bootstrap.
  bootstrapped: boolean
} | { ok: false; reason: string }

const probeHealthy = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1000),
    })
    const ok = res.ok
    await res.body?.cancel()
    return ok
  } catch {
    return false
  }
}

const waitHealthy = async (
  port: number,
  timeoutMs = 10_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeHealthy(port)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

export const ensureGatewayRunning = async (
  opts: { quiet?: boolean } = {},
): Promise<EnsureOutcome> => {
  const say = (msg: string) => {
    if (!opts.quiet) console.log(msg)
  }

  let config: GatewayConfig
  try {
    config = await ensureGatewayConfig()
  } catch (err) {
    return {
      ok: false,
      reason: `couldn't read gateway config: ${errToString(err)}`,
    }
  }

  // Happy path: already running. Most of the time this is what
  // happens after the first launch.
  if (await probeHealthy(config.port)) {
    return { ok: true, config, bootstrapped: false }
  }

  // Not running. Pick the right service backend for the OS.
  let service
  try {
    service = pickGatewayService()
  } catch (err) {
    return {
      ok: false,
      reason:
        `automatic background service setup isn't supported on this platform. ` +
        `${errToString(err)}`,
    }
  }

  // Install if missing. The installAction handles all the
  // plumbing (log files, plist/unit generation, enable) and is
  // idempotent.
  const status = await service.status().catch(() => ({
    loaded: false,
    running: false,
    details: '',
  }))
  let bootstrapped = false
  if (!status.loaded) {
    say(
      colors.cyan(
        '🔧 First-time setup: registering the SLV background service...',
      ),
    )
    bootstrapped = true
    const installed = await installAction()
    if (!installed) {
      return {
        ok: false,
        reason: 'background service install failed (see messages above)',
      }
    }
  }

  // Start it if not already up.
  if (!(await probeHealthy(config.port))) {
    say(colors.cyan('🚀 Starting the SLV background service...'))
    try {
      await service.start()
    } catch (err) {
      return {
        ok: false,
        reason: `couldn't start the background service: ${errToString(err)}`,
      }
    }
  }

  // Wait for the daemon to actually accept connections. On cold
  // start this can take a second or two while the port binds.
  if (!(await waitHealthy(config.port))) {
    return {
      ok: false,
      reason:
        `the background service started but isn't responding on port ${config.port} yet`,
    }
  }

  return { ok: true, config, bootstrapped }
}
