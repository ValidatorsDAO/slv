import { colors } from '@cliffy/colors'
import { Input, prompt, Select } from '@cliffy/prompt'
import denoJson from '/deno.json' with { type: 'json' }
import { exec } from '@elsoul/child-process'
import {
  configRoot,
  getInventoryPath,
  mainnetValidatorConfigDir,
} from '@cmn/constants/path.ts'
import { genIdentityKey } from '/src/validator/init/genIdentityKey.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { genSolvUser } from '/src/validator/init/genSolvUser.ts'
import { genVoteKey } from '/src/validator/init/genVoteKey.ts'
import type { ValidatorMainnetConfig } from '@cmn/types/config.ts'
import { DEFAULT_RPC_ADDRESS, SolanaNodeTypes } from '@cmn/constants/config.ts'
import { addMainnetInventory } from '/lib/addMainnetInventory.ts'
import { updateMainnetInventory } from '/lib/updateMainnetInventory.ts'
import {
  findNearestJitoRegion,
  type RegionLatency,
} from '/lib/jito/findNearestRegion.ts'
import type { SolanaNodeType } from '@cmn/types/config.ts'

const initMainnetConfig = async (sshConnection: SSHConnection) => {
  const {
    validatorType,
  } = await prompt([
    {
      name: 'validatorType',
      message: 'Select Validator Type',
      type: Select,
      options: [...SolanaNodeTypes],
      default: 'firedancer-jito',
    },
  ])
  if (!validatorType) {
    return
  }
  let commissionBps = '1000'
  if (validatorType.includes('jito')) {
    const cmsBps = await prompt([
      {
        name: 'commission_bps',
        message: 'Enter Commission BPS (Max 1000 = 10%)',
        type: Input,
        default: '1000',
      },
    ])
    commissionBps = String(cmsBps.commission_bps)
  }

  const rpcAccount = DEFAULT_RPC_ADDRESS
  const inventoryType = 'mainnet_validators'
  const identityAccount = await genIdentityKey()
  const { name } = await prompt([
    {
      name: 'name',
      message: 'Enter Inventory Name',
      type: Input,
      default: identityAccount,
    },
  ])
  if (!name) {
    console.log(colors.red('⚠️ Inventory Name is required'))
    return
  }
  const inventoryPath = getInventoryPath(inventoryType)

  console.log(colors.yellow(`⚠️ Please place your identity key in 
        
~/.slv/keys/${identityAccount}.json`))

  // Generate or Add Inventory
  const inventoryCheck = await addMainnetInventory(
    name,
    identityAccount,
    sshConnection,
  )
  if (!inventoryCheck) {
    console.log(colors.yellow('⚠️ Inventory check failed'))
    return
  }
  const host = sshConnection.ip
  const user = sshConnection.username
  const keyFile = sshConnection.rsa_key_path
  const network = 'mainnet'
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
  const blockEngineRegion = getNearRegion.info.blockEngineUrl
  const shredstream_address = getNearRegion.info.shredReceiver
  const relayer_url = getNearRegion.info.relayerUrl
  // Generate Vote Key
  const { voteAccount, authAccount } = await genVoteKey(identityAccount)
  const configMainnet: Partial<ValidatorMainnetConfig> = {
    name,
    vote_account: voteAccount,
    authority_account: authAccount,
    validator_type: validatorType as SolanaNodeType,
    region: getNearRegion.region,
    commission_bps: Number(commissionBps),
    port_rpc: 7211,
    dynamic_port_range: '8900-8925',
    relayer_url,
    block_engine_url: blockEngineRegion,
    shred_receiver_address: String(shredstream_address),
    staked_rpc_identity_account: rpcAccount,
  }
  // await updateAllowedSshIps()
  // await updateAllowedIps()
  await updateMainnetInventory(name, configMainnet)
  // Create solv User on Ubuntu Server
  await genSolvUser(name, inventoryType)
  console.log(
    `✔︎ Validator Mainnet Config Saved To ${inventoryPath}`,
  )
  console.log(colors.white(`Now you can deploy with:

$ slv v deploy -n mainnet -p ${name}    
`))
}

export { initMainnetConfig }
