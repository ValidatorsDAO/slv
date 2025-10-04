import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listRPCs } from '/src/rpc/listRPCs.ts'

const deployRPCDevnet = async (limit?: string) => {
  const inventoryType = 'devnet_rpcs'
  const templateRoot = getTemplatePath()
  await listRPCs('devnet', limit)
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
  const yml = `${templateRoot}/ansible/devnet-rpc/init.yml`
  const result = limit
    ? await runAnsilbe(yml, inventoryType, limit)
    : await runAnsilbe(yml, inventoryType)
  if (result) {
    console.log('Successfully Deployed RPC on devnet')
    rpcLog()
    return true
  }
  console.log('Failed to deploy validator on devnet')
  return false
}

export { deployRPCDevnet }
