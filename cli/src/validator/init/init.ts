import { prompt, Select } from '@cliffy/prompt'
import { initMainnetConfig } from '/src/validator/init/initMainnetConfig.ts'
import { initTestnetConfig } from '/src/validator/init/initTestnetConfig.ts'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { getLocalConnection } from '@cmn/prompt/localConnection.ts'
import { colors } from '@cliffy/colors'
import { refuseBelowFloorPins } from '/lib/versionFloor.ts'
import { assertValidatorInitInventory } from '/src/validator/init/inventory.ts'
import { verifyInitOnePassword } from '/src/validator/init/onePasswordReady.ts'
import {
  defaultSshIdentity,
  type InitConfigOptions,
} from '/src/validator/init/setupPlan.ts'

export type InitOptions = InitConfigOptions & {
  localhost?: boolean
  network?: string
  host?: string
  user?: string
  identityFile?: string
}

const init = async (options: InitOptions = {}) => {
  try {
    const network = options.network ?? (await prompt([{
      name: 'network',
      message: 'Select Solana Network',
      type: Select,
      options: ['testnet', 'mainnet'],
      default: 'testnet',
    }])).network
    if (network !== 'testnet' && network !== 'mainnet') {
      throw new Error('Choose testnet or mainnet.')
    }
    if (
      options.name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.name)
    ) {
      throw new Error(
        'Inventory names use letters, digits, dots, underscores or hyphens.',
      )
    }
    if (await refuseBelowFloorPins(network, 'validator')) return
    await assertValidatorInitInventory(network)
    console.log('Checking 1Password before server setup...')
    await verifyInitOnePassword(network)
    const connection = options.localhost
      ? getLocalConnection()
      : await checkSSHConnection({
        defaults: {
          ...(options.advanced ? {} : { username: 'ubuntu' }),
          ...(options.user ? { username: options.user } : {}),
          ...(options.host ? { ip: options.host } : {}),
          rsa_key_path: options.identityFile ??
            await defaultSshIdentity(Deno.env.get('HOME') ?? ''),
        },
        skipKnown: !options.advanced,
      })
    if (!connection) {
      Deno.exitCode = 1
      return
    }
    if (network === 'testnet') {
      await initTestnetConfig(connection, options.localhost, options)
    } else await initMainnetConfig(connection, options.localhost, options)
  } catch (error) {
    console.error(
      colors.red(
        `Setup stopped: ${
          error instanceof Error
            ? error.message
            : 'Unable to initialize the validator.'
        }`,
      ),
    )
    Deno.exitCode = 1
  }
}
export { init }
