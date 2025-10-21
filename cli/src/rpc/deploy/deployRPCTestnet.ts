import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listRPCs } from '/src/rpc/listRPCs.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'

const deployRPCTestnet = async (limit?: string) => {
  const inventoryType = 'testnet_rpcs'
  const templateRoot = getTemplatePath()
  await listRPCs('testnet', limit)
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
  const yml = `${templateRoot}/ansible/testnet-rpc/init.yml`
  const result = limit
    ? await runAnsilbe(yml, inventoryType, limit)
    : await runAnsilbe(yml, inventoryType)
  if (result) {
    console.log('Successfully Deployed RPC on testnet')
    rpcLog(ansibleHosts)
    return true
  }
  console.log('Failed to deploy validator on testnet')
  return false
}

export { deployRPCTestnet }
