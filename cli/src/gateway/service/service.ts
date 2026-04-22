/**
 * Platform-agnostic service backend contract for the gateway daemon.
 *
 * Two implementations: `launchd.ts` (macOS LaunchAgent) and
 * `systemd.ts` (Linux `systemctl --user`). Pick the right one at
 * runtime via `pick.ts`. Every gateway lifecycle subcommand
 * (`install / uninstall / start / stop / restart / status`) goes
 * through this interface, so the CLI handlers stay identical across
 * OSes.
 */

export type ServiceStatus = {
  // True if the OS service manager knows about our unit (installed +
  // enabled). False if never installed or cleanly uninstalled.
  loaded: boolean
  // True if the service manager believes the process is currently
  // running. Note: a pid-alive check via gateway.pid is a more
  // authoritative runtime-state signal — the service manager may
  // think it's running just because it's supposed to auto-restart.
  running: boolean
  // Extra platform-specific lines to show in `slv gateway status`.
  // E.g. `launchctl print` output or `systemctl --user status` tail.
  details: string
}

export type InstallOptions = {
  // Absolute path to the slv binary. Required so the service unit
  // can ExecStart it without depending on $PATH (systemd unit files
  // don't inherit the user's PATH; launchd plists don't either).
  execPath: string
  // Arguments to pass: typically ['gateway', 'run'].
  execArgs: string[]
  // Destinations for stdout / stderr. Service managers redirect our
  // streams here; `slv gateway logs` tails them.
  stdoutLog: string
  stderrLog: string
}

export interface GatewayService {
  /** Human-readable backend label, e.g. 'launchd' or 'systemd --user'. */
  readonly name: string

  /** Write the unit/plist file + register with the service manager. */
  install(opts: InstallOptions): Promise<void>

  /** Remove the unit/plist file + deregister. Safe when not installed. */
  uninstall(): Promise<void>

  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>

  status(): Promise<ServiceStatus>
}
