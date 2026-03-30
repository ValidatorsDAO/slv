import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { shellQuote, sshExec, testSSHConnection } from '/src/bot/sshUtil.ts'

const logAction = async (options: { name?: string; lines?: number }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  const lines = options.lines ?? 100
  console.log(
    colors.cyan(`📜 Fetching logs: ${config.name} (last ${lines} lines)...`),
  )

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
    `journalctl -u ${shellQuote(config.serviceName)} -n ${shellQuote(String(lines))} --no-pager`,
  )

  // journalctl may return non-zero if the unit has no logs yet — show output regardless
  const output = result.stdout || result.stderr
  if (output) {
    console.log(output)
  }
  return true
}

export { logAction }
