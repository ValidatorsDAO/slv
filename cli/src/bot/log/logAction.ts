import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { ensureConnectivity, runJournalctl } from '/src/bot/execUtil.ts'
import { isLocalNonSystemd, tailLocalLog } from '/src/bot/localProc.ts'

const logAction = async (options: { name?: string; lines?: number }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  const lines = options.lines ?? 100
  console.log(
    colors.cyan(`📜 Fetching logs: ${config.name} (last ${lines} lines)...`),
  )

  if (isLocalNonSystemd(config)) {
    const text = await tailLocalLog(config, lines)
    if (text) console.log(text)
    return true
  }

  if (!(await ensureConnectivity(config))) return false

  const result = await runJournalctl(config, lines)

  // journalctl may return non-zero if the unit has no logs yet — show output regardless
  const output = result.stdout || result.stderr
  if (output) {
    console.log(output)
  }
  return true
}

export { logAction }
