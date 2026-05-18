import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'

const deployHermesMainnet = async (limit?: string) => {
  const inventoryType = 'mainnet_hermes'
  const templateRoot = getTemplatePath()
  const limitString = limit ?? 'all'
  // Surface which hosts will be touched before asking for confirmation —
  // mirrors the safety check in deployRPCMainnet so a fat-finger inventory
  // doesn't accidentally rebuild every host in the group.
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  console.log(
    colors.cyan(
      `Deploying Hermes to ${ansibleHosts.length} host(s) from inventory.mainnet.hermes.yml`,
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
  const yml = `${templateRoot}/ansible/mainnet-hermes/init.yml`
  const result = limit
    ? await runAnsilbe(yml, inventoryType, limit)
    : await runAnsilbe(yml, inventoryType)
  if (result) {
    console.log(colors.white('✅ Successfully deployed Hermes stack on mainnet'))
    return true
  }
  console.log(colors.red('❌ Failed to deploy Hermes stack'))
  return false
}

export { deployHermesMainnet }
