import { colors } from '@cliffy/colors'
import { selectBot } from '/src/bot/selectBot.ts'
import { ensureConnectivity, runSystemctlStatus } from '/src/bot/execUtil.ts'
import { isLocalNonSystemd, statusLocalProc } from '/src/bot/localProc.ts'

const statusAction = async (options: { name?: string }) => {
  const config = await selectBot(options.name)
  if (!config) return false

  console.log(colors.cyan(`📊 Checking status: ${config.name}...`))

  if (isLocalNonSystemd(config)) {
    console.log(colors.white(await statusLocalProc(config)))
    return true
  }

  if (!(await ensureConnectivity(config))) return false

  const result = await runSystemctlStatus(config)

  // systemctl status returns non-zero for inactive/dead services — that's not an error
  const output = result.stdout || result.stderr
  if (output) {
    console.log(colors.white(output))
  }
  return true
}

export { statusAction }
