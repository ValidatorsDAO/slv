import { Command } from '@cliffy'
import { runGatewayForeground } from '/src/gateway/runForeground.ts'
import { GATEWAY_DEFAULT_PORT } from '/src/gateway/paths.ts'
import { installAction, uninstallAction } from '/src/gateway/install.ts'
import { runLifecycle } from '/src/gateway/lifecycle.ts'
import { statusAction } from '/src/gateway/status.ts'
import { logsAction } from '/src/gateway/logs.ts'
import { pingAction } from '/src/gateway/ping.ts'
import { openUiAction } from '/src/gateway/ui/open.ts'
import { setModeAction, showConfigAction } from '/src/gateway/config_cmd.ts'

export const gatewayCmd = new Command()
  .description(
    `🌐 SLV Gateway — WebSocket daemon for the AI console and future web UI.

Runs a loopback HTTP/WS server on 127.0.0.1:${GATEWAY_DEFAULT_PORT} (override with
SLV_GATEWAY_PORT). Every UI adapter (TUI, future web UI) speaks the same
token-authed protocol against this single gateway instance.`,
  )
  .action(() => {
    gatewayCmd.showHelp()
  })

gatewayCmd.command('run')
  .description(
    'Run the gateway in the foreground (for manual testing or as the service ExecStart)',
  )
  .action(async () => {
    const code = await runGatewayForeground()
    if (code !== 0) Deno.exit(code)
  })

gatewayCmd.command('install')
  .description(
    'Install the gateway as a user-level launchd (macOS) or systemd --user (Linux) service',
  )
  .action(async () => {
    const ok = await installAction()
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('uninstall')
  .description('Remove the user-level service unit/plist (idempotent)')
  .action(async () => {
    const ok = await uninstallAction()
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('start')
  .description('Start the installed gateway service')
  .action(async () => {
    const ok = await runLifecycle('start')
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('stop')
  .description('Stop the installed gateway service')
  .action(async () => {
    const ok = await runLifecycle('stop')
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('restart')
  .description('Restart the installed gateway service')
  .action(async () => {
    const ok = await runLifecycle('restart')
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('status')
  .description(
    'Show gateway service state, pidfile, config, and log paths',
  )
  .action(async () => {
    const ok = await statusAction()
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('logs')
  .description('Tail the gateway stdout + stderr log files')
  .option('-f, --follow', 'Follow the log (like `tail -F`)', { default: false })
  .option('-n, --lines <lines:number>', 'Number of lines to show', {
    default: 100,
  })
  .action(async (opts: { follow?: boolean; lines?: number }) => {
    const ok = await logsAction(opts)
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('ping')
  .description(
    'Connect to the local gateway and run the hello → auth → ping handshake',
  )
  .action(async () => {
    const ok = await pingAction()
    if (!ok) Deno.exit(1)
  })

gatewayCmd.command('ui')
  .description('Open the browser chat UI at http://127.0.0.1:<port>/ui/')
  .action(async () => {
    const ok = await openUiAction()
    if (!ok) Deno.exit(1)
  })

const configCmd = new Command()
  .description(
    'Inspect and modify gateway.json (mode, etc.)',
  )
  .action(() => {
    configCmd.showHelp()
  })
configCmd.command('show', 'Show the current gateway config')
  .action(async () => {
    const ok = await showConfigAction()
    if (!ok) Deno.exit(1)
  })
configCmd.command('set-mode', 'Change bind mode (local → loopback, lan → 0.0.0.0)')
  .arguments('<mode:string>')
  .option('-y, --yes', 'Skip the lan-mode safety confirmation', { default: false })
  .action(async (opts: { yes?: boolean }, mode: string) => {
    const ok = await setModeAction(mode, opts)
    if (!ok) Deno.exit(1)
  })
gatewayCmd.command('config', configCmd)
