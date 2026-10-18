import { setPassword } from '@cmn/prompt/setPassword.ts'
import { pwdConfigFilePath } from '@cmn/constants/path.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/mod.ts'
import { parse } from '@std/yaml'
import { encryptPassword, INSTALL_OPENSSL } from '/lib/encryptPassword.ts'
import { colors } from '@cliffy/colors'

/**
 * A SHA-512 crypt hash: `$6$`, a salt, `$`, and the digest. The password file
 * holds nothing else, because a play passes it to the user module as the
 * password of solv, and an empty one would leave solv with no password.
 */
const SHA512_CRYPT_HASH = /^\$6\$[^$]+\$[./0-9A-Za-z]+$/

type GenPasswordDeps = {
  path: string
  /** The text of the file, or null when there is none. */
  readText: (path: string) => Promise<string | null>
  writeText: (path: string, text: string) => Promise<void>
  /** Asks for a new password; nothing when it is not confirmed. */
  askPassword: () => Promise<string | undefined>
  encrypt: (password: string) => Promise<string>
  info: (line: string) => void
  warn: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const defaultGenPasswordDeps = (): GenPasswordDeps => ({
  path: pwdConfigFilePath,
  readText: async (path) => {
    try {
      return await Deno.readTextFile(path)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null
      throw error
    }
  },
  writeText: (path, text) => Deno.writeTextFile(path, text),
  askPassword: setPassword,
  encrypt: encryptPassword,
  info: (line) => console.log(colors.green(line)),
  warn: (line) => console.warn(colors.yellow(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

/** Whether the text of a password file holds a SHA-512 crypt hash. */
const holdsValidHash = (text: string): boolean => {
  try {
    const value = (parse(text) as { encrypted_password?: unknown } | null)
      ?.encrypted_password
    return typeof value === 'string' && SHA512_CRYPT_HASH.test(value)
  } catch (_error) {
    return false
  }
}

/**
 * Makes sure that ~/.slv/config.pwd.yml holds the SHA-512 crypt hash of the
 * password of solv. A file without a valid hash counts as missing. The file is
 * written only with a valid hash: when openssl cannot make one, nothing is
 * written, the run is to stop, and the exit code is 1. Returns true when the
 * file holds a valid hash.
 */
const genPasswordYml = async (
  overrides: Partial<GenPasswordDeps> = {},
): Promise<boolean> => {
  const deps = { ...defaultGenPasswordDeps(), ...overrides }
  let existing: string | null
  try {
    existing = await deps.readText(deps.path)
  } catch (error) {
    deps.error(
      `❌ ${deps.path} cannot be read: ${
        error instanceof Error ? error.message : error
      }`,
    )
    deps.setExitCode(1)
    return false
  }
  if (existing !== null) {
    if (holdsValidHash(existing)) {
      deps.info(`✔︎ Password already exists.Skipping...`)
      return true
    }
    deps.warn(
      `⚠️ ${deps.path} has no valid password hash (it is empty or not a SHA-512 crypt hash), so it counts as missing and the password is asked again.`,
    )
  }
  let password = await deps.askPassword()
  while (!password) {
    password = await deps.askPassword()
  }
  let hash = ''
  try {
    hash = await deps.encrypt(password)
  } catch (_error) {
    // Treated as no hash, below. Nothing is said about the password.
  }
  if (!SHA512_CRYPT_HASH.test(hash)) {
    // encryptPassword has already said how to install openssl when it made no hash.
    if (hash !== '') deps.error(INSTALL_OPENSSL)
    deps.error(
      `❌ The password was not saved: openssl did not make a SHA-512 crypt hash ($6$...) of it, and ${deps.path} is not written without one. Run slv v init again when openssl can.`,
    )
    deps.setExitCode(1)
    return false
  }
  await deps.writeText(deps.path, stringify({ encrypted_password: hash }))
  deps.info(`✔︎ Password saved to ${deps.path}`)
  return true
}

export { genPasswordYml, holdsValidHash, SHA512_CRYPT_HASH }
export type { GenPasswordDeps }
