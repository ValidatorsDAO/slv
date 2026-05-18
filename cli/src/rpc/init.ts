import { prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { listAction } from '/src/metal/list/listAction.ts'
import { configRoot } from '@cmn/constants/path.ts'
import denoJson from '/deno.json' with { type: 'json' }
import { copy, exists } from '@std/fs'
import { join } from '@std/path'
import { mainnetInitRpc } from '/src/rpc/init/mainnetInitRpc.ts'
import { devnetInitRpc } from '/src/rpc/init/devnetInitRpc.ts'
import { testnetInitRpc } from '/src/rpc/init/testnetInitRpc.ts'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { getLocalConnection } from '@cmn/prompt/localConnection.ts'

export async function copyTemplateDirs() {
  const templateBase = join(configRoot, 'template', denoJson.version, 'jinja')

  // Skip if template directory does not exist (e.g. templates not yet downloaded)
  if (!await exists(templateBase)) {
    console.log(
      colors.yellow(
        `⚠️ Template directory not found: ${templateBase}\n` +
        `   Run \`slv upgrade\` to download the latest templates.`,
      ),
    )
    return
  }

  const pairs = [
    ['testnet-rpc', 'testnet-rpc'],
    ['testnet-validator', 'testnet-validator'],
    ['devnet-rpc', 'devnet-rpc'],
    ['mainnet-rpc', 'mainnet-rpc'],
    ['mainnet-validator', 'mainnet-validator'],
    ['mainnet-hermes', 'mainnet-hermes'],
    ['mainnet-pythnet', 'mainnet-pythnet'],
    ['cmn', 'cmn'],
  ] as const
  await Promise.all(
    pairs.map(([srcName, destName]) => {
      Deno.mkdir(join(configRoot, destName), { recursive: true })
      Deno.mkdir(join(configRoot, srcName), { recursive: true })
    }),
  )
  await Promise.all(
    pairs.map(([srcName, destName]) =>
      copy(
        join(templateBase, srcName),
        join(configRoot, destName),
        { overwrite: true },
      )
    ),
  )
}

const init = async (options?: { localhost?: boolean }) => {
  await copyTemplateDirs()
  const { network } = await prompt([
    {
      name: 'network',
      message: 'Select Solana Network',
      type: Select,
      options: ['testnet', 'devnet', 'mainnet'],
      default: 'testnet',
    },
  ])
  if (!network) {
    console.log(colors.red('❌ Network selection is required'))
    return
  }

  let sshOptions
  if (options?.localhost) {
    sshOptions = getLocalConnection()
    console.log(colors.green('🏠 Localhost mode — skipping SSH connection'))
  } else {
    const hasBareMetal = await prompt([{
      name: 'bareMetal',
      message: '🛡️ Do you have a Solana Node Compatabile Server?',
      type: Select,
      options: ['yes', 'no'],
      default: 'no',
    }])
    if (hasBareMetal.bareMetal === 'no') {
      console.log(
        colors.red(
          '⚠️ You need a Solana Node Compatabile High Performance Server to Run a RPC Node',
        ),
      )
      console.log(colors.green('🟢 You can get one from the following list:'))
      await listAction('RPC')
      return
    }
    const result = await checkSSHConnection()
    if (!result) {
      console.error(colors.red('❌ SSH connection failed'))
      return
    }
    sshOptions = result
  }

  switch (network) {
    case 'testnet':
      return await testnetInitRpc(sshOptions, options?.localhost)
    case 'devnet':
      return await devnetInitRpc(sshOptions, options?.localhost)
    case 'mainnet':
      return await mainnetInitRpc(sshOptions, options?.localhost)
    default:
      console.log(colors.red('❌ Invalid network selection'))
      return
  }
}

export { init }
