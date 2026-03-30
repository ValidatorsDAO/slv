import type { BotConfig } from '@cmn/zod/bot.ts'

/**
 * Shell-quote a single argument to prevent command injection.
 * Wraps the value in single quotes, escaping any embedded single quotes.
 */
export const shellQuote = (s: string): string => {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Run a command on the remote host via SSH using Deno.Command (array args, no shell interpolation).
 * Returns { success, stdout, stderr, code }.
 */
export const sshExec = async (
  config: Pick<BotConfig, 'sshKeyPath' | 'username' | 'ip'>,
  remoteCommand: string,
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> => {
  const cmd = new Deno.Command('ssh', {
    args: [
      '-i', config.sshKeyPath,
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${config.username}@${config.ip}`,
      remoteCommand,
    ],
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  const decoder = new TextDecoder()
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    code: output.code,
  }
}

/**
 * SCP a local file to the remote host using Deno.Command (array args, no shell interpolation).
 */
export const scpUpload = async (
  config: Pick<BotConfig, 'sshKeyPath' | 'username' | 'ip'>,
  localPath: string,
  remotePath: string,
): Promise<{ success: boolean; stderr: string }> => {
  const cmd = new Deno.Command('scp', {
    args: [
      '-i', config.sshKeyPath,
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      localPath,
      `${config.username}@${config.ip}:${remotePath}`,
    ],
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  const decoder = new TextDecoder()
  return {
    success: output.success,
    stderr: decoder.decode(output.stderr),
  }
}

/**
 * Test SSH connectivity by running `echo ok` on the remote host.
 * Returns true if the connection succeeds, false otherwise.
 */
export const testSSHConnection = async (
  config: Pick<BotConfig, 'sshKeyPath' | 'username' | 'ip'>,
): Promise<boolean> => {
  const result = await sshExec(config, 'echo ok')
  return result.success && result.stdout.trim() === 'ok'
}

/**
 * Build a shell command string with properly quoted arguments for remote execution.
 * Usage: buildRemoteCmd('sudo', 'systemctl', 'start', serviceName)
 */
export const buildRemoteCmd = (...args: string[]): string => {
  return args.map(shellQuote).join(' ')
}
