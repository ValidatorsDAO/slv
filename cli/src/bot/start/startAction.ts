import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { runSystemctl } from '/src/bot/execUtil.ts'

const startAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`🚀 Starting bot: ${config.name}...`))
  const result = await runSystemctl(config, 'start', config.serviceName)
  if (!result.success) {
    console.log(colors.red(`❌ Failed to start ${config.name}`))
    if (result.stderr) console.log(colors.yellow(result.stderr))
    return false
  }
  console.log(colors.green(`✅ Bot "${config.name}" started`))
  return true
}

export { startAction }
