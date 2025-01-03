import { Command } from '@cliffy'
import { init } from '/src/validator/init/init.ts'
import { deployValidatorTestnet } from '/src/validator/deploy/deployValidatorTestnet.ts'
import { prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { listValidators } from '/src/validator/listValidators.ts'
import { getIPByIdentityKey } from '/lib/getIPByIdentityKey.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'

export const validatorCmd = new Command()
  .description('Manage Solana Validator Nodes')
  .action(() => {
    validatorCmd.showHelp()
  })

validatorCmd.command('init')
  .description('Initialize a new validator')
  .action(async () => {
    await init()
  })

validatorCmd.command('deploy')
  .description('Deploy Validators')
  .option('-n, --network <network>', 'Network to deploy validators')
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
      await deployValidatorTestnet()
    } else {
      console.log(colors.blue('Coming soon...🌝'))
    }
  })

validatorCmd.command('list')
  .description('List validators')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'testnet',
  })
  .action(async (options) => {
    // const network = options.network
    await listValidators()
  })

validatorCmd.command('set:identity')
  .description('Set Validator Identity')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'testnet',
  })
  .option('--pubkey <pubkey>', 'Public Key of Validator')
  .action(async (options) => {
    // const network = options.network
    if (!options.pubkey) {
      console.log(colors.yellow('⚠️ Public Key is required'))
      return
    }
    const ip = await getIPByIdentityKey(options.pubkey)
    if (!ip) {
      console.log(colors.yellow('⚠️ IP not found'))
      return
    }
    console.log(`Setting Validator Identity with IP: ${ip}`)
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/testnet-validator/change_identity_and_restart.yml`
    const result = await runAnsilbe(playbook, ip)
    if (result) {
      console.log(colors.white('✅ Successfully Set Validator Identity'))
      return
    }
  })

validatorCmd.command('set:unstaked')
  .description(
    'Set Validator Identity to Unstaked Key Stop/Change Identity/Start',
  )
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'testnet',
  })
  .option('--pubkey <pubkey>', 'Public Key of Validator')
  .action(async (options) => {
    if (!options.pubkey) {
      console.log(colors.yellow('⚠️ Public Key is required'))
      return
    }
    const ip = await getIPByIdentityKey(options.pubkey)
    if (!ip) {
      console.log(colors.yellow('⚠️ IP not found'))
      return
    }
    console.log(`Setting Validator Identity with IP: ${ip}`)
    const templateRoot = getTemplatePath()
    const playbook =
      `${templateRoot}/ansible/testnet-validator/set_unstaked_key.yml`
    const result = await runAnsilbe(playbook, ip)
    if (result) {
      console.log(colors.white('✅ Successfully Set Unstaked Identity'))
      return
    }
  })

validatorCmd.command('restart')
  .description('Restart validator')
  .option('-n, --network <network>', 'Network to deploy validators', {
    default: 'testnet',
  })
  .option('--pubkey <pubkey>', 'Public Key of Validator')
  .option(
    '-r, --rm',
    'Remove Snapshot/Ledger Dirs and DL Snapshot with Snapshot Finder before Starting',
    { default: false },
  )
  .action(async (options) => {
    if (!options.pubkey) {
      console.log(colors.yellow('⚠️ Public Key is required'))
      return
    }
    const ip = await getIPByIdentityKey(options.pubkey)
    if (!ip) {
      console.log(colors.yellow('⚠️ IP not found'))
      return
    }
    console.log(`Setting Validator Identity with IP: ${ip}`)
    const templateRoot = getTemplatePath()
    const playbook = options.rm
      ? `${templateRoot}/ansible/testnet-validator/restart_firedancer_with_rm_ledger.yml`
      : `${templateRoot}/ansible/testnet-validator/restart_firedancer.yml`

    const result = await runAnsilbe(playbook, ip)
    if (result) {
      console.log(colors.white('✅ Successfully Restarted Validator'))
      return
    }
  })
