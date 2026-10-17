import type { Command } from '@cliffy'
import { checkKey } from '/src/validator/keys/checkKey.ts'
import { genKey } from '/src/validator/keys/genKey.ts'
import { importKey } from '/src/validator/keys/importKey.ts'
import { pinHost } from '/src/validator/keys/pinHost.ts'
import { tryKey } from '/src/validator/keys/tryKey.ts'

/** Adds keys:gen, keys:import, keys:check, keys:try and hosts:pin to a command. */
const registerKeylessCommands = (parentCmd: Command): void => {
  parentCmd.command('keys:gen')
    .description(
      '🔑 Make a throwaway testnet identity in 1Password (the key never touches a disk or a log)',
    )
    .option('-n, --network <network>', 'Solana Network (testnet or devnet)', {
      default: 'testnet',
    })
    .option('--title <title>', 'Title of the 1Password item.')
    .action(async (options) => {
      await genKey({ network: options.network, title: options.title })
    })

  parentCmd.command('keys:import')
    .description(
      '📥 Put the key file of a validator into 1Password and point the inventory at the item (the key file is not removed)',
    )
    .option('-n, --network <network>', 'Solana Network (testnet or mainnet)', {
      default: 'testnet',
    })
    .option('-p, --pubkey <pubkey>', 'Inventory name of the node.')
    .option(
      '--file <file>',
      'The key file. Default: ~/.slv/keys/<identity_account>.json',
    )
    .action(async (options) => {
      await importKey({
        network: options.network,
        host: options.pubkey,
        file: options.file,
      })
    })

  parentCmd.command('keys:check')
    .description(
      '🔍 Read a key from its reference and show its public key (no node is touched)',
    )
    .option('-n, --network <network>', 'Solana Network', {
      default: 'testnet',
    })
    .option(
      '--ref <ref>',
      'Reference of the key: op://<vault id>/<item id>/keypair',
    )
    .option('--pubkey <pubkey>', 'The public key that the key has to have.')
    .action(async (options) => {
      await checkKey({
        network: options.network,
        ref: options.ref,
        pubkey: options.pubkey,
      })
    })

  parentCmd.command('keys:try')
    .description(
      '🧪 Put a throwaway identity on a testnet node for a moment, then put the node back on its unstaked identity',
    )
    .option('-n, --network <network>', 'Solana Network (testnet)', {
      default: 'testnet',
    })
    .option('-p, --pubkey <pubkey>', 'Inventory name of the node.')
    .option(
      '--ref <ref>',
      'Reference of the key: op://<vault id>/<item id>/keypair',
    )
    .action(async (options) => {
      await tryKey({
        network: options.network,
        host: options.pubkey,
        ref: options.ref,
      })
    })

  parentCmd.command('hosts:pin')
    .description(
      '📌 Trust the ssh key of a node: show its fingerprint and pin it after you type yes',
    )
    .option('-n, --network <network>', 'Solana Network (testnet or mainnet)', {
      default: 'testnet',
    })
    .option('-p, --pubkey <pubkey>', 'Inventory name of the node.')
    .action(async (options) => {
      await pinHost({ network: options.network, host: options.pubkey })
    })
}

export { registerKeylessCommands }
