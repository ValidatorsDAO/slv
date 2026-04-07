import { Command } from '@cliffy'
import { Input, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'

const SSH_KEY_PATTERN =
  /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.+)?$/

function normalizeKeyLine(sshKey: string): string {
  return sshKey.trim().replace(/\s+/g, ' ')
}

function isValidSshPublicKey(sshKey: string): boolean {
  return SSH_KEY_PATTERN.test(normalizeKeyLine(sshKey))
}

const addSshKey = async (sshKey: string) => {
  const homeDir = Deno.env.get('HOME')
  if (!homeDir) {
    console.log(colors.red('❌ Could not determine home directory'))
    return false
  }

  const normalizedKey = normalizeKeyLine(sshKey)
  if (!isValidSshPublicKey(normalizedKey)) {
    console.log(
      colors.red(
        '❌ Invalid SSH public key format. Use ssh-rsa, ssh-ed25519, or ecdsa-sha2-* public keys.',
      ),
    )
    return false
  }

  const sshDir = `${homeDir}/.ssh`
  const authorizedKeysPath = `${sshDir}/authorized_keys`

  await Deno.mkdir(sshDir, { recursive: true })
  await Deno.chmod(sshDir, 0o700)

  try {
    const existing = await Deno.readTextFile(authorizedKeysPath)
    const existingLines = existing
      .split(/\r?\n/)
      .map((line) => normalizeKeyLine(line))
      .filter(Boolean)

    await Deno.chmod(authorizedKeysPath, 0o600)

    if (existingLines.includes(normalizedKey)) {
      console.log(colors.yellow('⚠️ SSH key already exists in authorized_keys'))
      return true
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.log(
        colors.red(`❌ Failed to read ${authorizedKeysPath}: ${error}`),
      )
      return false
    }
  }

  try {
    const entry = normalizedKey + '\n'
    await Deno.writeTextFile(authorizedKeysPath, entry, { append: true })
    await Deno.chmod(authorizedKeysPath, 0o600)
    return true
  } catch (error) {
    console.log(
      colors.red(`❌ Failed to write to ${authorizedKeysPath}: ${error}`),
    )
    return false
  }
}

export const addSshCmd = new Command()
  .description('🔑 Add SSH public key to authorized_keys')
  .arguments('[sshKey:string]')
  .action(async (_options: void, sshKey?: string) => {
    let key = sshKey
    if (!key) {
      const result = await prompt([
        {
          name: 'sshKey',
          message: 'Enter SSH public key',
          type: Input,
        },
      ])
      key = result.sshKey
    }
    if (!key || key.trim() === '') {
      console.log(colors.red('❌ SSH key is required'))
      return
    }
    const success = await addSshKey(key)
    if (success) {
      console.log(
        colors.white('✅ Successfully added SSH key to authorized_keys'),
      )
    }
  })
