import { Command } from '@cliffy'
import { init } from '/src/validator/init/init.ts'
import { deployValidatorTestnet } from '/src/validator/deploy/deployValidatorTestnet.ts'
import { deployValidatorMainnet } from '/src/validator/deploy/deployValidatorMainnet.ts'
import { Input, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'
import type { InventoryType, NetworkType } from '@cmn/types/config.ts'
import { switchValidator } from '/src/validator/switch/switchValidator.ts'
import { updateDefaultVersion } from '/lib/config/updateDefaultVersion.ts'
import { listValidators } from '/src/validator/listValidators.ts'
// import { updateAllowedIps } from '/lib/config/updateAllowedIps.ts'
import { createVoteAccount } from '/src/validator/init/createVoteAccount.ts'
import { exec } from '@elsoul/child-process'
import { configRoot } from '@cmn/constants/path.ts'
import denoJson from '/deno.json' with { type: 'json' }
import { transformValidatorTypeFile } from '/lib/migrate/transformValidatorTypes.ts'
import { copyTemplateDirs } from '/src/rpc/init.ts'

export const validatorCmd = new Command()
  .description('🛠️ Manage Solana Validator Nodes 🛠️')
  .action(() => {
    validatorCmd.showHelp()
  })

validatorCmd.command('init')
  .description('🚀 Initialize a new validator configuration')
  .action(async () => {
    await init()
  })

validatorCmd.command('deploy')
  .description('📦 Deploy Validators')
  .option('-n, --network <network>', 'Solana Network')
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    let network = options.network
    if (!options.network) {
      const validator = await prompt([
        {
          name: 'network',
          message: 'Select Solana Network',
          type: Select,
          options: ['testnet', 'mainnet'],
          default: 'testnet',
        },
      ])
      network = validator.network
    }
    if (network === 'testnet') {
      await deployValidatorTestnet(options.pubkey)
    } else {
      await deployValidatorMainnet(options.pubkey)
    }
  })

validatorCmd.command('list')
  .description('📋 List validators')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .action(async (options) => {
    const network = options.network as NetworkType
    await listValidators(network)
  })

validatorCmd.command('set:identity')
  .description('🪪  Set Validator Identity')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    // const network = options.network
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/${networkPath}/set_identity_key.yml`
    const result = await runAnsilbe(playbook, inventoryType, options.pubkey)
    if (result) {
      console.log(colors.white('✅ Successfully Set Validator Identity'))
      return
    }
  })

validatorCmd.command('set:unstaked')
  .description(
    '📴 Set Validator Identity to Unstaked Key',
  )
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/${networkPath}/set_unstaked_key.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Set Unstaked Identity'))
      return
    }
  })

validatorCmd.command('setup:firedancer')
  .description('🔥 Setup/Update Firedancer Validator')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const templateRoot = getTemplatePath()
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const playbook =
      `${templateRoot}/ansible/${networkPath}/setup_firedancer.yml`

    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Setup Firedancer Validator'))
      return
    }
  })

validatorCmd.command('update:firedancer')
  .description('🔄 Update Firedancer Version')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const templateRoot = getTemplatePath()
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const playbook =
      `${templateRoot}/ansible/${networkPath}/update_firedancer.yml`

    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Update Firedancer Version'))
      return
    }
  })

validatorCmd.command('build:solana-cli')
  .description('🛠️ Build Solana CLI from Source')
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .action(async (options) => {
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const templateRoot = getTemplatePath()
    if (options.network === 'mainnet') {
      const playbook =
        `${templateRoot}/ansible/mainnet-validator/install_solana.yml`
      if (options.pubkey) {
        await runAnsilbe(playbook, inventoryType, options.pubkey)
        return
      }
      await runAnsilbe(playbook, inventoryType)
      return
    } else {
      const playbook =
        `${templateRoot}/ansible/testnet-validator/install_solana.yml`
      if (options.pubkey) {
        await runAnsilbe(playbook, inventoryType, options.pubkey)
        return
      }
      await runAnsilbe(playbook, inventoryType)
    }
  })

validatorCmd.command('install:solana')
  .description('➡️ Install Solana CLI Binary')
  .option('-v, --version <version>', 'Solana CLI version to install')
  .option('-p, --pubkey <pubkey>', 'Name of RPC')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'mainnet',
  })
  .action(async (options) => {
    const inventoryType = options.network + '_validators' as InventoryType
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/cmn/install_solana.yml`
    if (options.version) {
      const extraVars = { version: options.version }
      if (options.pubkey) {
        await runAnsilbe(
          playbook,
          inventoryType,
          options.pubkey,
          extraVars,
        )
        return
      }
      await runAnsilbe(playbook, inventoryType, undefined, extraVars)
      return
    }

    if (options.pubkey) {
      await runAnsilbe(playbook, inventoryType, options.pubkey)
      return
    }
    await runAnsilbe(playbook, inventoryType)
    return
  })

