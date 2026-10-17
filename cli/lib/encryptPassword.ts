import { colors } from '@cliffy/colors'

type OpensslRun = { success: boolean; stdout: string }

type EncryptPasswordDeps = {
  /** Runs `command` without a shell, with `args` as its arguments and `stdin` as its input. */
  spawn: (
    command: string,
    args: string[],
    stdin: string,
  ) => Promise<OpensslRun>
  error: (line: string) => void
}

const spawnWithStdin: EncryptPasswordDeps['spawn'] = async (
  command,
  args,
  stdin,
) => {
  const child = new Deno.Command(command, {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'null',
  }).spawn()
  let written = true
  try {
    const writer = child.stdin.getWriter()
    try {
      await writer.write(new TextEncoder().encode(stdin))
    } finally {
      await writer.close()
    }
  } catch (_error) {
    // The process stopped before it read its input: its exit status says so.
    written = false
  }
  const { success, stdout } = await child.output()
  return {
    success: success && written,
    stdout: new TextDecoder().decode(stdout),
  }
}

const defaultEncryptPasswordDeps = (): EncryptPasswordDeps => ({
  spawn: spawnWithStdin,
  error: (line) => console.error(colors.yellow(line)),
})

const INSTALL_OPENSSL = `⚠️ Please install openssl (MacOS: brew install openssl)
The password is hashed as SHA-512 crypt (openssl passwd -6). The openssl that macOS ships (LibreSSL) cannot make that hash; Homebrew's openssl can.
brew install openssl
brew --prefix openssl
echo 'export PATH="{openssl path}"' >> ~/.zshrc`

/**
 * The SHA-512 crypt hash ($6$...) of a password, made by `openssl passwd -6
 * -stdin`. The password goes to openssl on its stdin: it is in no argument
 * (the list of processes shows those) and no shell or argument splitter reads
 * it, so it is hashed as typed. Returns '' and says how to install openssl
 * when openssl is missing, cannot make the hash or makes none. Nothing it
 * prints holds the password.
 */
const encryptPassword = async (
  password: string,
  deps: EncryptPasswordDeps = defaultEncryptPasswordDeps(),
): Promise<string> => {
  try {
    const run = await deps.spawn(
      'openssl',
      ['passwd', '-6', '-stdin'],
      `${password}\n`,
    )
    const hash = run.stdout.trim()
    if (run.success && hash !== '') return hash
  } catch (_error) {
    // openssl is missing, or it stopped before it read the password.
  }
  deps.error(INSTALL_OPENSSL)
  return ''
}

export { encryptPassword, INSTALL_OPENSSL }
export type { EncryptPasswordDeps, OpensslRun }
