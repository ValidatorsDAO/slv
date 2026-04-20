import { colors } from '@cliffy/colors'
import type { BotConfig } from '@cmn/zod/bot.ts'
import {
  buildRemoteCmd,
  sshExec,
  testSSHConnection,
} from '/src/bot/sshUtil.ts'

export type ExecResult = {
  success: boolean
  stdout: string
  stderr: string
  code: number
}

export const isLocalhost = (config: Pick<BotConfig, 'ip'>): boolean =>
  config.ip === 'localhost'

export const localExec = async (
  cmd: string,
  args: string[],
): Promise<ExecResult> => {
  const c = new Deno.Command(cmd, {
    args,
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await c.output()
  const decoder = new TextDecoder()
  return {
    success: out.success,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
    code: out.code,
  }
}

export const runSystemctl = async (
  config: BotConfig,
  ...args: string[]
): Promise<ExecResult> => {
  if (isLocalhost(config)) {
    return localExec('sudo', ['systemctl', ...args])
  }
  return sshExec(config, buildRemoteCmd('sudo', 'systemctl', ...args))
}

// `systemctl status` does not require sudo and is kept separate so the remote
// branch matches prior non-sudo behavior.
export const runSystemctlStatus = async (
  config: BotConfig,
): Promise<ExecResult> => {
  if (isLocalhost(config)) {
    return localExec('systemctl', ['status', config.serviceName])
  }
  return sshExec(
    config,
    buildRemoteCmd('systemctl', 'status', config.serviceName),
  )
}

export const runJournalctl = async (
  config: BotConfig,
  lines: number,
): Promise<ExecResult> => {
  const args = [
    '-u',
    config.serviceName,
    '-n',
    String(lines),
    '--no-pager',
  ]
  if (isLocalhost(config)) {
    return localExec('journalctl', args)
  }
  return sshExec(config, buildRemoteCmd('journalctl', ...args))
}

// Skip SSH liveness probe when local; otherwise fail fast with a friendly
// message before running the real command.
export const ensureConnectivity = async (
  config: BotConfig,
): Promise<boolean> => {
  if (isLocalhost(config)) return true
  const ok = await testSSHConnection(config)
  if (!ok) {
    console.log(
      colors.red(
        `❌ SSH connection failed to ${config.username}@${config.ip}`,
      ),
    )
  }
  return ok
}
