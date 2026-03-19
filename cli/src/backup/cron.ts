import { colors } from '@cliffy/colors'

const CRON_SCHEDULES: Record<string, string> = {
  daily: '0 3 * * *',
  weekly: '0 3 * * 0',
  monthly: '0 3 1 * *',
}

const SLV_CRON_MARKER = 'slv backup create'

async function runCapture(
  cmd: string,
  args: string[],
): Promise<{ success: boolean; stdout: string }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: 'piped',
    stderr: 'piped',
    stdin: 'null',
  })
  const result = await command.output()
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout),
  }
}

async function writeCrontab(content: string): Promise<boolean> {
  const command = new Deno.Command('crontab', {
    args: ['-'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  })
  const child = command.spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(content))
  await writer.close()
  const result = await child.output()
  return result.success
}

export async function setupCron(
  interval: string,
  retention: number,
): Promise<void> {
  if (interval === 'off') {
    await removeCron()
    return
  }

  const schedule = CRON_SCHEDULES[interval]
  if (!schedule) {
    console.log(
      colors.red(
        `Invalid cron interval: "${interval}". Use: daily, weekly, monthly, or off`,
      ),
    )
    Deno.exit(1)
  }

  // Prompt for Discord webhook URL
  const currentWebhook = Deno.env.get('SLV_BACKUP_WEBHOOK') || ''
  let webhookUrl = ''
  try {
    const { Input } = await import('@cliffy/prompt')
    webhookUrl = await Input.prompt({
      message: 'Discord webhook URL for backup notifications (optional, press Enter to skip)',
      default: currentWebhook,
    })
  } catch {
    // Non-interactive — use env var if available
    webhookUrl = currentWebhook
  }

  // Read existing crontab
  const { stdout: existing } = await runCapture('crontab', ['-l'])
  const lines = existing.split('\n').filter((line) => line.trim() !== '')

  // Remove existing slv backup entries
  const filtered = lines.filter((l) => !l.includes(SLV_CRON_MARKER))

  // Resolve slv binary path dynamically (fallback to /usr/local/bin/slv)
  let slvPath = '/usr/local/bin/slv'
  try {
    const { success, stdout } = await runCapture('which', ['slv'])
    if (success && stdout.trim()) {
      slvPath = stdout.trim()
    }
  } catch { /* use default */ }

  // Build cron entry with optional webhook env var
  // Ensure HOME is set so slv finds ~/.slv/api.yml under cron (which defaults to HOME=/root)
  const homeDir = Deno.env.get('HOME') || '/root'
  const homePrefix = `HOME="${homeDir}" `
  const webhookPrefix = webhookUrl ? `SLV_BACKUP_WEBHOOK="${webhookUrl}" ` : ''
  const entry =
    `${schedule} ${homePrefix}${webhookPrefix}${slvPath} backup create --upload --yes --retention ${retention} >> /var/log/slv-backup.log 2>&1`
  filtered.push(entry)

  // Write back
  const content = filtered.filter((l) => l.trim() !== '' || filtered.indexOf(l) < filtered.length - 1).join('\n') + '\n'
  const ok = await writeCrontab(content)
  if (!ok) {
    console.log(colors.red('❌ Failed to write crontab'))
    Deno.exit(1)
  }

  console.log(
    colors.green(
      `\n✅ Cron job registered: ${schedule} with ${retention} day retention`,
    ),
  )
  console.log(
    colors.dim(`   Entry: ${entry}\n`),
  )
}

async function removeCron(): Promise<void> {
  const { success, stdout: existing } = await runCapture('crontab', ['-l'])
  if (!success) {
    console.log(colors.yellow('No crontab found.'))
    return
  }

  const lines = existing.split('\n')
  const filtered = lines.filter((l) => !l.includes(SLV_CRON_MARKER))

  if (filtered.join('\n').trim() === '') {
    // Empty crontab — remove it entirely
    const cmd = new Deno.Command('crontab', { args: ['-r'], stdin: 'null' })
    await cmd.output()
  } else {
    await writeCrontab(filtered.join('\n') + '\n')
  }

  console.log(colors.green('\n✅ Cron job for slv backup removed.\n'))
}
