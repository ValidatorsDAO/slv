import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { runSystemctl } from '/src/bot/execUtil.ts'
import { isLocalNonSystemd, startLocalProc } from '/src/bot/localProc.ts'

const startAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`🚀 Starting bot: ${config.name}...`))

  if (isLocalNonSystemd(config)) {
    const r = await startLocalProc(config)
    if (!r.ok) {
      console.log(colors.red(`❌ Failed to start ${config.name}`))
      console.log(colors.yellow(r.err))
      return false
    }
    console.log(
      colors.green(`✅ Bot "${config.name}" started (pid=${r.pid})`),
    )
    return true
  }

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
