import { prompt, Select } from '@cliffy/prompt'
import { initMainnetConfig } from '/src/validator/init/initMainnetConfig.ts'
import { initTestnetConfig } from '/src/validator/init/initTestnetConfig.ts'
import { genPasswordYml } from '/lib/genPasswordYml.ts'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { getLocalConnection } from '@cmn/prompt/localConnection.ts'
import { colors } from '@cliffy/colors'
import { listAction } from '/src/metal/list/listAction.ts'

const init = async (options?: { localhost?: boolean }) => {
  const validator = await prompt([
    {
      name: 'network',
      message: 'Select Solana Network',
      type: Select,
      options: ['testnet', 'mainnet'],
      default: 'testnet',
    },
  ])

  let ubuntu
  if (options?.localhost) {
    ubuntu = getLocalConnection()
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
          '⚠️ You need a Solana Node Compatabile High Performance Server to Run a Validator',
        ),
      )
      console.log(colors.green('🟢 You can get one from the following list:'))
      const network = validator.network
      const networkType = network === 'testnet' ? 'APP' : 'MV'
      await listAction(networkType)
      return
    }
    const sshResult = await checkSSHConnection()
    if (!sshResult) {
      console.error(colors.red('❌ SSH connection failed'))
      return
    }
    ubuntu = sshResult
  }

  // Set solv password if not exists
  await genPasswordYml()
  if (validator.network === 'testnet') {
    await initTestnetConfig(ubuntu, options?.localhost)
  } else {
    await initMainnetConfig(ubuntu, options?.localhost)
  }
}

export { init }
