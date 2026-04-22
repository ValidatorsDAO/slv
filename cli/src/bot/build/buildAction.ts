import { Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { loadBotConfig, saveBotConfig } from '/src/bot/botConfig.ts'
import type { BotConfig } from '@cmn/zod/bot.ts'
import { renderSystemdUnit, validateAppName } from '/src/bot/systemdUnit.ts'
import { errToString } from '/lib/errToString.ts'

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
    // Non-interactive: fall back to the conventional default rather than
    // hanging on prompt. Surface the choice so the user can see it in
    // `slv c` output — silent defaults drift from the system-prompt rule
    // that tells the AI to pass -p explicitly.
    const fallback = `${homeDir}/slv/${appName}`
    console.log(
      colors.yellow(
        `⚠️  --path not provided; using default ${fallback}. ` +
          'Pass -p <path> to override.',
      ),
    )
    return fallback
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

  // Probe whether we can sudo non-interactively. We use `sudo -n true`
  // (not `sudo -n -v`) — `-v` refreshes the credential cache and in some
  // sudo builds still prompts even when a NOPASSWD rule exists for the
  // user, so it fails FALSELY under `slv onboard`-installed NOPASSWD.
  // `sudo -n true` just tests "can I run ANY command without a prompt"
  // which is exactly what we need before the mv/daemon-reload/enable
  // chain below.
  const probeSudo = new Deno.Command('sudo', {
    args: ['-n', 'true'],
    stdout: 'piped',
    stderr: 'piped',
  })
  const probed = await probeSudo.output()
  if (!probed.success) {
    const stderr = new TextDecoder().decode(probed.stderr).trim()
    console.log(colors.red('❌ sudo authentication required'))
    if (stderr) console.log(colors.yellow(stderr))
    const requiresTty = /\btty\b|\bterminal\b/i.test(stderr)
    console.log(
      colors.white(
        requiresTty
          ? '   sudoers requires a TTY. Run `slv bot build` from a real\n' +
            '   terminal instead of via `slv c`.'
          : '   Options:\n' +
            '   • Run `slv onboard` once to install passwordless sudo on this\n' +
            '     machine (recommended for dedicated dev VPS).\n' +
            '   • Or run `sudo -v` in a terminal to prime the credential\n' +
            '     cache, then retry.\n' +
            '   • Or run `slv bot build` directly from a terminal (not via\n' +
            '     `slv c`).',
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
