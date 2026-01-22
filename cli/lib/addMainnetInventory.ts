import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { genOrReadMainnetInventory } from '/lib/genOrReadMainnetInventory.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { ValidatorMainnetConfig } from '@cmn/types/config.ts'

const addMainnetInventory = async (
  name: string,
  identityAccount: string,
  sshConnection: SSHConnection,
) => {
  try {
    const inventoryType = 'mainnet_validators'
    const inventory = await genOrReadMainnetInventory()

    if (!inventory[inventoryType].hosts) {
      inventory[inventoryType].hosts = {}
    }

    // Get versions from versions.yml
    await genOrReadVersions()

    // Add the new host
    inventory[inventoryType].hosts[name] = {
      name,
      ansible_host: sshConnection.ip,
      ansible_user: sshConnection.username,
      ansible_ssh_private_key_file: sshConnection.rsa_key_path,
      identity_account: identityAccount,
      vote_account: '',
      authority_account: '',
      commission_bps: 0,
      username: sshConnection.username,
      validator_type: 'firedancer-jito',
      region: '',
      port_rpc: 8899,
      dynamic_port_range: '8000-8025',
      relayer_url: 'http://localhost:11226',
      block_engine_url: 'http://ny.mainnet.relayer.jito.wtf:8100',
      shred_receiver_address: '',
      snapshot_url: '',
      limit_ledger_size: 200000000,
      staked_rpc_identity_account:
        '7KEVKK9gZ1VUjaTowuCCA8mwMJYTUsZSrSKuTCowSLV',
      staked_rpc_amount: 500000000000000,
    } as ValidatorMainnetConfig

    const inventoryPath = getInventoryPath(inventoryType)
    await Deno.writeTextFile(inventoryPath, stringify(inventory))
    console.log(`✔ Inventory updated to ${inventoryPath}`)
    const newInventory = await genOrReadMainnetInventory()
    return newInventory
  } catch (error) {
    throw new Error(`❌ Error adding inventory: ${error}`)
  }
}

export { addMainnetInventory }
