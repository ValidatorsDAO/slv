import { genVoteKey } from '/src/validator/init/genVoteKey.ts'
import { genIdentityKey } from '/src/validator/init/genIdentityKey.ts'
import type {
  InventoryType,
  ValidatorTestnetConfig,
  ValidatorTestnetType,
} from '@cmn/types/config.ts'
import type { SSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { configRoot, getInventoryPath } from '@cmn/constants/path.ts'
import { colors } from '@cliffy/colors'
import { genSolvUser } from '/src/validator/init/genSolvUser.ts'
import { addInventory } from '/lib/addInventory.ts'
import { exec } from '@elsoul/child-process'
import denoJson from '/deno.json' with { type: 'json' }
import { updateInventory } from '/lib/updateInventory.ts'
import { Input, prompt, Select } from '@cliffy/prompt'
import { testnetValidatorConfigDir } from '@cmn/constants/path.ts'

const initTestnetConfig = async (sshConnection: SSHConnection) => {
  try {
    await Deno.stat(testnetValidatorConfigDir)
    await exec(
      `cp -r ${configRoot}/template/${denoJson.version}/jinja/testnet-validator ${configRoot}`,
    )
  } catch (_error) {
    await exec(
      `cp -r ${configRoot}/template/${denoJson.version}/jinja/testnet-validator ${configRoot}`,
    )
  }
  const { validatorType } = await prompt([
    {
      name: 'validatorType',
      message: 'Select Validator Type',
      type: Select,
      options: ['agave', 'firedancer'],
      default: 'agave',
    },
  ])
  if (!validatorType) {
    return
  }
  const inventoryType = 'testnet_validators' as InventoryType
  // Check if testnet-validator Template exists
  try {
    const inventoryPath = getInventoryPath(inventoryType)
    await Deno.stat(inventoryPath)
  } catch (_error) {
    await exec(
      `cp -r ${configRoot}/template/${denoJson.version}/jinja/testnet-validator ${configRoot}`,
    )
  }
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
  // Generate Vote Key
  const { voteAccount, authAccount } = await genVoteKey(identityAccount)
  // Generate or Add Inventory
  const inventoryCheck = await addInventory(
    name,
    identityAccount,
    sshConnection,
    inventoryType,
    voteAccount,
    authAccount,
  )
  if (!inventoryCheck) {
    console.log(colors.yellow('⚠️ Inventory check failed'))
    return
  }
  const configTestnet: Partial<ValidatorTestnetConfig> = {
    name,
    identity_account: identityAccount,
    vote_account: voteAccount,
    authority_account: authAccount,
    validator_type: validatorType as ValidatorTestnetType,
  }
  await updateInventory(name, configTestnet)
  // Create solv User on Ubuntu Server
  await genSolvUser(name, inventoryType)
  console.log(
    `✔︎ Validator testnet config saved to ${inventoryPath}`,
  )
  console.log(colors.white(`Now you can deploy with:

$ slv v deploy -n testnet -p ${name}
`))
  return configTestnet
}

export { initTestnetConfig }
