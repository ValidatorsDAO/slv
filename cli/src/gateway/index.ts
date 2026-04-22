import { Command } from '@cliffy'
import { runGatewayForeground } from '/src/gateway/runForeground.ts'

/**
 * `slv gateway` — WebSocket gateway daemon for the SLV AI stack.
 *
 * Phase 1A (this PR): `run` (foreground) only.
 * Phase 1B: `install` / `start` / `stop` / `restart` / `status` via
 *           launchd (macOS) or systemd --user (Linux).
 * Phase 2:  WS upgrade + session core + event protocol.
 */
export const gatewayCmd = new Command()
  .description(
    `🌐 SLV Gateway — WebSocket daemon for the AI console and future web UI.

Runs a loopback HTTP/WS server on 127.0.0.1:18789 (default) with a
token-authed protocol shared by every UI adapter. Phase 1A ships the
foreground runner only.`,
  )
  .action(() => {
    gatewayCmd.showHelp()
  })

gatewayCmd.command('run')
  .description(
    'Run the gateway in the foreground (for manual testing or as systemd ExecStart)',
  )
  .action(async () => {
    const code = await runGatewayForeground()
    if (code !== 0) Deno.exit(code)
  })
