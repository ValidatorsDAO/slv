import { prompt, Select } from '@cliffy/prompt'
import { RPC_TYPE } from '@cmn/constants/rpc.ts'
import { colors } from '@cliffy/colors'
import type {
  CmnType,
  InventoryType,
  NetworkType,
  RpcConfig,
  RpcType,
} from '@cmn/types/config.ts'
import { genPasswordYml } from '/lib/genPasswordYml.ts'
import { genIdentityKey } from '/src/validator/init/genIdentityKey.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import { SolanaNodeTypes } from '@cmn/constants/config.ts'
import type { SolanaNodeType } from '@cmn/types/config.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { updateVersionsYml } from '/lib/config/updateVersionsYml.ts'
import { updateAllowedSshIps } from '/lib/config/updateAllowedSshIps.ts'
import { updateAllowedIps } from '/lib/config/updateAllowedIps.ts'
import { genSolvUser } from '/src/validator/init/genSolvUser.ts'
import { addMainnetRPCInventory } from '/lib/addMainnetRPCInventory.ts'
import { updateMainnetRPCInventory } from '/lib/updateMainnetRPCInventory.ts'
import { findNearestJitoRegion } from '/lib/jito/findNearestRegion.ts'
import type { RegionLatency } from '/lib/jito/findNearestRegion.ts'

export const testnetInitRpc = async (sshOptions: SSHConnection) => {
  const host = sshOptions.ip
  const user = sshOptions.username
  const keyFile = sshOptions.rsa_key_path
  const network = 'testnet'
  const getNearRegion = await findNearestJitoRegion(
    host,
    network,
    {
      user,
      keyFile,
      port: 22,
    },
  ) as RegionLatency | null
  if (!getNearRegion) {
    console.log(colors.red('❌ Failed to measure latencies. Please try again.'))
    return
  }

  // Set solv password
  await genPasswordYml()
  const identity_account = await genIdentityKey()
  const rpcTypes = await prompt([
    {
      name: 'validatorType',
      message: 'Select Solana CLI',
      type: Select,
      options: SolanaNodeTypes,
      default: 'jito',
    },
  ])
  const RPC_OPTIONS = rpcTypes.validatorType?.includes('firedancer')
    ? ['Index RPC', 'SendTx RPC']
    : ['Geyser gRPC', 'Index RPC', 'SendTx RPC', 'Index RPC + gRPC']
  const { rpc_type } = await prompt([
    {
      name: 'rpc_type',
      message: 'Select an RPC type',
      type: Select,
      options: RPC_OPTIONS,
    },
  ])

  const rpcConfig: RpcConfig = {
    ansible_host: sshOptions.ip,
    ansible_user: sshOptions.username,
    ansible_ssh_private_key_file: sshOptions.rsa_key_path,
    identity_account: identity_account,
    name: identity_account,
    rpc_type: rpc_type as RpcType,
    port_rpc: 8899,
    dynamic_port_range: '8900-8925',
    validator_type: rpcTypes.validatorType as SolanaNodeType,
    region: getNearRegion.region,
    limit_ledger_size: 200000000,
    shred_receiver_address: String(getNearRegion.info.shredReceiver),
  }

  // Update ~/.slv/versions.yml
  const versions = await genOrReadVersions()
  const body: Partial<CmnType> = {
    ...versions,
    mainnet_rpcs: {
      ...versions.mainnet_rpcs,
    },
  }
  await updateVersionsYml(body)
  const inventoryCheck = await addMainnetRPCInventory(
    identity_account,
    sshOptions,
    rpc_type as RpcType,
    getNearRegion.region,
    '',
    network as NetworkType,
  )
  if (!inventoryCheck) {
    console.log(colors.yellow('⚠️ Inventory check failed'))
    return
  }
  colors.green('✔︎ RPC configuration completed')
  const rpcs: RpcConfig[] = []
  rpcs.push(rpcConfig)
  const inventoryType = network + '_rpcs' as InventoryType
  // await updateAllowedSshIps(inventoryType)
  // await updateAllowedIps(inventoryType)
  await updateMainnetRPCInventory(
    identity_account,
    rpcConfig,
    network as NetworkType,
  )

  await genSolvUser(identity_account, inventoryType as InventoryType)
  const yamlPath = getInventoryPath(inventoryType as InventoryType)

  console.log(
    `✔︎ ${colors.green(inventoryType)} inventory file has been saved to ${
      colors.green(
        yamlPath,
      )
    }`,
  )
  console.log(colors.white(`Now you can deploy with:

$ slv rpc deploy -n ${network} -p ${identity_account}    
`))
  return rpcConfig
}
