import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { runSystemctl } from '/src/bot/execUtil.ts'

const stopAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`🛑 Stopping bot: ${config.name}...`))
  const result = await runSystemctl(config, 'stop', config.serviceName)
  if (!result.success) {
    console.log(colors.red(`❌ Failed to stop ${config.name}`))
    if (result.stderr) console.log(colors.yellow(result.stderr))
    return false
  }
  console.log(colors.green(`✅ Bot "${config.name}" stopped`))
  return true
}

export { stopAction }
