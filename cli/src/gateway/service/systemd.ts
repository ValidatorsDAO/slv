import { dirname, join } from '@std/path'
import { localExec } from '/src/bot/execUtil.ts'
import type {
  GatewayService,
  InstallOptions,
  ServiceStatus,
} from '/src/gateway/service/service.ts'

export const SYSTEMD_UNIT_NAME = 'slv-gateway.service'

const userUnitDir = (): string => {
  const home = Deno.env.get('HOME') ?? '.'
  const xdg = Deno.env.get('XDG_CONFIG_HOME')
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.config')
  return join(base, 'systemd/user')
}

export const systemdUnitPath = (): string =>
  join(userUnitDir(), SYSTEMD_UNIT_NAME)

/**
 * Render the systemd --user unit. Notes on choices:
 *
 * - `Restart=always` + `RestartPreventExitStatus=78` — restart on
 *   any exit EXCEPT `EX_CONFIG` (78), so a misconfigured gateway
 *   doesn't crash-loop until the user intervenes.
 * - `KillMode=control-group` — so when the user-level systemd kills
 *   us, any tool-call shell children we've spawned also get SIGTERM.
 *   Important because the gateway can execute arbitrary commands.
 * - `StandardOutput=append:` / `StandardError=append:` — stream our
 *   stdio directly to the log files `slv gateway logs` tails.
 *   Requires systemd 240+ (Ubuntu 20.04+). On older systemd this
 *   fails at daemon-reload and we fall back to journald via the
 *   error path.
 * - `WantedBy=default.target` — user-target so it starts on user
 *   login. Does NOT require system-level sudo; everything is
 *   scoped to the invoking user.
 */
export const renderSystemdUnit = (opts: InstallOptions): string => {
  const argv = [opts.execPath, ...opts.execArgs].map(shellQuote).join(' ')
  return `[Unit]
Description=SLV Gateway WebSocket daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${argv}
Restart=always
RestartSec=5
RestartPreventExitStatus=78
KillMode=control-group
TimeoutStopSec=30
StandardOutput=append:${opts.stdoutLog}
StandardError=append:${opts.stderrLog}

[Install]
WantedBy=default.target
`
}

// Minimal shell quoter for unit files. Systemd's ExecStart tokenizer
// is shell-like but not a full shell, so we wrap each arg in double
// quotes and escape `"` + `\` + `$`. No path we generate contains
// these characters today, but defend against future callers.
const shellQuote = (s: string): string => {
  if (/^[A-Za-z0-9_\-./@:=+]+$/.test(s)) return s
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(
    /\$/g,
    '\\$',
  ) + '"'
}

const systemctl = async (
  ...args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> => {
  const out = await localExec('systemctl', ['--user', ...args])
  return { success: out.success, stdout: out.stdout, stderr: out.stderr }
}

export class SystemdUserService implements GatewayService {
  readonly name = 'systemd --user'

  async install(opts: InstallOptions): Promise<void> {
    const path = systemdUnitPath()
    await Deno.mkdir(dirname(path), { recursive: true })
    await Deno.writeTextFile(path, renderSystemdUnit(opts))
    const reload = await systemctl('daemon-reload')
    if (!reload.success) {
      throw new Error(
        `systemctl --user daemon-reload failed: ${
          reload.stderr.trim() || 'unknown'
        }`,
      )
    }
    const enable = await systemctl('enable', SYSTEMD_UNIT_NAME)
    if (!enable.success) {
      throw new Error(
        `systemctl --user enable ${SYSTEMD_UNIT_NAME} failed: ${
          enable.stderr.trim() || 'unknown'
        }`,
      )
    }
  }

  async uninstall(): Promise<void> {
    // Best-effort stop+disable; ignore "not loaded" errors so
    // uninstall is idempotent.
    await systemctl('disable', '--now', SYSTEMD_UNIT_NAME)
    await Deno.remove(systemdUnitPath()).catch(() => {})
    await systemctl('daemon-reload')
  }

  async start(): Promise<void> {
    const r = await systemctl('start', SYSTEMD_UNIT_NAME)
    if (!r.success) {
      throw new Error(`systemctl start failed: ${r.stderr.trim()}`)
    }
  }

  async stop(): Promise<void> {
    const r = await systemctl('stop', SYSTEMD_UNIT_NAME)
    if (!r.success) {
      throw new Error(`systemctl stop failed: ${r.stderr.trim()}`)
    }
  }

  async restart(): Promise<void> {
    const r = await systemctl('restart', SYSTEMD_UNIT_NAME)
    if (!r.success) {
      throw new Error(`systemctl restart failed: ${r.stderr.trim()}`)
    }
  }

  async status(): Promise<ServiceStatus> {
    const loaded = await Deno.stat(systemdUnitPath()).then(() => true)
      .catch(() => false)
    const active = await systemctl('is-active', SYSTEMD_UNIT_NAME)
    // is-active exits 0 if active, 3 if inactive, 4 if no such unit.
    const running = active.stdout.trim() === 'active'
    const details = await systemctl('status', SYSTEMD_UNIT_NAME, '--no-pager')
    return {
      loaded,
      running,
      details: details.stdout || details.stderr,
    }
  }
}
