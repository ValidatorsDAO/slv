import { dirname, join } from '@std/path'
import { localExec } from '/src/bot/execUtil.ts'
import type {
  GatewayService,
  InstallOptions,
  ServiceStatus,
} from '/src/gateway/service/service.ts'

export const LAUNCHD_LABEL = 'global.slv.gateway'

const launchAgentDir = (): string =>
  join(Deno.env.get('HOME') ?? '.', 'Library/LaunchAgents')

export const launchdPlistPath = (): string =>
  join(launchAgentDir(), `${LAUNCHD_LABEL}.plist`)

/**
 * Render the LaunchAgent plist. Notes:
 *
 * - `RunAtLoad=true` + `KeepAlive=true` — launchd starts us at user
 *   login and respawns on exit.
 * - `ThrottleInterval=5` + `ExitTimeOut=30` — if we crash fast,
 *   launchd waits 5s before respawning. If we ignore SIGTERM for
 *   30s, launchd sends SIGKILL.
 * - `StandardOutPath` / `StandardErrorPath` — direct stdio to the
 *   log files `slv gateway logs` tails.
 * - We purposely DON'T ship a `UserName` key: this is a
 *   LaunchAgent (per-user), not a LaunchDaemon. The invoking user
 *   owns the process; no root required.
 */
export const renderLaunchdPlist = (opts: InstallOptions): string => {
  const args = [opts.execPath, ...opts.execArgs].map(xmlEscape)
  const argLines = args.map((a) => `    <string>${a}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrLog)}</string>
</dict>
</plist>
`
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const userGuiTarget = async (): Promise<string> => {
  // bootstrap/bootout/kickstart all need a domain target. `gui/<uid>`
  // is the modern per-user GUI domain launchd uses for LaunchAgents.
  const out = await localExec('id', ['-u'])
  const uid = out.stdout.trim()
  return `gui/${uid}`
}

const launchctl = async (
  ...args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> => {
  const out = await localExec('launchctl', args)
  return { success: out.success, stdout: out.stdout, stderr: out.stderr }
}

export class LaunchdService implements GatewayService {
  readonly name = 'launchd'

  async install(opts: InstallOptions): Promise<void> {
    const path = launchdPlistPath()
    await Deno.mkdir(dirname(path), { recursive: true })
    await Deno.writeTextFile(path, renderLaunchdPlist(opts))

    // `bootstrap` is the modern launchctl verb; `load -w` is the
    // deprecated but still common alternative. We try bootstrap
    // first and fall back to load for older macOS.
    const target = await userGuiTarget()
    const bootstrap = await launchctl('bootstrap', target, path)
    if (!bootstrap.success) {
      // If the unit is already loaded, bootstrap returns non-zero
      // with stderr containing 'service already loaded' — harmless
      // idempotent path.
      const already = /already loaded|already bootstrapped/i.test(
        bootstrap.stderr,
      )
      if (!already) {
        const load = await launchctl('load', '-w', path)
        if (!load.success) {
          throw new Error(
            `launchctl bootstrap/load failed: ${
              bootstrap.stderr.trim() || load.stderr.trim() || 'unknown'
            }`,
          )
        }
      }
    }
    // Ensure enabled (bootstrap sets this automatically on recent
    // launchctl; belt-and-suspenders for older versions).
    await launchctl('enable', `${target}/${LAUNCHD_LABEL}`)
  }

  async uninstall(): Promise<void> {
    const target = await userGuiTarget()
    // Best-effort disable + bootout; ignore errors for idempotency.
    await launchctl('bootout', `${target}/${LAUNCHD_LABEL}`)
    await launchctl('unload', '-w', launchdPlistPath())
    await Deno.remove(launchdPlistPath()).catch(() => {})
  }

  async start(): Promise<void> {
    const target = await userGuiTarget()
    // kickstart is idempotent — starts if not running, no-op if it is.
    const r = await launchctl('kickstart', `${target}/${LAUNCHD_LABEL}`)
    if (!r.success) {
      throw new Error(`launchctl kickstart failed: ${r.stderr.trim()}`)
    }
  }

  async stop(): Promise<void> {
    const target = await userGuiTarget()
    const r = await launchctl('kill', 'SIGTERM', `${target}/${LAUNCHD_LABEL}`)
    if (!r.success) {
      throw new Error(`launchctl kill failed: ${r.stderr.trim()}`)
    }
  }

  async restart(): Promise<void> {
    const target = await userGuiTarget()
    // `kickstart -k` restarts by killing + relaunching.
    const r = await launchctl(
      'kickstart',
      '-k',
      `${target}/${LAUNCHD_LABEL}`,
    )
    if (!r.success) {
      throw new Error(`launchctl kickstart -k failed: ${r.stderr.trim()}`)
    }
  }

  async status(): Promise<ServiceStatus> {
    const loaded = await Deno.stat(launchdPlistPath()).then(() => true)
      .catch(() => false)
    const target = await userGuiTarget()
    const print = await launchctl('print', `${target}/${LAUNCHD_LABEL}`)
    // `launchctl print` exits 113 when the service isn't loaded, 0 when
    // it is. stdout shows `state = running | spawning | not running`.
    const running = /\bstate = running\b/.test(print.stdout)
    return {
      loaded,
      running,
      details: print.stdout || print.stderr,
    }
  }
}
