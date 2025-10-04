import { prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { listAction } from '/src/metal/list/listAction.ts'
import { configRoot } from '@cmn/constants/path.ts'
import denoJson from '/deno.json' with { type: 'json' }
import { copy } from '@std/fs'
import { join } from '@std/path'
import { mainnetInitRpc } from '/src/rpc/init/mainnetInitRpc.ts'
import { devnetInitRpc } from '/src/rpc/init/devnetInitRpc.ts'
import { testnetInitRpc } from '/src/rpc/init/testnetInitRpc.ts'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'

async function copyTemplateDirs() {
  const templateBase = join(configRoot, 'template', denoJson.version, 'jinja')
  const pairs = [
    ['testnet-rpc', 'testnet-rpc'],
    ['testnet-validator', 'testnet-validator'],
    ['devnet-rpc', 'devnet-rpc'],
    ['mainnet-rpc', 'mainnet-rpc'],
    ['mainnet-validator', 'mainnet-validator'],
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
        { overwrite: true }, // 上書き許可（元コードのcp -r相当の期待値）
      )
    ),
  )
}

const init = async () => {
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
  const sshOptions = await checkSSHConnection()
  if (!sshOptions) {
    console.error(colors.red('❌ SSH connection failed'))
    return
  }
  switch (network) {
    case 'testnet':
      return await testnetInitRpc(sshOptions)
    case 'devnet':
      return await devnetInitRpc(sshOptions)
    case 'mainnet':
      return await mainnetInitRpc(sshOptions)
    default:
      console.log(colors.red('❌ Invalid network selection'))
      return
  }
}

export { init }
