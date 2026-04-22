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

/**
 * Run a local command and capture its output. `stdin: 'inherit'` is
 * used by callers (e.g. `sudo mv` in onboard) that need to pass the
 * user's TTY through to a child that prompts for input. Binary-not-
 * found is caught and surfaced as `{success: false, stderr: ...}`
 * rather than thrown so every caller doesn't have to wrap in try/catch.
 */
export const localExec = async (
  cmd: string,
  args: string[],
  opts: { stdin?: 'null' | 'inherit' } = {},
): Promise<ExecResult> => {
  try {
    const c = new Deno.Command(cmd, {
      args,
      stdin: opts.stdin ?? 'null',
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
  } catch (err) {
    // Deno.Command throws NotFound when the binary isn't on PATH.
    // Surface as a normal failed-exec result so callers needn't wrap
    // their own try/catch around every spawn.
    return {
      success: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      code: -1,
    }
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
