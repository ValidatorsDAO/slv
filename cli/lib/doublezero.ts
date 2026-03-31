import { colors } from '@cliffy/colors'
import { Command } from '@cliffy'
import type { InventoryType, NetworkType } from '@cmn/types/config.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { runAnsibleCapture, runAnsilbe } from '/lib/runAnsible.ts'
import { updateInventoryHost } from '/lib/updateInventoryHost.ts'

type DoubleZeroRole = 'validator' | 'rpc'
type DoubleZeroSupportedNetwork = Extract<NetworkType, 'mainnet' | 'testnet'>

const DEFAULT_DOUBLEZERO_FEED = 'edge-solana-shreds'
const DEFAULT_DOUBLEZERO_PROVIDER = 'ibrl'

const resolveDoubleZeroNetwork = (
  network: string,
): DoubleZeroSupportedNetwork => {
  if (network === 'mainnet' || network === 'testnet') {
    return network
  }
  throw new Error(
    'DoubleZero commands currently support mainnet and testnet only.',
  )
}

const getDoubleZeroInventoryType = (
  role: DoubleZeroRole,
  network: DoubleZeroSupportedNetwork,
): InventoryType => {
  if (role === 'rpc') {
    return `${network}_rpcs` as InventoryType
  }
  return network === 'mainnet' ? 'mainnet_validators' : 'testnet_validators'
}

const getDoubleZeroEnvironment = (network: DoubleZeroSupportedNetwork) =>
  network === 'mainnet' ? 'mainnet-beta' : 'testnet'

const getDefaultDoubleZeroKeypairPath = (
  role: DoubleZeroRole,
  network: DoubleZeroSupportedNetwork,
) => {
  if (role === 'rpc') {
    return '/home/solv/rpc-identity.json'
  }
  return network === 'mainnet'
    ? '/home/solv/mainnet-validator-keypair.json'
    : '/home/solv/testnet-validator-keypair.json'
}

const parseDoubleZeroAddresses = (output: string) => {
  const matches = output.matchAll(
    /SLV_DOUBLEZERO_ADDRESS\s+(\S+)\s+(\S+)/g,
  )
  return Array.from(matches, (match) => ({
    host: match[1],
    address: match[2],
  }))
}

const saveDoubleZeroAddresses = async (
  inventoryType: InventoryType,
  output: string,
) => {
  const addresses = parseDoubleZeroAddresses(output)
  if (addresses.length === 0) {
    console.log(
      colors.yellow(
        '⚠️ DoubleZero address was not found in ansible output, inventory was not updated.',
      ),
    )
    return
  }

  for (const { host, address } of addresses) {
    await updateInventoryHost(inventoryType, host, {
      doublezero_address: address,
    })
    console.log(
      colors.green(`✔ Saved DoubleZero address for ${host}: ${address}`),
    )
  }
}

const runDoubleZeroPlaybook = async ({
  role,
  network,
  playbook,
  pubkey,
  extraVars,
  saveAddress = false,
  successMessage,
}: {
  role: DoubleZeroRole
  network: string
  playbook: string
  pubkey?: string
  extraVars?: Record<string, string>
  saveAddress?: boolean
  successMessage: string
}) => {
  try {
    const resolvedNetwork = resolveDoubleZeroNetwork(network)
    const inventoryType = getDoubleZeroInventoryType(role, resolvedNetwork)
    const templateRoot = getTemplatePath()
    const playbookPath = `${templateRoot}/ansible/cmn/${playbook}`

    if (saveAddress) {
      const result = await runAnsibleCapture(
        playbookPath,
        inventoryType,
        pubkey,
        extraVars,
      )
      if (!result.success) {
        console.error('❌ Failed to run ansible. Please check the logs.')
        return
      }
      await saveDoubleZeroAddresses(inventoryType, result.output)
      console.log(colors.white(successMessage))
      return
    }

    const result = pubkey
      ? await runAnsilbe(playbookPath, inventoryType, pubkey, extraVars)
      : await runAnsilbe(playbookPath, inventoryType, undefined, extraVars)
    if (result) {
      console.log(colors.white(successMessage))
    }
  } catch (error) {
    console.error(
      colors.red(
        error instanceof Error ? `❌ ${error.message}` : `❌ ${String(error)}`,
      ),
    )
  }
}

