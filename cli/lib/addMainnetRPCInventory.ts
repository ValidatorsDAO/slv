import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { genOrReadMainnetRPCInventory } from '/lib/genOrReadMainnetRPCInventory.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { colors } from '@cliffy/colors'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type {
  InventoryDevnetRPC,
  InventoryRPC,
  InventoryTestnetRPC,
  InventoryType,
  NetworkType,
  RpcConfig,
  RpcType,
} from '@cmn/types/config.ts'
import { genOrGetRPCInventory } from '/lib/genOrGetRPCInventory.ts'

const addMainnetRPCInventory = async (
  identityAccount: string,
  sshConnection: SSHConnection,
  rpcType: RpcType = 'Geyser gRPC',
  region: string = 'amsterdam',
  snapshotUrl: string = '',
  network: NetworkType = 'mainnet',
) => {
  try {
    const inventoryType = `${network}_rpcs` as InventoryType
    const inventory = await genOrGetRPCInventory(network)

    // Type guard to handle different inventory types
    let rpcData: any
    if (network === 'mainnet' && 'mainnet_rpcs' in inventory) {
      rpcData = (inventory as InventoryRPC).mainnet_rpcs
    } else if (network === 'devnet' && 'devnet_rpcs' in inventory) {
      rpcData = (inventory as InventoryDevnetRPC).devnet_rpcs
    } else if (network === 'testnet' && 'testnet_rpcs' in inventory) {
      rpcData = (inventory as InventoryTestnetRPC).testnet_rpcs
    } else {
      throw new Error(`Invalid network type: ${network}`)
    }

    if (!rpcData.hosts) {
      rpcData.hosts = {}
    }

    const findIdentity = Object.keys(rpcData.hosts).find(
      (key) => String(key) === identityAccount,
    )

    if (findIdentity) {
      console.log(
        colors.yellow(`⚠️ The same Identity already exists
        
  Please remove the existing Identity Account from inventory and try again`),
      )
      return false
    }

    const checkIdentityKey = Object.values(
      rpcData.hosts,
    ).find((key: any) => key.identity_account === identityAccount)

    if (checkIdentityKey) {
      console.log(colors.yellow(`⚠️ Identity account already exists`))
      return false
    }

    // Get versions from versions.yml
    await genOrReadVersions()

    // Add the new host
    rpcData.hosts[identityAccount] = {
      name: identityAccount,
      ansible_host: sshConnection.ip,
      ansible_user: sshConnection.username,
      ansible_ssh_private_key_file: sshConnection.rsa_key_path,
      identity_account: identityAccount,
      region: region,
      rpc_type: rpcType,
      snapshot_url: snapshotUrl,
      limit_ledger_size: 200000000,
      shredstream_address: '',
    } as RpcConfig

    const inventoryPath = getInventoryPath(inventoryType)
    await Deno.writeTextFile(inventoryPath, stringify(inventory))
    console.log(`✔ Inventory updated to ${inventoryPath}`)

    // Return the appropriate inventory based on network
    if (network === 'mainnet') {
      return await genOrReadMainnetRPCInventory()
    } else {
      return await genOrGetRPCInventory(network)
    }
  } catch (error) {
    throw new Error(`❌ Error adding inventory: ${error}`)
  }
}

export { addMainnetRPCInventory }
