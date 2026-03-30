import { Confirm, Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { checkSSHConnection } from '@cmn/prompt/checkSSHConnection.ts'
import { saveBotConfig } from '/src/bot/botConfig.ts'
import type { BotConfig } from '@cmn/zod/bot.ts'
import {
  buildRemoteCmd,
  scpUpload,
  shellQuote,
  sshExec,
} from '/src/bot/sshUtil.ts'

const SYSTEMD_UNIT_TEMPLATE = (config: BotConfig) =>
  `[Unit]
Description=SLV Bot - ${config.name}
After=network.target

[Service]
Type=simple
User=${config.username}
WorkingDirectory=${config.remotePath}
ExecStart=${config.remotePath}/${config.binaryName}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=slv-${config.name}

[Install]
WantedBy=multi-user.target
`

const deployAction = async (options: { name?: string; localhost?: boolean }) => {
  // 1. App name
  const { appName } = await prompt([
    {
      name: 'appName',
      message: '🤖 Enter bot app name',
      type: Input,
      default: options.name,
    },
  ])
  if (!appName) {
    console.log(colors.red('❌ App name is required'))
    return false
  }

  // 2. Local project path
  const homeDir = Deno.env.get('HOME') ?? '.'
  const { localPath } = await prompt([
    {
      name: 'localPath',
      message: '📁 Local Rust project path',
      type: Input,
      default: `${homeDir}/slv/${appName}`,
    },
  ])
  if (!localPath) {
    console.log(colors.red('❌ Local project path is required'))
    return false
  }

  let config: BotConfig

  if (options.localhost) {
    // Localhost mode: no SSH required
    const username = Deno.env.get('USER') || 'solv'
    const remotePath = `/home/${username}/slv/${appName}`

    config = {
      name: appName,
      ip: 'localhost',
      username,
      sshKeyPath: '',
      binaryName: appName,
      remotePath,
      serviceName: `slv-${appName}`,
      localProjectPath: localPath,
      deployedAt: new Date().toISOString(),
    }
  } else {
    // 3. SSH connection
    console.log(colors.cyan('\n🔗 Configure SSH connection to deploy target'))
    const ssh = await checkSSHConnection()
    if (!ssh) return false

    // 4. Remote path
    const { remotePath } = await prompt([
      {
        name: 'remotePath',
        message: '📂 Remote binary path',
        type: Input,
        default: `/home/${ssh.username}/slv/${appName}`,
      },
    ])
    if (!remotePath) {
      console.log(colors.red('❌ Remote path is required'))
      return false
    }

    config = {
      name: appName,
      ip: ssh.ip,
      username: ssh.username,
      sshKeyPath: ssh.rsa_key_path,
      binaryName: appName,
      remotePath,
      serviceName: `slv-${appName}`,
      localProjectPath: localPath,
      deployedAt: new Date().toISOString(),
    }
  }

  // Confirm
  console.log(colors.white('\n📋 Deploy configuration:'))
  console.log(colors.white(`  Name:         ${config.name}`))
  console.log(colors.white(`  Local:        ${config.localProjectPath}`))
  if (options.localhost) {
    console.log(
      colors.white(`  Target:       localhost:${config.remotePath}`),
    )
  } else {
    console.log(
      colors.white(
        `  Remote:       ${config.username}@${config.ip}:${config.remotePath}`,
      ),
    )
  }
  console.log(colors.white(`  Service:      ${config.serviceName}`))

  const { confirmed } = await prompt([
    {
      name: 'confirmed',
      type: Confirm,
      message: colors.yellow('⚠️ Proceed with deploy?'),
      default: false,
    },
  ])
  if (!confirmed) {
    console.log(colors.yellow('🚫 Deploy cancelled'))
    return false
  }

  // 5. Build (local command — localPath is user-confirmed, use Deno.Command)
  console.log(
    colors.cyan('\n🔨 Building Rust binary (cargo build --release)...'),
  )
  const buildCmd = new Deno.Command('cargo', {
    args: ['build', '--release'],
    cwd: config.localProjectPath,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const buildOutput = await buildCmd.output()
  if (!buildOutput.success) {
    console.log(colors.red('❌ Build failed'))
    return false
  }
  console.log(colors.green('✅ Build succeeded'))

  if (options.localhost) {
    // --- Localhost deploy ---
    // 6. Create local directory
    console.log(colors.cyan('📁 Creating local directory...'))
    await Deno.mkdir(config.remotePath, { recursive: true })

    // 7. Copy binary
    console.log(colors.cyan('📤 Copying binary...'))
    const binaryPath =
      `${config.localProjectPath}/target/release/${config.binaryName}`
    await Deno.copyFile(
      binaryPath,
      `${config.remotePath}/${config.binaryName}`,
    )
    console.log(colors.green('✅ Binary copied'))

    // 8. Make binary executable
    console.log(colors.cyan('🔧 Setting executable permission...'))
    await Deno.chmod(`${config.remotePath}/${config.binaryName}`, 0o755)

    // 9. Create systemd unit via temp file + sudo mv
    console.log(colors.cyan('⚙️ Creating systemd service...'))
    const unitContent = SYSTEMD_UNIT_TEMPLATE(config)
    const tmpPath = await Deno.makeTempFile({ suffix: '.service' })
    try {
      await Deno.writeTextFile(tmpPath, unitContent)
      const unitPath = `/etc/systemd/system/${config.serviceName}.service`
      const mvCmd = new Deno.Command('sudo', {
        args: ['mv', tmpPath, unitPath],
        stdout: 'piped',
        stderr: 'piped',
      })
      const mvResult = await mvCmd.output()
      if (!mvResult.success) {
        console.log(colors.red('❌ Failed to install systemd service'))
        return false
      }
    } catch {
      console.log(colors.red('❌ Failed to create systemd service'))
      return false
    } finally {
      await Deno.remove(tmpPath).catch(() => {})
    }

    // 10. Enable & start
    console.log(colors.cyan('🚀 Starting service...'))
    const reloadCmd = new Deno.Command('sudo', {
      args: ['systemctl', 'daemon-reload'],
      stdout: 'piped',
      stderr: 'piped',
    })
    await reloadCmd.output()
    const enableCmd = new Deno.Command('sudo', {
      args: ['systemctl', 'enable', '--now', config.serviceName],
      stdout: 'piped',
      stderr: 'piped',
    })
    const enableResult = await enableCmd.output()
    if (!enableResult.success) {
      console.log(colors.red('❌ Failed to start service'))
      return false
    }
    console.log(colors.green('✅ Service started'))
  } else {
    // --- Remote deploy (existing flow) ---
    // 6. Create remote directory
    console.log(colors.cyan('📁 Creating remote directory...'))
    const mkdirResult = await sshExec(
      config,
      buildRemoteCmd('mkdir', '-p', config.remotePath),
    )
    if (!mkdirResult.success) {
      console.log(colors.red('❌ Failed to create remote directory'))
      return false
    }

    // 7. SCP binary
    console.log(colors.cyan('📤 Uploading binary...'))
    const binaryPath =
      `${config.localProjectPath}/target/release/${config.binaryName}`
    const scpResult = await scpUpload(
      config,
      binaryPath,
      `${config.remotePath}/${config.binaryName}`,
    )
    if (!scpResult.success) {
      console.log(colors.red('❌ Failed to upload binary'))
      return false
    }
    console.log(colors.green('✅ Binary uploaded'))

    // 8. Make binary executable
    console.log(colors.cyan('🔧 Setting executable permission...'))
    const chmodResult = await sshExec(
      config,
      buildRemoteCmd(
        'chmod',
        '+x',
        `${config.remotePath}/${config.binaryName}`,
      ),
    )
    if (!chmodResult.success) {
      console.log(colors.red('❌ Failed to chmod +x on remote binary'))
      return false
    }

    // 9. Create systemd unit via temp file + SCP
    console.log(colors.cyan('⚙️ Creating systemd service...'))
    const unitContent = SYSTEMD_UNIT_TEMPLATE(config)
    const tmpLocal = await Deno.makeTempFile({ suffix: '.service' })
    try {
      await Deno.writeTextFile(tmpLocal, unitContent)

      const remoteTmp = `/tmp/slv-${config.serviceName}.service`
      const unitUpload = await scpUpload(config, tmpLocal, remoteTmp)
      if (!unitUpload.success) {
        console.log(colors.red('❌ Failed to upload systemd unit file'))
        return false
      }

      const unitPath = `/etc/systemd/system/${config.serviceName}.service`
      const mvResult = await sshExec(
        config,
        buildRemoteCmd('sudo', 'mv', remoteTmp, unitPath),
      )
      if (!mvResult.success) {
        console.log(colors.red('❌ Failed to install systemd service'))
        return false
      }
    } finally {
      await Deno.remove(tmpLocal).catch(() => {})
    }

    // 10. Enable & start
    console.log(colors.cyan('🚀 Starting service...'))
    const startResult = await sshExec(
      config,
      `sudo systemctl daemon-reload && sudo systemctl enable --now ${shellQuote(config.serviceName)}`,
    )
    if (!startResult.success) {
      console.log(colors.red('❌ Failed to start service'))
      return false
    }
    console.log(colors.green('✅ Service started'))
  }

  // 11. Save config
  await saveBotConfig(config)
  console.log(colors.green(`\n🎉 Bot "${config.name}" deployed successfully!`))
  return true
}

export { deployAction }
