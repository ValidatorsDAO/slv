import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { confirmDeploy } from '/lib/targetGuard.ts'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listRPCs } from '/src/rpc/listRPCs.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { refuseBelowFloorPins } from '/lib/versionFloor.ts'

const deployRPCDevnet = async (limit?: string) => {
  // A client pinned below what Alpenglow runs on is not installed.
  if (await refuseBelowFloorPins('devnet', 'rpc')) return false
  const inventoryType = 'devnet_rpcs'
  const templateRoot = getTemplatePath()
  await listRPCs('devnet', limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  if (!await confirmDeploy()) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const yml = `${templateRoot}/ansible/devnet-rpc/init.yml`
  const result = await runAnsilbe(yml, inventoryType, limit, undefined, {
    allHostsConfirmed: true,
  })
  if (result) {
    console.log('Successfully Deployed RPC on devnet')
    rpcLog(ansibleHosts)
    return true
  }
  console.log('Failed to deploy validator on devnet')
  return false
}

export { deployRPCDevnet }
