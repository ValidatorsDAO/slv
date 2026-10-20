import { Input } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'

export type SSHConnection = {
  username: string
  ip: string
  rsa_key_path: string
}

type SSHSetupOptions = {
  defaults?: Partial<SSHConnection>
  skipKnown?: boolean
}

export const checkSSHConnection = async (options: SSHSetupOptions = {}) => {
  const defaults = options.defaults ?? {}
  const questions = [{
    name: 'username',
    message: "What's the user for the server?",
    type: Input,
    default: defaults.username ?? 'root',
    suggestions: ['ubuntu', 'root'],
  }, {
    name: 'ip',
    message: "What's your server's IP address?",
    type: Input,
    default: defaults.ip,
  }, {
    name: 'rsa_key_path',
    message:
      'Path to SSH identity file (private key, or public .pub key for SSH agent)',
    type: Input,
    default: defaults.rsa_key_path ?? '~/.ssh/id_rsa',
  }]
  const result = { ...defaults } as SSHConnection
  for (const question of questions) {
    const key = question.name as keyof SSHConnection
    if (options.skipKnown && defaults[key]) continue
    result[key] = await Input.prompt({
      message: question.message,
      default: question.default,
      suggestions: question.suggestions,
    })
  }
  if (!result.ip || !result.username || !result.rsa_key_path) {
    console.error(
      colors.yellow('⚠️ Please provide all the required information'),
    )
    return null
  }

  if (
    !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(result.username) ||
    !/^[A-Za-z0-9_.:%\[\]-]+$/.test(result.ip)
  ) {
    console.error(
      colors.yellow(
        'Enter an SSH user and a hostname or IP address, without shell syntax.',
      ),
    )
    return null
  }

  // Check SSH connection using Deno.Command (no shell interpolation)
  console.log(colors.white('🔍 Checking SSH connection...'))
  const cmd = new Deno.Command('ssh', {
    args: [
      '-i',
      result.rsa_key_path,
      '-o',
      'ConnectTimeout=10',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '--',
      `${result.username}@${result.ip}`,
      'echo',
      'SSH connection successful',
    ],
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  if (!output.success) {
    console.error(
      colors.yellow(
        '⚠️ SSH connection failed\nPlease check your SSH identity file, agent authorization and IP address',
      ),
    )
    console.log(
      'Check the SSH user, agent approval and known host key before retrying.',
    )
    return null
  } else {
    console.log(colors.green('✔︎ SSH connection succeeded'))
  }
  return result as SSHConnection
}