export const registerDoubleZeroCommands = (
  parentCmd: Command,
  role: DoubleZeroRole,
  defaultNetwork: DoubleZeroSupportedNetwork,
) => {
  const label = role === 'validator' ? 'Validator' : 'RPC'

  parentCmd.command('setup:doublezero')
    .description(`🌐 Setup DoubleZero on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option('-e, --env <env>', 'DoubleZero environment override')
    .option('--provider <provider>', 'DoubleZero connect provider', {
      default: DEFAULT_DOUBLEZERO_PROVIDER,
    })
    .action(async (options) => {
      const network = resolveDoubleZeroNetwork(options.network)
      await runDoubleZeroPlaybook({
        role,
        network,
        playbook: 'setup_doublezero.yml',
        pubkey: options.pubkey,
        saveAddress: true,
        extraVars: {
          doublezero_env: options.env || getDoubleZeroEnvironment(network),
          doublezero_connect_provider: options.provider,
        },
        successMessage: `✅ Successfully Setup DoubleZero on ${label}`,
      })
    })

  parentCmd.command('doublezero:keygen')
    .description(`🔑 Generate DoubleZero keys on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .action(async (options) => {
      const network = resolveDoubleZeroNetwork(options.network)
      await runDoubleZeroPlaybook({
        role,
        network,
        playbook: 'doublezero_keygen.yml',
        pubkey: options.pubkey,
        saveAddress: true,
        extraVars: {
          doublezero_env: getDoubleZeroEnvironment(network),
        },
        successMessage: `✅ Successfully Generated DoubleZero keys on ${label}`,
      })
    })

  parentCmd.command('doublezero:connect')
    .description(`🔌 Connect ${label} to DoubleZero`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option('--provider <provider>', 'DoubleZero connect provider', {
      default: DEFAULT_DOUBLEZERO_PROVIDER,
    })
    .action(async (options) => {
      await runDoubleZeroPlaybook({
        role,
        network: options.network,
        playbook: 'doublezero_connect.yml',
        pubkey: options.pubkey,
        extraVars: {
          doublezero_connect_provider: options.provider,
        },
        successMessage: `✅ Successfully Connected ${label} to DoubleZero`,
      })
    })

  parentCmd.command('doublezero:disconnect')
    .description(`🔌 Disconnect ${label} from DoubleZero`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .action(async (options) => {
      await runDoubleZeroPlaybook({
        role,
        network: options.network,
        playbook: 'doublezero_disconnect.yml',
        pubkey: options.pubkey,
        successMessage: `✅ Successfully Disconnected ${label} from DoubleZero`,
      })
    })

  parentCmd.command('doublezero:start')
    .description(`🟢 Start DoubleZero daemon on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .action(async (options) => {
      await runDoubleZeroPlaybook({
        role,
        network: options.network,
        playbook: 'doublezero_start.yml',
        pubkey: options.pubkey,
        successMessage: `✅ Successfully Started DoubleZero on ${label}`,
      })
    })

  parentCmd.command('doublezero:stop')
    .description(`🔴 Stop DoubleZero daemon on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .action(async (options) => {
      await runDoubleZeroPlaybook({
        role,
        network: options.network,
        playbook: 'doublezero_stop.yml',
        pubkey: options.pubkey,
        successMessage: `✅ Successfully Stopped DoubleZero on ${label}`,
      })
    })

  parentCmd.command('doublezero:status')
    .description(`📡 Check DoubleZero status on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option('-e, --env <env>', 'DoubleZero environment override')
    .action(async (options) => {
      const network = resolveDoubleZeroNetwork(options.network)
      await runDoubleZeroPlaybook({
        role,
        network,
        playbook: 'doublezero_status.yml',
        pubkey: options.pubkey,
        extraVars: {
          doublezero_env: options.env || getDoubleZeroEnvironment(network),
        },
        successMessage: `✅ Successfully Checked DoubleZero status on ${label}`,
      })
    })

  parentCmd.command('doublezero:update')
    .description(`🔄 Update DoubleZero package on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .action(async (options) => {
      await runDoubleZeroPlaybook({
        role,
        network: options.network,
        playbook: 'doublezero_update.yml',
        pubkey: options.pubkey,
        successMessage: `✅ Successfully Updated DoubleZero on ${label}`,
      })
    })

  parentCmd.command('doublezero:publish')
    .description(`📣 Publish shreds via DoubleZero multicast on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option('--provider <provider>', 'DoubleZero connect provider', {
      default: DEFAULT_DOUBLEZERO_PROVIDER,
    })
    .option('--feed <feed>', 'DoubleZero multicast feed', {
      default: DEFAULT_DOUBLEZERO_FEED,
    })
    .action(async (options) => {
      await runDoubleZeroPlaybook({
        role,
        network: options.network,
        playbook: 'doublezero_publish.yml',
        pubkey: options.pubkey,
        extraVars: {
          doublezero_connect_provider: options.provider,
          doublezero_publish_feed: options.feed,
        },
        successMessage:
          `✅ Successfully Started DoubleZero multicast publishing on ${label}`,
      })
    })

  parentCmd.command('doublezero:deposit')
    .description(`💰 Deposit validator rewards fund via DoubleZero on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option('-e, --env <env>', 'DoubleZero environment override')
    .option('-f, --fund <fund>', 'Deposit fund amount', {
      default: '3',
    })
    .option('-k, --keypair <keypair>', 'Remote keypair path')
    .action(async (options) => {
      const network = resolveDoubleZeroNetwork(options.network)
      await runDoubleZeroPlaybook({
        role,
        network,
        playbook: 'doublezero_deposit.yml',
        pubkey: options.pubkey,
        extraVars: {
          doublezero_env: options.env || getDoubleZeroEnvironment(network),
          doublezero_deposit_fund: options.fund,
          doublezero_keypair_path: options.keypair ||
            getDefaultDoubleZeroKeypairPath(role, network),
        },
        successMessage: `✅ Successfully Deposited via DoubleZero on ${label}`,
      })
    })

  parentCmd.command('doublezero:withdraw')
    .description(`🏧 Withdraw validator rewards via DoubleZero on ${label}`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option('-e, --env <env>', 'DoubleZero environment override')
    .option('-k, --keypair <keypair>', 'Remote keypair path')
    .option(
      '-s, --subcommand <subcommand>',
      'Revenue distribution withdraw subcommand',
      {
        default: 'validator-withdraw',
      },
    )
    .option('--args <args>', 'Additional withdraw arguments', {
      default: '',
    })
    .action(async (options) => {
      const network = resolveDoubleZeroNetwork(options.network)
      await runDoubleZeroPlaybook({
        role,
        network,
        playbook: 'doublezero_withdraw.yml',
        pubkey: options.pubkey,
        extraVars: {
          doublezero_env: options.env || getDoubleZeroEnvironment(network),
          doublezero_keypair_path: options.keypair ||
            getDefaultDoubleZeroKeypairPath(role, network),
          doublezero_withdraw_subcommand: options.subcommand,
          doublezero_withdraw_args: options.args,
        },
        successMessage: `✅ Successfully Ran DoubleZero withdraw on ${label}`,
      })
    })
}
