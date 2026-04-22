import { colors } from '@cliffy/colors'
import {
  gatewayErrLogPath,
  gatewayLogPath,
} from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'

export const logsAction = async (
  opts: { follow?: boolean; lines?: number },
): Promise<boolean> => {
  const lines = opts.lines ?? 100
  const args: string[] = ['-n', String(lines)]
  if (opts.follow) args.push('-F')
  // Feed BOTH log files to tail so stdout + stderr are interleaved.
  // If either doesn't exist yet, create an empty one so `tail` doesn't
  // error out — on a fresh install the service may not have produced
  // output yet.
  for (const path of [gatewayLogPath, gatewayErrLogPath]) {
    await Deno.writeTextFile(path, '', { append: true }).catch(() => {})
  }
  args.push(gatewayLogPath, gatewayErrLogPath)

  console.log(
    colors.gray(
      `# tailing ${gatewayLogPath} + ${gatewayErrLogPath} (last ${lines} lines${
        opts.follow ? ', follow' : ''
      })`,
    ),
  )
  try {
    const child = new Deno.Command('tail', {
      args,
      stdin: 'null',
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn()
    // Forward Ctrl+C through to tail so the user can quit cleanly.
    const onSigint = () => {
      try {
        child.kill('SIGINT')
      } catch { /* already gone */ }
    }
    Deno.addSignalListener('SIGINT', onSigint)
    try {
      const status = await child.status
      return status.success
    } finally {
      try {
        Deno.removeSignalListener('SIGINT', onSigint)
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error(colors.red(`❌ tail failed: ${errToString(err)}`))
    return false
  }
}
