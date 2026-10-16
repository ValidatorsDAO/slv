import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { confirmDeploy } from '/lib/targetGuard.ts'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listRPCs } from '/src/rpc/listRPCs.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { warnFdctlMainnetRpcDeploy } from '/lib/fdctlMainnetGuard.ts'
import { refuseBelowFloorPins } from '/lib/versionFloor.ts'

const deployRPCMainnet = async (limit?: string) => {
  // A client pinned below what Alpenglow runs on is not installed.
  if (await refuseBelowFloorPins('mainnet', 'rpc')) return false
  const inventoryType = 'mainnet_rpcs'
  const templateRoot = getTemplatePath()
  await listRPCs('mainnet', limit)
  // Alpenglow: a Frankendancer RPC node is not supported for the migration.
  // This only warns; the deploy still goes on.
  await warnFdctlMainnetRpcDeploy(limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  if (!await confirmDeploy()) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const yml = `${templateRoot}/ansible/mainnet-rpc/init.yml`
  const result = await runAnsilbe(yml, inventoryType, limit, undefined, {
    allHostsConfirmed: true,
  })
  if (result) {
    console.log('Successfully Deployed RPC on mainnet')
    rpcLog(ansibleHosts)
    return true
  }
  console.log('Failed to deploy validator on mainnet')
  return false
}

export { deployRPCMainnet }
