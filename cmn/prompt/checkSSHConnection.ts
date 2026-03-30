import { Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'

export type SSHConnection = {
  username: string
  ip: string
  rsa_key_path: string
}

export const checkSSHConnection = async () => {
  const result = await prompt([{
    name: 'username',
    message: "What's the user for the server?",
    type: Input,
    default: 'root',
    suggestions: ['ubuntu', 'root'],
  }, {
    name: 'ip',
    message: "What's your server's IP address?",
    type: Input,
  }, {
    name: 'rsa_key_path',
    message: "What's the path to your RSA key?",
    type: Input,
    default: '~/.ssh/id_rsa',
  }])
  if (!result.ip || !result.username || !result.rsa_key_path) {
    console.error(
      colors.yellow('⚠️ Please provide all the required information'),
    )
    return null
  }

  // Check SSH connection using Deno.Command (no shell interpolation)
  console.log(colors.white('🔍 Checking SSH connection...'))
  const cmd = new Deno.Command('ssh', {
    args: [
      '-i', result.rsa_key_path,
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${result.username}@${result.ip}`,
      'echo', 'SSH connection successful',
    ],
    stdout: 'piped',
    stderr: 'piped',
  })
  const output = await cmd.output()
  if (!output.success) {
    console.error(
      colors.yellow(
        '⚠️ SSH connection failed\nPlease check your SSH key and IP address',
      ),
    )
    console.log(colors.white(`You might need to run this command: 
      
$ ssh-keygen -R ${result.ip}`))
    return null
  } else {
    console.log(colors.green('✔︎ SSH connection succeeded'))
  }
  return result as SSHConnection
}
