import { dirname, join } from '@std/path'
import { localExec } from '/src/bot/execUtil.ts'
import type {
  GatewayService,
  InstallOptions,
  ServiceStatus,
} from '/src/gateway/service/service.ts'

export const SYSTEMD_UNIT_NAME = 'slv-gateway.service'
// Watchdog units — catch the case where slv-gateway.service was
// explicitly stopped (e.g. `slv upgrade` stopped the unit then
// hung before restarting it). `Restart=always` only covers CRASHES,
// not clean `systemctl stop` requests, so the gateway can stay
// dark indefinitely without this.
export const HEAL_UNIT_NAME = 'slv-gateway-heal.service'
export const HEAL_TIMER_NAME = 'slv-gateway-heal.timer'

const userUnitDir = (): string => {
  const home = Deno.env.get('HOME') ?? '.'
  const xdg = Deno.env.get('XDG_CONFIG_HOME')
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.config')
  return join(base, 'systemd/user')
}

export const systemdUnitPath = (): string =>
  join(userUnitDir(), SYSTEMD_UNIT_NAME)
const healServicePath = (): string => join(userUnitDir(), HEAL_UNIT_NAME)
const healTimerPath = (): string => join(userUnitDir(), HEAL_TIMER_NAME)

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

// Oneshot healer: if slv-gateway.service is not active, try to
// start it. Idempotent — a no-op when the gateway is already
// running, so the timer can fire safely. Users who WANT the
// gateway to stay down (maintenance) can `systemctl --user stop
// slv-gateway-heal.timer` as well.
const renderHealerService = (): string => `[Unit]
Description=SLV Gateway watchdog — restart slv-gateway if it's down
After=slv-gateway.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'systemctl --user is-active --quiet slv-gateway.service || systemctl --user start slv-gateway.service'
`

// Timer: fire 30s after boot, then every 2 minutes. Short enough
// that a 6-minute outage like the one we hit tops out at ~2 min,
// long enough that we don't thrash systemd or log-spam.
const renderHealerTimer = (): string => `[Unit]
Description=Periodic check + restart for slv-gateway

[Timer]
OnBootSec=30s
OnUnitActiveSec=2min
Unit=${HEAL_UNIT_NAME}

[Install]
WantedBy=timers.target
`

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
    await Deno.writeTextFile(healServicePath(), renderHealerService())
    await Deno.writeTextFile(healTimerPath(), renderHealerTimer())
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
    // Enable+start the watchdog timer. Failure here is non-fatal —
    // the main service is already enabled; we don't want the whole
    // install to roll back because the optional healer didn't take.
    const timerEnable = await systemctl('enable', '--now', HEAL_TIMER_NAME)
    if (!timerEnable.success) {
      console.warn(
        `  ⚠ watchdog timer (${HEAL_TIMER_NAME}) could not be enabled: ${
          timerEnable.stderr.trim() || 'unknown'
        }`,
      )
    }
  }

  async uninstall(): Promise<void> {
    // Best-effort stop+disable; ignore "not loaded" errors so
    // uninstall is idempotent.
    await systemctl('disable', '--now', HEAL_TIMER_NAME)
    await Deno.remove(healTimerPath()).catch(() => {})
    await Deno.remove(healServicePath()).catch(() => {})
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
