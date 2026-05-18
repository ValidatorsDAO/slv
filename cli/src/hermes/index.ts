import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { deployHermesMainnet } from '@/hermes/deploy/deployHermesMainnet.ts'

// `slv hermes` (alias `slv h`) — manage a self-hosted Pyth Hermes API
// stack (nats + beacon + hermes).  Only mainnet is supported because Pyth
// publishes one production Pythnet/Wormhole pair; if/when Pyth ships a
// separate beta network we'd add a --network flag here.
export const hermesCmd = new Command()
  .description('🦤 Manage Self-hosted Pyth Hermes API 🦤')
  .action(() => {
    hermesCmd.showHelp()
  })

hermesCmd.command('deploy')
  .description('📦 Deploy the Hermes stack (nats + beacon + hermes)')
  .option('-p, --pubkey <pubkey>', 'Limit to specific host (inventory key)')
  .action(async (options) => {
    await deployHermesMainnet(options.pubkey)
  })

const lifecycle = (
  name: 'start' | 'stop' | 'restart' | 'update',
  emoji: string,
  description: string,
  playbookFile: string,
  successMessage: string,
) => {
  hermesCmd.command(name)
    .description(`${emoji} ${description}`)
    .option('-p, --pubkey <pubkey>', 'Limit to specific host')
    .action(async (options) => {
      const templateRoot = getTemplatePath()
      const playbook = `${templateRoot}/ansible/mainnet-hermes/${playbookFile}`
      const result = options.pubkey
        ? await runAnsilbe(playbook, 'mainnet_hermes', options.pubkey)
        : await runAnsilbe(playbook, 'mainnet_hermes')
      if (result) {
        console.log(colors.white(`✅ ${successMessage}`))
      }
    })
}

lifecycle('start', '🟢', 'Start Hermes stack', 'start_node.yml', 'Started Hermes')
lifecycle('stop', '🔴', 'Stop Hermes stack', 'stop_node.yml', 'Stopped Hermes')
lifecycle('restart', '♻️', 'Restart Hermes stack', 'restart_node.yml', 'Restarted Hermes')
lifecycle('update', '🔄', 'Pull hermes_repo_ref + rebuild + restart', 'update_hermes.yml', 'Updated Hermes')

// `firewall` calls the shared cmn/deploy_nftables.yml against the
// mainnet_hermes inventory.  Operators must define `mgmt_ips_v4` (and
// optionally `public_tcp_ports` / `public_udp_ports` / `restricted_ports`)
// in their inventory or via `-e` — the playbook refuses to run with an
// empty mgmt list to avoid SSH lockout.
hermesCmd.command('firewall')
  .description('🛡️ Apply nftables ruleset to Hermes hosts')
  .option('-p, --pubkey <pubkey>', 'Limit to specific host')
  .action(async (options) => {
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/cmn/deploy_nftables.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, 'mainnet_hermes', options.pubkey)
      : await runAnsilbe(playbook, 'mainnet_hermes')
    if (result) {
      console.log(colors.white('✅ Applied nftables to Hermes hosts'))
    }
  })
