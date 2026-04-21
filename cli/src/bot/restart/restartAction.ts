import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { runSystemctl } from '/src/bot/execUtil.ts'
import {
  isLocalNonSystemd,
  startLocalProc,
  stopLocalProc,
} from '/src/bot/localProc.ts'

const restartAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`🔄 Restarting bot: ${config.name}...`))

  if (isLocalNonSystemd(config)) {
    // Best-effort stop: a missing pidfile is fine (treat as already stopped).
    const stopped = await stopLocalProc(config)
    if (!stopped.ok && !stopped.err.includes('no pidfile')) {
      console.log(colors.yellow(`⚠️ stop: ${stopped.err}`))
    }
    const started = await startLocalProc(config)
    if (!started.ok) {
      console.log(colors.red(`❌ Failed to restart ${config.name}`))
      console.log(colors.yellow(started.err))
      return false
    }
    console.log(
      colors.green(`✅ Bot "${config.name}" restarted (pid=${started.pid})`),
    )
    return true
  }

  const result = await runSystemctl(config, 'restart', config.serviceName)
  if (!result.success) {
    console.log(colors.red(`❌ Failed to restart ${config.name}`))
    if (result.stderr) console.log(colors.yellow(result.stderr))
    return false
  }
  console.log(colors.green(`✅ Bot "${config.name}" restarted`))
  return true
}

export { restartAction }
