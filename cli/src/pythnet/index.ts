import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { deployPythnetMainnet } from '@/pythnet/deploy/deployPythnetMainnet.ts'

// `slv pythnet` — manage a self-hosted Pythnet RPC node (Pyth's
// application-specific Solana 1.14 fork).  Only mainnet exists — Pythnet
// is a single production chain operated by Pyth's data providers.
export const pythnetCmd = new Command()
  .description('🔮 Manage Self-hosted Pythnet RPC Node 🔮')
  .action(() => {
    pythnetCmd.showHelp()
  })

pythnetCmd.command('deploy')
  .description('📦 Deploy a Pythnet RPC node')
  .option('-p, --pubkey <pubkey>', 'Limit to specific host')
  .action(async (options) => {
    await deployPythnetMainnet(options.pubkey)
  })

const lifecycle = (
  name: 'start' | 'stop' | 'restart' | 'update',
  emoji: string,
  description: string,
  playbookFile: string,
  successMessage: string,
) => {
  pythnetCmd.command(name)
    .description(`${emoji} ${description}`)
    .option('-p, --pubkey <pubkey>', 'Limit to specific host')
    .action(async (options) => {
      const templateRoot = getTemplatePath()
      const playbook = `${templateRoot}/ansible/mainnet-pythnet/${playbookFile}`
      const result = options.pubkey
        ? await runAnsilbe(playbook, 'mainnet_pythnet', options.pubkey)
        : await runAnsilbe(playbook, 'mainnet_pythnet')
      if (result) {
        console.log(colors.white(`✅ ${successMessage}`))
      }
    })
}

lifecycle('start', '🟢', 'Start Pythnet validator', 'start_node.yml', 'Started Pythnet')
lifecycle('stop', '🔴', 'Stop Pythnet validator', 'stop_node.yml', 'Stopped Pythnet')
lifecycle('restart', '♻️', 'Restart Pythnet validator', 'restart_node.yml', 'Restarted Pythnet')
lifecycle('update', '🔄', 'Pull pythnet_ref + rebuild + restart', 'update_pythnet.yml', 'Updated Pythnet')

// `firewall` calls the shared cmn/deploy_nftables.yml against the
// mainnet_pythnet inventory.  Pythnet's typical setup needs gossip
// (8001) + dynamic TPU range (8000-8020) public, JSON-RPC (8899/8900)
// restricted to known clients (typically the Hermes VPS).
pythnetCmd.command('firewall')
  .description('🛡️ Apply nftables ruleset to Pythnet RPC hosts')
  .option('-p, --pubkey <pubkey>', 'Limit to specific host')
  .action(async (options) => {
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/cmn/deploy_nftables.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, 'mainnet_pythnet', options.pubkey)
      : await runAnsilbe(playbook, 'mainnet_pythnet')
    if (result) {
      console.log(colors.white('✅ Applied nftables to Pythnet hosts'))
    }
  })
