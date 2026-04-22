import { colors } from '@cliffy/colors'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import {
  gatewayErrLogPath,
  gatewayLogDir,
  gatewayLogPath,
} from '/src/gateway/paths.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Find the absolute path to the `slv` binary so we can put it in the
 * service unit's ExecStart / ProgramArguments. Three cases:
 *
 *   1. Compiled `slv` binary on PATH — Deno.execPath() returns the
 *      slv binary itself. Use it directly.
 *   2. `deno run -A src/index.ts gateway run` (dev mode) —
 *      Deno.execPath() returns the `deno` binary, and we need to
 *      reconstruct the full `deno run` invocation.
 *   3. Compiled binary NOT on PATH — user installed somewhere
 *      non-standard. We refuse to install rather than guess.
 */
const resolveExec = async (): Promise<
  { execPath: string; execArgs: string[] }
> => {
  const exec = Deno.execPath()
  const basename = exec.split('/').pop() ?? ''
  // Case 1: compiled slv binary — execPath ends with 'slv' (or
  // 'slv.exe'; not supported today but future-proofed).
  if (basename === 'slv' || basename === 'slv.exe') {
    return { execPath: exec, execArgs: ['gateway', 'run'] }
  }
  // Case 2: dev mode — Deno.execPath is `deno`, so we need the
  // script path too. Prefer an installed `slv` on PATH; if none,
  // refuse with a clear message.
  const which = new Deno.Command('sh', {
    args: ['-c', 'command -v slv'],
    stdout: 'piped',
    stderr: 'null',
  })
  const out = await which.output()
  if (out.success) {
    const path = new TextDecoder().decode(out.stdout).trim()
    if (path) return { execPath: path, execArgs: ['gateway', 'run'] }
  }
  throw new Error(
    `Cannot locate an 'slv' binary to put in the service ExecStart.\n` +
      `Install slv onto PATH first (so 'which slv' resolves), or run the gateway\n` +
      `manually with 'slv gateway run' instead of using the daemon wrappers.`,
  )
}

export const installAction = async (): Promise<boolean> => {
  let service
  try {
    service = pickGatewayService()
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }

  let exec
  try {
    exec = await resolveExec()
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }

  // Create log dir with parents so the service unit's append: path
  // never fails on missing directory.
  await Deno.mkdir(gatewayLogDir, { recursive: true })
  // Touch log files so `slv gateway logs` doesn't fail with "file
  // not found" before the service has written its first line.
  await Deno.writeTextFile(gatewayLogPath, '', { append: true }).catch(() => {})
  await Deno.writeTextFile(gatewayErrLogPath, '', { append: true }).catch(() => {})

  console.log(colors.cyan(`⚙️  Installing ${service.name} unit...`))
  console.log(colors.gray(`    ExecStart: ${exec.execPath} ${exec.execArgs.join(' ')}`))
  console.log(colors.gray(`    stdout:    ${gatewayLogPath}`))
  console.log(colors.gray(`    stderr:    ${gatewayErrLogPath}`))

  try {
    await service.install({
      execPath: exec.execPath,
      execArgs: exec.execArgs,
      stdoutLog: gatewayLogPath,
      stderrLog: gatewayErrLogPath,
    })
  } catch (err) {
    console.error(colors.red(`❌ install failed: ${errToString(err)}`))
    return false
  }

  console.log(colors.green('✅ gateway service installed and enabled'))
  console.log(colors.gray(`    start:  slv gateway start`))
  console.log(colors.gray(`    status: slv gateway status`))
  console.log(colors.gray(`    logs:   slv gateway logs -f`))
  return true
}

export const uninstallAction = async (): Promise<boolean> => {
  let service
  try {
    service = pickGatewayService()
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }
  console.log(colors.cyan(`⚙️  Uninstalling ${service.name} unit...`))
  try {
    await service.uninstall()
  } catch (err) {
    console.error(colors.red(`❌ uninstall failed: ${errToString(err)}`))
    return false
  }
  console.log(colors.green('✅ gateway service uninstalled'))
  console.log(
    colors.gray(`    (logs at ${gatewayLogPath} were kept for reference)`),
  )
  return true
}
