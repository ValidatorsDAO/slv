import { Command } from '@cliffy'
import { init } from '/src/validator/init/init.ts'
import { deployValidatorTestnet } from '/src/validator/deploy/deployValidatorTestnet.ts'
import { deployValidatorMainnet } from '/src/validator/deploy/deployValidatorMainnet.ts'
import { Input, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'
import { parseDeployNetwork } from '/lib/targetGuard.ts'
import { runSetIdentity } from '/lib/identityPrecheck.ts'
import type { InventoryType, NetworkType } from '@cmn/types/config.ts'
import { runSwitchCommand } from '/src/validator/switch/switchCommand.ts'
import { runCheckAlpenglow } from '/src/validator/checkAlpenglow.ts'
import { updateDefaultVersion } from '/lib/config/updateDefaultVersion.ts'
import { listValidators } from '/src/validator/listValidators.ts'
// import { updateAllowedIps } from '/lib/config/updateAllowedIps.ts'
import { createVoteAccount } from '/src/validator/init/createVoteAccount.ts'
import { exec } from '@elsoul/child-process'
import { configRoot } from '@cmn/constants/path.ts'
import denoJson from '/deno.json' with { type: 'json' }
import { transformValidatorTypeFile } from '/lib/migrate/transformValidatorTypes.ts'
import { copyTemplateDirs } from '/src/rpc/init.ts'
import { registerDoubleZeroCommands } from '/lib/doublezero.ts'
import { registerSha256PatchCommands } from '/lib/sha256Patch.ts'
import { registerSolanaBinaryCommands } from '/lib/startScript.ts'
import { registerBlsPubkey } from '/src/validator/registerBlsPubkey.ts'
import { refuseFdctlMainnetCommand } from '/lib/fdctlMainnetGuard.ts'

export const validatorCmd = new Command()
  .description('🛠️ Manage Solana Validator Nodes 🛠️')
  .action(() => {
    validatorCmd.showHelp()
  })

validatorCmd.command('init')
  .description('🚀 Initialize a new validator configuration')
  .option('-l, --localhost', 'Use localhost (no SSH required)', {
    default: false,
  })
  .action(async (options) => {
    await init(options)
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
    const parsed = parseDeployNetwork('validator', network)
    if (!parsed.ok) {
      console.error(colors.red(`❌ ${parsed.error}`))
      Deno.exitCode = 1
      return
    }
    if (parsed.network === 'testnet') {
      await deployValidatorTestnet(options.pubkey)
    } else {
      await deployValidatorMainnet(options.pubkey)
    }
  })

validatorCmd.command('register:bls')
  .description(
    '🔑 Register the BLS public key on vote accounts (SIMD-0387). Runs automatically after deploy; use this to re-run.',
  )
  .option('-n, --network <network>', 'Solana Network')
  .option('-p, --pubkey <pubkey>', 'Inventory host name (defaults to all)')
  .action(async (options) => {
    let network = options.network as NetworkType | undefined
    if (!network) {
      const res = await prompt([
        {
          name: 'network',
          message: 'Select Solana Network',
          type: Select,
          options: ['testnet', 'mainnet'],
          default: 'testnet',
        },
      ])
      network = res.network as NetworkType
    }
    await registerBlsPubkey(network, options.pubkey)
  })

validatorCmd.command('check:alpenglow')
  .description(
    [
      '🔎 Check that each validator of the inventory is ready for Alpenglow, before and after the activation (mainnet epoch 1064).',
      'Read-only: it reads the inventory, ~/.slv/versions.yml and the public RPC of the network. No host is contacted and no transaction is made.',
      'One line per check, OK, WARN or FAIL, with the fix. Exit code 1 when any check FAILs.',
      '  cluster   TowerBFT, activation about to start, migration window, Alpenglow, or unreadable, and what that means for identity changes',
      '  client    validator_type (mainnet: agave, jito or allnodes-jito) and the version pinned in versions.yml against the floor of the network',
      '  running   the version the node of the host advertises in gossip, against the floor and the pin (a standby on its unstaked key is not visible)',
      '  bls       the vote account has a BLS public key (fix: slv v register:bls)',
      '  vat       the vote account holds the Validator Admission Ticket, 0.8 SOL per epoch, above its rent-exempt minimum (WARN below 3 epochs)',
      '  identity  the identity pays the vote fees of TowerBFT, about 1 SOL per epoch (WARN below 3 SOL); under Alpenglow it does not',
      '  voter     the vote account names the identity as its node, and its authorized voter is the identity slv adds to the validator',
    ].join('\n'),
  )
  .option('-n, --network <network>', 'Solana Network (mainnet or testnet)', {
    default: 'mainnet',
  })
  .option(
    '-p, --pubkey <pubkey>',
    'Inventory host name, or several separated by commas (default: every validator of the inventory)',
  )
  .action(async (options) => {
    await runCheckAlpenglow({
      network: options.network,
      pubkey: options.pubkey,
    })
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
  .description(
    '🪪  Set Validator Identity on exactly one host (refuses if the identity may already be running elsewhere)',
  )
  .option('-n, --network <network>', 'Solana Network (mainnet or testnet)', {
    default: 'testnet',
  })
  .option('-p, --pubkey <pubkey>', 'Inventory name of the one host to promote.')
  .option(
    '--first-activation',
    'First promotion of this identity: the host has no tower or vote history yet. On Alpenglow also when the vote account has voted only before Alpenglow, so that there is no vote history file; the playbook checks the vote account.',
  )
  .option(
    '--peer-down-confirmed',
    'Go ahead although a peer host holding the same identity could not be read; use only after confirming it is not running the identity.',
  )
  .option(
    '--primary-down',
    'The old primary (the other host holding this identity) is stopped, powered off if needed, and cannot vote. Needs a terminal: you type its inventory name. For Alpenglow, where its vote history file may be lost with it.',
  )
  .action(async (options) => {
    const result = await runSetIdentity({
      network: options.network,
      pubkey: options.pubkey,
      firstActivation: options.firstActivation,
      peerDownConfirmed: options.peerDownConfirmed,
      primaryDown: options.primaryDown,
    })
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
    // Alpenglow: Firedancer and Frankendancer are not supported on mainnet
    // during the migration.
    if (
      await refuseFdctlMainnetCommand(
        options.network,
        'set up Firedancer',
        options.pubkey,
      )
    ) return
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
    // Alpenglow: Firedancer and Frankendancer are not supported on mainnet
    // during the migration.
    if (
      await refuseFdctlMainnetCommand(
        options.network,
        'update Firedancer',
        options.pubkey,
      )
    ) return
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

registerSolanaBinaryCommands(validatorCmd, 'validator')

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
    await runSwitchCommand({
      from: options.from,
      to: options.to,
      network: options.network,
    })
  })

registerDoubleZeroCommands(validatorCmd, 'validator', 'testnet')
registerSha256PatchCommands(validatorCmd, 'validator', 'testnet')
