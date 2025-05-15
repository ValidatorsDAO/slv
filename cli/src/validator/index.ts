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
import { updateAllowedIps } from '/lib/config/updateAllowedIps.ts'

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
    '🔄 Set Validator Identity to Unstaked Key',
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
    const inventoryType: InventoryType = 'testnet_validators'
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

validatorCmd.command('update:version')
  .description('⬆️  Update Validator Version')
  .option('-c, --config-only', 'Update Config Only', { default: false })
  .option('-p, --pubkey <pubkey>', 'Public Key of Validator.')
  .option('-n, --network <network>', 'Solana Network', {
    default: 'testnet',
  })
  .action(async (options) => {
    if (options.configOnly) {
      await updateDefaultVersion()
      return
    }
    const inventoryType: InventoryType = options.network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const templateRoot = getTemplatePath()
    if (options.network === 'mainnet') {
      const playbook =
        `${templateRoot}/ansible/mainnet-validator/install_jito.yml`
      if (options.pubkey) {
        await runAnsilbe(playbook, inventoryType, options.pubkey)
        return
      }
      await runAnsilbe(playbook, inventoryType)
      return
    } else {
      const playbook =
        `${templateRoot}/ansible/testnet-validator/install_agave.yml`
      if (options.pubkey) {
        await runAnsilbe(playbook, inventoryType, options.pubkey)
        return
      }
      await runAnsilbe(playbook, inventoryType)
    }
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
  .option(
    '-r, --rm',
    'Remove Snapshot/Ledger Dirs and DL Snapshot with Snapshot Finder before Starting',
    { default: false },
  )
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
      const playbook = options.rm
        ? `${templateRoot}/ansible/testnet-validator/restart_firedancer_with_rm_ledger.yml`
        : `${templateRoot}/ansible/testnet-validator/restart_firedancer.yml`

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
  .description('⚡️ Download Snapshot with aria2c ⚡️')
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

validatorCmd.command('update:allowed-ips')
  .description('🛡️  Update allowed IPs for mainnet validator nodes')
  .action(async () => {
    await updateAllowedIps('mainnet_validators')
  })

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