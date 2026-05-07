import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listRPCs } from '/src/rpc/listRPCs.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { runSha256Patch } from '/lib/sha256Patch.ts'

const deployRPCMainnet = async (limit?: string) => {
  const inventoryType = 'mainnet_rpcs'
  const templateRoot = getTemplatePath()
  await listRPCs('mainnet', limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
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
  const yml = `${templateRoot}/ansible/mainnet-rpc/init.yml`
  const result = limit
    ? await runAnsilbe(yml, inventoryType, limit)
    : await runAnsilbe(yml, inventoryType)
  if (result) {
    console.log('Successfully Deployed RPC on mainnet')
    rpcLog(ansibleHosts)
    // Auto-apply optimized SHA256 patch for the inventory's Solana version.
    try {
      await runSha256Patch('rpc', 'mainnet', limit)
    } catch (e) {
      console.warn(
        colors.yellow(
          `⚠️  patch:sha256 skipped: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      )
    }
    return true
  }
  console.log('Failed to deploy validator on mainnet')
  return false
}

export { deployRPCMainnet }
