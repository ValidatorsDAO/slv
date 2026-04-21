import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { runSystemctl } from '/src/bot/execUtil.ts'
import { isLocalNonSystemd, stopLocalProc } from '/src/bot/localProc.ts'

const stopAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`🛑 Stopping bot: ${config.name}...`))

  if (isLocalNonSystemd(config)) {
    const r = await stopLocalProc(config)
    if (!r.ok) {
      console.log(colors.red(`❌ Failed to stop ${config.name}`))
      console.log(colors.yellow(r.err))
      return false
    }
    console.log(
      colors.green(`✅ Bot "${config.name}" stopped (pid=${r.pid})`),
    )
    return true
  }

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
