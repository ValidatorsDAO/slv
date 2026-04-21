import { Command } from '@cliffy'
import { initBotTemplate } from '/src/bot/init/initBotTemplate.ts'
import { deployAction } from '/src/bot/deploy/deployAction.ts'
import { buildAction } from '/src/bot/build/buildAction.ts'
import { startAction } from '/src/bot/start/startAction.ts'
import { stopAction } from '/src/bot/stop/stopAction.ts'
import { restartAction } from '/src/bot/restart/restartAction.ts'
import { listAction } from '/src/bot/list/listAction.ts'
import { statusAction } from '/src/bot/status/statusAction.ts'
import { logAction } from '/src/bot/log/logAction.ts'

// bot Command
export const botCmd = new Command()
  .description(`🌪️ Initialize Solana Stream Client Template 🌪️ 

Available Bot Templates:
- 🐦 Shreds Stream Client for Rust
- 🐍 Geyser Stream Client for Typescript
- 🌊 Shreds UDP Stream Client for Rust
`)
  .action(() => {
    botCmd.showHelp()
  })
// bot init subcommand
botCmd.command('init')
  .description('Initialize the bot template')
  .option('-q, --queue', 'Use queue mode', { default: false })
  .option('-t, --template <template:string>', 'Template type (e.g. trade-app)')
  .option('-n, --name <name:string>', 'App name (e.g. solana-trade-bot)')
  .option('-y, --yes', 'Overwrite existing directory without asking', { default: false })
  .action(async (options: { queue: boolean; template?: string; name?: string; yes?: boolean }) => {
    console.log('Initializing the bot...')
    await initBotTemplate(options)
  })

// bot deploy subcommand
botCmd.command('deploy')
  .description('Build and deploy Rust bot binary to remote server via SSH')
  .option('-n, --name <name:string>', 'Bot app name')
  .option('-l, --localhost', 'Deploy to localhost (no SSH required)', {
    default: false,
  })
  .action(async (options: { name?: string; localhost?: boolean }) => {
    await deployAction(options)
  })

// bot build subcommand
botCmd.command('build')
  .description(
    'Build Rust bot binary locally and (on Linux) install a systemd service',
  )
  .option('-n, --name <name:string>', 'Bot app name')
  .option('-p, --path <path:string>', 'Local Rust project path')
  .action(async (options: { name?: string; path?: string }) => {
    // Propagate failure as a non-zero exit so scripts and the AI's
    // run_command can detect it — Cliffy treats a plain `return false` as
    // success.
    const ok = await buildAction(options)
    if (!ok) Deno.exit(1)
  })

// bot start subcommand
botCmd.command('start')
  .description('Start a deployed bot daemon')
  .option('-n, --name <name:string>', 'Bot app name')
  .action(async (options: { name?: string }) => {
    await startAction(options)
  })

// bot stop subcommand
botCmd.command('stop')
  .description('Stop a deployed bot daemon')
  .option('-n, --name <name:string>', 'Bot app name')
  .action(async (options: { name?: string }) => {
    await stopAction(options)
  })

// bot restart subcommand
botCmd.command('restart')
  .description('Restart a deployed bot daemon')
  .option('-n, --name <name:string>', 'Bot app name')
  .action(async (options: { name?: string }) => {
    await restartAction(options)
  })

// bot list subcommand
botCmd.command('list')
  .description('List all deployed bots')
  .action(async () => {
    await listAction()
  })

// bot status subcommand
botCmd.command('status')
  .description('Show systemd service status of a deployed bot')
  .option('-n, --name <name:string>', 'Bot app name')
  .action(async (options: { name?: string }) => {
    await statusAction(options)
  })

// bot log subcommand
botCmd.command('log')
  .description('View journalctl logs of a deployed bot')
  .option('-n, --name <name:string>', 'Bot app name')
  .option('-l, --lines <lines:number>', 'Number of log lines', {
    default: 100,
  })
  .action(async (options: { name?: string; lines?: number }) => {
    await logAction(options)
  })
