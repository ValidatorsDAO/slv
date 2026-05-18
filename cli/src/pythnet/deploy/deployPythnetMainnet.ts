import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'

const deployPythnetMainnet = async (limit?: string) => {
  const inventoryType = 'mainnet_pythnet'
  const templateRoot = getTemplatePath()
  const limitString = limit ?? 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  console.log(
    colors.cyan(
      `Deploying Pythnet RPC to ${ansibleHosts.length} host(s) from inventory.mainnet.pythnet.yml`,
    ),
  )
  console.log(
    colors.yellow(
      '⚠️  First-time deploy builds Pythnet from source (~2-15 min depending on CPU)\n' +
      '   and then fetches/applies a snapshot from the gossip entrypoint\n' +
      '   (~10-20 min before getHealth returns "ok").',
    ),
  )
  const confirm = await prompt([{
    type: Confirm,
    name: 'continue',
    message: 'Do you want to continue?',
    default: true,
  }])
  if (!confirm.continue) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const yml = `${templateRoot}/ansible/mainnet-pythnet/init.yml`
  const result = limit
    ? await runAnsilbe(yml, inventoryType, limit)
    : await runAnsilbe(yml, inventoryType)
  if (result) {
    console.log(colors.white('✅ Successfully deployed Pythnet RPC on mainnet'))
    return true
  }
  console.log(colors.red('❌ Failed to deploy Pythnet RPC'))
  return false
}

export { deployPythnetMainnet }
