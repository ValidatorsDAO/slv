import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { buildRemoteCmd, sshExec } from '/src/bot/sshUtil.ts'

const restartAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`🔄 Restarting bot: ${config.name}...`))
  const result = await sshExec(
    config,
    buildRemoteCmd('sudo', 'systemctl', 'restart', config.serviceName),
  )
  if (!result.success) {
    console.log(colors.red(`❌ Failed to restart ${config.name}`))
    if (result.stderr) console.log(colors.yellow(result.stderr))
    return false
  }
  console.log(colors.green(`✅ Bot "${config.name}" restarted`))
  return true
}

export { restartAction }
