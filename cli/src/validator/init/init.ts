import { prompt, Select } from '@cliffy/prompt'
import { initMainnetConfig } from '/src/validator/init/initMainnetConfig.ts'
import { initTestnetConfig } from '/src/validator/init/initTestnetConfig.ts'
import { genPasswordYml } from '/lib/genPasswordYml.ts'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { colors } from '@cliffy/colors'
import { listAction } from '/src/metal/list/listAction.ts'

const init = async () => {
  const validator = await prompt([
    {
      name: 'network',
      message: 'Select Solana Network',
      type: Select,
      options: ['testnet', 'mainnet'],
      default: 'testnet',
    },
  ])
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
  const ubuntu = await checkSSHConnection()
  if (!ubuntu) {
    console.error(colors.red('❌ SSH connection failed'))
    return
  }
  // Set solv password if not exists
  await genPasswordYml()
  if (validator.network === 'testnet') {
    await initTestnetConfig(ubuntu)
  } else {
    await initMainnetConfig(ubuntu)
  }
}

export { init }
