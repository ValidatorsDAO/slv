import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { genOrReadMainnetRPCInventory } from '/lib/genOrReadMainnetRPCInventory.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { colors } from '@cliffy/colors'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { RpcConfig, RpcType } from '@cmn/types/config.ts'

const addMainnetRPCInventory = async (
  identityAccount: string,
  sshConnection: SSHConnection,
  rpcType: RpcType = 'Geyser gRPC',
  region: string = 'amsterdam',
  snapshotUrl: string = '',
) => {
  try {
    const inventoryType = 'mainnet_rpcs'
    const inventory = await genOrReadMainnetRPCInventory()

    if (!inventory[inventoryType].hosts) {
      inventory[inventoryType].hosts = {}
    }

    const findIdentity = Object.keys(inventory[inventoryType].hosts).find(
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
      inventory[inventoryType].hosts,
    ).find((key) => key.identity_account === identityAccount)

    if (checkIdentityKey) {
      console.log(colors.yellow(`⚠️ Identity account already exists`))
      return false
    }

    // Get versions from versions.yml
    await genOrReadVersions()

    // Add the new host
    inventory[inventoryType].hosts[identityAccount] = {
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
    const newInventory = await genOrReadMainnetRPCInventory()
    return newInventory
  } catch (error) {
    throw new Error(`❌ Error adding inventory: ${error}`)
  }
}

export { addMainnetRPCInventory }
