import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { buildRemoteCmd, sshExec, testSSHConnection } from '/src/bot/sshUtil.ts'

const statusAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`📊 Checking status: ${config.name}...`))

  // Test SSH connectivity first
  const connected = await testSSHConnection(config)
  if (!connected) {
    console.log(
      colors.red(
        `❌ SSH connection failed to ${config.username}@${config.ip}`,
      ),
    )
    return false
  }

  const result = await sshExec(
    config,
    buildRemoteCmd('systemctl', 'status', config.serviceName),
  )

  // systemctl status returns non-zero for inactive/dead services — that's not an error
  const output = result.stdout || result.stderr
  if (output) {
    console.log(colors.white(output))
  }
  return true
}

export { statusAction }
