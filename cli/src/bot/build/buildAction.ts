import { Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { loadBotConfig, saveBotConfig } from '/src/bot/botConfig.ts'
import type { BotConfig } from '@cmn/zod/bot.ts'
import { renderSystemdUnit, validateAppName } from '/src/bot/systemdUnit.ts'

const errToString = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

// True only when stdin is a real terminal the user can type into. When
// `slv bot build` is spawned by `slv c`'s run_command tool (stdin: 'null'),
// or piped from any automation, prompting would block forever — fail fast
// with a usage hint instead. Deno.stdin.isTerminal was added in 1.40.
const stdinIsInteractive = (): boolean => {
  try {
    return Deno.stdin.isTerminal()
  } catch {
    return false
  }
}

const resolveAppName = async (provided?: string): Promise<string | null> => {
  if (provided) {
    const err = validateAppName(provided)
    if (err) {
      console.log(colors.red(`❌ ${err}`))
      return null
    }
    return provided
  }
  if (!stdinIsInteractive()) {
    console.log(
      colors.red(
        '❌ --name is required when stdin is not a terminal. ' +
          'Re-run as: slv bot build -n <name> -p <path>',
      ),
    )
    return null
  }
  const { appName } = await prompt([
    {
      name: 'appName',
      message: '🤖 Enter bot app name',
      type: Input,
      validate: (v: string) => validateAppName(v) ?? true,
    },
  ])
  return appName ?? null
}

const resolveLocalPath = async (
  appName: string,
  provided?: string,
): Promise<string | null> => {
  if (provided) return provided
  const homeDir = Deno.env.get('HOME') ?? '.'
  if (!stdinIsInteractive()) {
    // Non-interactive: use the conventional default silently instead of
    // hanging on prompt. Callers that need a different path must pass -p.
    return `${homeDir}/slv/${appName}`
  }
  const { localPath } = await prompt([
    {
      name: 'localPath',
      message: '📁 Local Rust project path',
      type: Input,
      default: `${homeDir}/slv/${appName}`,
    },
  ])
  return localPath ?? null
}

const installSystemdUnit = async (
  serviceName: string,
  unitContent: string,
): Promise<boolean> => {
  const unitPath = `/etc/systemd/system/${serviceName}.service`
  try {
    const st = await Deno.stat(unitPath)
    if (st.isFile) {
      console.log(
        colors.cyan(
          `ℹ️ Systemd unit already exists at ${unitPath} — keeping it`,
        ),
      )
      return true
    }
  } catch { /* missing — install below */ }

  console.log(colors.cyan(`⚙️ Installing systemd unit at ${unitPath} ...`))

  // Refresh the sudo credential cache so mv/daemon-reload/enable below don't
  // each trigger their own password prompt. `-n` forces non-interactive
  // mode: if the cache is empty and no NOPASSWD rule matches, sudo exits
  // non-zero IMMEDIATELY instead of blocking on a password read — critical
  // when invoked through `slv c`'s run_command (stdin: 'null'), which
  // would otherwise hang forever.
  const primeSudo = new Deno.Command('sudo', {
    args: ['-n', '-v'],
    stdout: 'piped',
    stderr: 'piped',
  })
  const primed = await primeSudo.output()
  if (!primed.success) {
    const stderr = new TextDecoder().decode(primed.stderr).trim()
    console.log(colors.red('❌ sudo authentication required'))
    if (stderr) console.log(colors.yellow(stderr))
    console.log(
      colors.white(
        '   Run `sudo -v` in a terminal to prime the credential cache, ' +
          'or rerun `slv bot build` from a real TTY.',
      ),
    )
    return false
  }

  const tmpPath = await Deno.makeTempFile({ suffix: '.service' })
  try {
    await Deno.writeTextFile(tmpPath, unitContent)
    const mv = new Deno.Command('sudo', {
      args: ['mv', tmpPath, unitPath],
      stdout: 'piped',
      stderr: 'piped',
    })
    const mvOut = await mv.output()
    if (!mvOut.success) {
      const err = new TextDecoder().decode(mvOut.stderr).trim()
      console.log(colors.red('❌ Failed to install systemd unit'))
      if (err) console.log(colors.yellow(err))
      return false
    }
  } catch (err) {
    console.log(
      colors.red(`❌ Failed to create systemd unit: ${errToString(err)}`),
    )
    return false
  } finally {
    await Deno.remove(tmpPath).catch(() => {})
  }

  const reload = new Deno.Command('sudo', {
    args: ['systemctl', 'daemon-reload'],
    stdout: 'piped',
    stderr: 'piped',
  })
  const reloadOut = await reload.output()
  if (!reloadOut.success) {
    const err = new TextDecoder().decode(reloadOut.stderr).trim()
    console.log(colors.red('❌ systemctl daemon-reload failed'))
    if (err) console.log(colors.yellow(err))
    return false
  }

  const enable = new Deno.Command('sudo', {
    args: ['systemctl', 'enable', serviceName],
    stdout: 'piped',
    stderr: 'piped',
  })
  const enableOut = await enable.output()
  if (!enableOut.success) {
    const err = new TextDecoder().decode(enableOut.stderr).trim()
    console.log(colors.red('❌ systemctl enable failed'))
    if (err) console.log(colors.yellow(err))
    return false
  }

  console.log(colors.green('✅ Systemd unit installed'))
  return true
}

const buildAction = async (
  options: { name?: string; path?: string },
): Promise<boolean> => {
  const appName = await resolveAppName(options.name)
  if (!appName) {
    console.log(colors.red('❌ App name is required'))
    return false
  }

  const localPath = await resolveLocalPath(appName, options.path)
  if (!localPath) {
    console.log(colors.red('❌ Local project path is required'))
    return false
  }

  console.log(
    colors.cyan(`\n🔨 Building (cargo build --release) in ${localPath} ...`),
  )
  const buildCmd = new Deno.Command('cargo', {
    args: ['build', '--release'],
    cwd: localPath,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const buildOut = await buildCmd.output()
  if (!buildOut.success) {
    console.log(colors.red('❌ Build failed'))
    return false
  }
  console.log(colors.green('✅ Build succeeded'))

  // cargo exits 0 only if the declared bin built; this check catches the case
  // where Cargo.toml's package/[[bin]] name diverges from appName.
  const binaryPath = `${localPath}/target/release/${appName}`
  try {
    await Deno.stat(binaryPath)
  } catch {
    console.log(colors.red(`❌ Built binary not found at ${binaryPath}`))
    console.log(
      colors.white(
        `   (check Cargo.toml — the binary name must match the app name)`,
      ),
    )
    return false
  }

  const existing = await loadBotConfig(appName)
  const username = existing?.username ?? Deno.env.get('USER') ?? 'solv'
  const config: BotConfig = {
    ...existing,
    name: appName,
    ip: 'localhost',
    username,
    sshKeyPath: existing?.sshKeyPath ?? '',
    binaryName: appName,
    remotePath: localPath,
    serviceName: existing?.serviceName ?? `slv-${appName}`,
    localProjectPath: localPath,
    deployedAt: new Date().toISOString(),
  }

  if (Deno.build.os !== 'linux') {
    console.log(
      colors.yellow(
        `⚠️ Host is ${Deno.build.os}; skipping systemd unit creation.`,
      ),
    )
    console.log(colors.white(`   Binary: ${binaryPath}`))
    await saveBotConfig(config)
    console.log(colors.green(`\n✅ Config saved (${config.name})`))
    return true
  }

  const unitContent = renderSystemdUnit({
    name: appName,
    username,
    workDir: localPath,
    execStart: binaryPath,
  })
  const ok = await installSystemdUnit(config.serviceName, unitContent)
  if (!ok) return false

  await saveBotConfig(config)
  console.log(
    colors.green(
      `\n🎉 Build complete. Run: slv bot start -n ${config.name}`,
    ),
  )
  return true
}

export { buildAction }
