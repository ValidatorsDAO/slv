import { Command } from '@cliffy'
import { runGatewayForeground } from '/src/gateway/runForeground.ts'
import { GATEWAY_DEFAULT_PORT } from '/src/gateway/paths.ts'

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
    'Run the gateway in the foreground (for manual testing or as the systemd ExecStart)',
  )
  .action(async () => {
    const code = await runGatewayForeground()
    if (code !== 0) Deno.exit(code)
  })
