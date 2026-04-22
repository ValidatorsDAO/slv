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

type InstallResult =
  | { state: 'installed' }
  | { state: 'already_exists' }
  | { state: 'needs_sudo'; stderr: string } // user must re-run from TTY
  | { state: 'failed'; err: string }

const installSystemdUnit = async (
  serviceName: string,
  unitContent: string,
): Promise<InstallResult> => {
  const unitPath = `/etc/systemd/system/${serviceName}.service`
  try {
    const st = await Deno.stat(unitPath)
    if (st.isFile) return { state: 'already_exists' }
  } catch { /* missing — install below */ }

  console.log(colors.cyan(`⚙️ Installing systemd unit at ${unitPath} ...`))

  // Probe whether we can sudo non-interactively. We use `sudo -n true`
  // (not `sudo -n -v`) — `-v` refreshes the credential cache and in
  // some sudo builds still prompts even when a NOPASSWD rule exists for
  // the user, so it fails FALSELY under `slv onboard`-installed
  // NOPASSWD. `sudo -n true` just tests "can I run ANY command without
  // a prompt" which is exactly what we need before the install /
  // daemon-reload / enable chain below. When this fails we report
  // `needs_sudo` so the caller can still save the config + report a
  // partial-but-usable build outcome.
  const probeSudo = new Deno.Command('sudo', {
    args: ['-n', 'true'],
    stdout: 'piped',
    stderr: 'piped',
  })
  const probed = await probeSudo.output()
  if (!probed.success) {
    return {
      state: 'needs_sudo',
      stderr: new TextDecoder().decode(probed.stderr).trim(),
    }
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
      return {
        state: 'failed',
        err: `sudo mv ${tmpPath} ${unitPath}: ${
          new TextDecoder().decode(mvOut.stderr).trim()
        }`,
      }
    }
  } catch (err) {
    return { state: 'failed', err: errToString(err) }
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
    return {
      state: 'failed',
      err: `systemctl daemon-reload: ${
        new TextDecoder().decode(reloadOut.stderr).trim()
      }`,
    }
  }

  const enable = new Deno.Command('sudo', {
    args: ['systemctl', 'enable', serviceName],
    stdout: 'piped',
    stderr: 'piped',
  })
  const enableOut = await enable.output()
  if (!enableOut.success) {
    return {
      state: 'failed',
      err: `systemctl enable: ${
        new TextDecoder().decode(enableOut.stderr).trim()
      }`,
    }
  }

  return { state: 'installed' }
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
  const install = await installSystemdUnit(config.serviceName, unitContent)

  // Save the config regardless of systemd outcome — the binary IS built and
  // usable. The config lets `slv bot start`/`stop` find it later.
  await saveBotConfig(config)

  if (install.state === 'already_exists') {
    console.log(
      colors.cyan(
        `ℹ️ Systemd unit already exists at /etc/systemd/system/${config.serviceName}.service — keeping it`,
      ),
    )
    console.log(
      colors.green(
        `\n🎉 Build complete. Run: slv bot start -n ${config.name}`,
      ),
    )
    return true
  }

  if (install.state === 'installed') {
    console.log(colors.green('✅ Systemd unit installed'))
    console.log(
      colors.green(
        `\n🎉 Build complete. Run: slv bot start -n ${config.name}`,
      ),
    )
    return true
  }

  if (install.state === 'needs_sudo') {
    // Partial success: binary built + config saved, but systemd install
    // skipped because sudo couldn't authenticate non-interactively (likely
    // invoked via `slv c` with no TTY). Tell the user exactly how to
    // finish, and return true so the AI's run_command sees the build as
    // a usable partial result rather than a hard failure.
    console.log(colors.yellow('\n⚠️ Systemd unit install skipped.'))
    if (install.stderr) console.log(colors.gray(`   ${install.stderr}`))
    console.log(
      colors.white(
        '   sudo could not authenticate (no TTY under `slv c`). The binary\n' +
          `   is built at ${binaryPath} and the config is saved.\n` +
          '   To finish installing the systemd service, open a regular terminal and run:\n\n' +
          `     slv bot build -n ${config.name} -p ${localPath}\n`,
      ),
    )
    return true
  }

  // install.state === 'failed'
  console.log(colors.red('❌ Failed to install systemd unit'))
  console.log(colors.yellow(`   ${install.err}`))
  console.log(
    colors.white(
      `   Binary is built at ${binaryPath} and config is saved.\n` +
        '   You can retry systemd install by re-running `slv bot build`.',
    ),
  )
  return false
}

export { buildAction }
