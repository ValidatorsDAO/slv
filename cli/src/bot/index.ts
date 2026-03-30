import { Command } from '@cliffy'
import { initBotTemplate } from '/src/bot/init/initBotTemplate.ts'

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
  .action(async (options: { queue: boolean }) => {
    console.log('Initializing the bot...')
    await initBotTemplate(options)
  })