validatorCmd.command('update:script')
  .description('⚙️  Update Validator Startup Config')
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .action(async (options) => {
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/${networkPath}/update_startup_config.yml`
    if (options.pubkey) {
      await runAnsilbe(playbook, inventoryType, options.pubkey)
      return
    }
    await runAnsilbe(playbook, inventoryType, options.pubkey)
  })

validatorCmd.command('start')
  .description('🟢 Start Validator')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    // const network = options.network
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/start_node.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Started Validator'))
      return
    }
  })

validatorCmd.command('stop')
  .description('🔴 Stop Validator')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    // const network = options.network
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/stop_node.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Stopped Validator'))
      return
    }
  })

validatorCmd.command('restart')
  .description('♻️  Restart Validator')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const templateRoot = getTemplatePath()
    if (options.network === 'mainnet') {
      const playbook =
        `${templateRoot}/ansible/mainnet-validator/restart_node.yml`
      const result = options.pubkey
        ? await runAnsilbe(playbook, inventoryType, options.pubkey)
        : await runAnsilbe(playbook, inventoryType)
      if (result) {
        console.log(colors.white('✅ Successfully Restarted Validator'))
        return
      }
    } else {
      const playbook =
        `${templateRoot}/ansible/testnet-validator/restart_node.yml`

      const result = options.pubkey
        ? await runAnsilbe(playbook, inventoryType, options.pubkey)
        : await runAnsilbe(playbook, inventoryType)
      if (result) {
        console.log(colors.white('✅ Successfully Restarted Validator'))
        return
      }
    }
  })

validatorCmd.command('cleanup')
  .description(
    '🧹 Cleanup Validator - Remove Ledger/Snapshot Unnecessary Files',
  )
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    // const network = options.network
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/cmn/rm_ledger.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Cleaned Up Validator'))
      return
    }
  })

validatorCmd.command('get:snapshot')
  .description('💾 Download Snapshot with aria2c')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .action(async (options) => {
    // const network = options.network
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkPath = options.network === 'mainnet'
      ? 'mainnet-validator'
      : 'testnet-validator'
    const templateRoot = getTemplatePath()
    const playbook = `${templateRoot}/ansible/${networkPath}/wget_snapshot.yml`
    const result = options.pubkey
      ? await runAnsilbe(playbook, inventoryType, options.pubkey)
      : await runAnsilbe(playbook, inventoryType)
    if (result) {
      console.log(colors.white('✅ Successfully Downloaded Snapshot'))
      return
    }
  })

validatorCmd.command('gen:vote-account')
  .description('🗳️  Generate Vote Account')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .option('-v, --vote-account <voteAccount>', 'Vote Account')
  .option('-a, --auth-account <authAccount>', 'Vote Account Authority')
  .option('-c, --commission <commission>', 'Vote Account Commission')
  .action(async (options) => {
    const network = options.network === 'mainnet'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.testnet.solana.com'
    let identityAccount = options.pubkey
    let authAccount = options.authAccount
    let voteAccount = options.voteAccount
    let commission = options.commission
    if (!identityAccount) {
      const identity = await prompt([
        {
          name: 'identityAccount',
          message: 'Enter Identity Account',
          type: Input,
        },
      ])
      identityAccount = identity.identityAccount
    }
    if (!authAccount) {
      const auth = await prompt([
        {
          name: 'authAccount',
          message: 'Enter Vote Account Authority',
          type: Input,
        },
      ])
      authAccount = auth.authAccount
    }
    if (!voteAccount) {
      const vote = await prompt([
        {
          name: 'voteAccount',
          message: 'Enter Vote Account',
          type: Input,
        },
      ])
      voteAccount = vote.voteAccount
    }
    if (!commission) {
      const commissionPrompt = await prompt([
        {
          name: 'commission',
          message: 'Enter Vote Account Commission',
          type: Input,
          default: '0',
        },
      ])
      commission = commissionPrompt.commission
    }
    if (!identityAccount || !authAccount || !voteAccount || !commission) {
      console.log(
        colors.red('❌ Identity, Authority and Vote Accounts are required'),
      )
      return
    }
    console.log(
      `✨ Creating Vote Account with Identity: ${identityAccount}, Authority: ${authAccount}, Vote Account: ${voteAccount}, Commission: ${commission}%`,
    )
    await createVoteAccount(
      identityAccount,
      voteAccount,
      authAccount,
      Number(commission),
      network,
    )
  })

// validatorCmd.command('update:allowed-ips')
//   .description('🛡️  Update allowed IPs for mainnet validator nodes')
//   .action(async () => {
//     await updateAllowedIps('mainnet_validators')
//   })

validatorCmd.command('switch')
  .description('🔁 Switch Validator Identity - No DownTime Migration')
  .option('-f, --from <from>', 'From Validator Identity')
  .option('-t, --to <to>', 'To Validator Identity')
  .option('-n, --network <network>', 'Solana Network')
  .action(async (options) => {
    let from = options.from
    let to = options.to
    let network = options.network
    if (!options.network) {
      const validator = await prompt([
        {
          name: 'network',
          message: 'Select Solana Network',
          type: Select,
          options: ['testnet', 'mainnet'],
          default: 'testnet',
        },
      ])
      network = validator.network || 'testnet'
    }
    const inventoryType: InventoryType = network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const networkString = network === 'mainnet' ? 'Mainnet' : 'Testnet'
    console.log(
      colors.blue(`✨ Switching ${networkString} Validator Identity...`),
    )
    if (!options.from) {
      const fromValidator = await prompt([
        {
          name: 'from',
          message: 'From Validator Name',
          type: Input,
        },
      ])
      from = fromValidator.from
    }
    if (!options.to) {
      const toValidator = await prompt([
        {
          name: 'to',
          message: 'To Validator Name',
          type: Input,
        },
      ])
      to = toValidator.to
    }
    const confirm = await prompt([
      {
        name: 'confirm',
        message:
          `Are you sure you want to switch ${networkString} Validator Identity from ${from} to ${to}?`,
        type: Select,
        options: ['yes', 'no'],
        default: 'no',
      },
    ])
    if (confirm.confirm === 'no') {
      console.log(colors.red('❌ Switch Cancelled'))
      return
    }
    if (!from || !to) {
      console.log(colors.yellow('⚠️ From and To Validators are required'))
      return
    }
    console.log(
      colors.blue(
        `✨ Switching ${networkString} Validator Identity from ${from} to ${to}...`,
      ),
    )
    const result = await switchValidator(
      inventoryType,
      from,
      to,
    )
    if (result) {
      console.log(colors.white('✅ Successfully Switched Validator Identity'))
      return
    }
  })
