import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { genOrReadInventory } from '/lib/genOrReadInventory.ts'
import type { InventoryType, ValidatorTestnetType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'

const addInventory = async (
  name: string,
  identityAccount: string,
  sshConnection: SSHConnection,
  inventoryType: InventoryType,
  voteAccount: string,
  authorityAccount: string,
) => {
  try {
    const inventory = await genOrReadInventory(inventoryType)
    // Initialize hosts if it's null or undefined
    if (!inventory[inventoryType].hosts) {
      inventory[inventoryType].hosts = {}
    }
    await genOrReadVersions()

    const validator_type = 'firedancer' as ValidatorTestnetType

    // Add the new host
    inventory[inventoryType].hosts[name] = {
      name,
      ansible_host: sshConnection.ip,
      ansible_user: sshConnection.username,
      ansible_ssh_private_key_file: sshConnection.rsa_key_path,
      identity_account: identityAccount,
      vote_account: voteAccount,
      authority_account: authorityAccount,
      validator_type,
      snapshot_url: '',
    }
    const inventoryPath = getInventoryPath(inventoryType)
    await Deno.writeTextFile(inventoryPath, stringify(inventory))
    console.log(`✔ Inventory updated to ${inventoryPath}`)
    const newInventory = await genOrReadInventory(inventoryType)
    return newInventory
  } catch (error) {
    throw new Error(`❌ Error adding inventory: ${error}`)
  }
}

export { addInventory }
