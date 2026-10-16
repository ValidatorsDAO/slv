import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { confirmDeploy } from '/lib/targetGuard.ts'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listRPCs } from '/src/rpc/listRPCs.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { refuseBelowFloorPins } from '/lib/versionFloor.ts'

const deployRPCTestnet = async (limit?: string) => {
  // A client pinned below what Alpenglow runs on is not installed.
  if (await refuseBelowFloorPins('testnet', 'rpc')) return false
  const inventoryType = 'testnet_rpcs'
  const templateRoot = getTemplatePath()
  await listRPCs('testnet', limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  if (!await confirmDeploy()) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const yml = `${templateRoot}/ansible/testnet-rpc/init.yml`
  const result = await runAnsilbe(yml, inventoryType, limit, undefined, {
    allHostsConfirmed: true,
  })
  if (result) {
    console.log('Successfully Deployed RPC on testnet')
    rpcLog(ansibleHosts)
    return true
  }
  console.log('Failed to deploy validator on testnet')
  return false
}

export { deployRPCTestnet }
