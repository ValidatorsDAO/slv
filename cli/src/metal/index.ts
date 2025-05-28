import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { listAction } from '@/metal/list/listAction.ts'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { statusAction } from '/src/metal/status/statusAction.ts'
import { cancelAction } from '/src/metal/cancel/cancelAction.ts'
// metal Command
const text = `🚀 SLV BareMetal: High-Performance Servers Built for Solana Nodes

📖 Steps After Payment Completion

1. Once your payment is complete, you’ll be able to view your Bare Metal resources by running the following command:
   $ slv metal status

2. Displaying Login Information  
   Once the status becomes "on", you can view your login details by running:
   $ slv metal status
   And select the Bare Metal resource you want to access.

3. If Login Information Doesn’t Appear  
   If the login details don’t show up after some time, please reach out via a support ticket on Discord.
   ValidatorsDAO Discord: ${DISCORD_LINK}

= BareMetal Status =
⚙️ provisioning - In progress
🟢 on - Available
🔴 off - Unavailable
🛠️ maintenance - Under maintenance
⏸️ suspended - Suspended
`

export const metalCmd = new Command()
  .description(
    colors.white(text),
  )
  .action(function () {
    this.showHelp()
    return
  })
  .command('list', 'List   - 🛡️  Solana Compatible BareMetal Resources')
  .action(async () => {
    await listAction()
    return
  })
  .command('status', 'Status - 🏠 My Bare Metal Resource Status')
  .action(async () => {
    await statusAction()
    return
  })
  .command('rebuild', 'Rebuild - 🏭 Rebuild OS')
  .action(() => {
    console.log(colors.yellow('coming soon...'))
    return
  })
  .command('cancel', 'Cancel - 🙅‍♀️ Cancel Subscription')
  .action(async () => {
    await cancelAction()
    return
  })
  .command('support', 'Support - 💬 Contact Support via Discord')
  .action(() => {
    console.log('coming soon...')
    return
  })
