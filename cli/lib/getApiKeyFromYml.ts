import { parse, stringify } from '@std/yaml'
import { defaultApiKeyYml } from '/lib/config/defaultApiKeyYml.ts'
import {
  type UserApiAuth,
  userApiAuthFromAccessToken,
} from '/lib/userApi/auth.ts'
import { colors } from '@cliffy/colors'

/**
 * Validate SUDO_USER value to prevent path injection.
 * Returns the sanitized username or undefined if invalid/absent.
 */
export function sanitizeSudoUser(): string | undefined {
  const sudoUser = Deno.env.get('SUDO_USER')
  if (!sudoUser) return undefined
  if (!/^[a-zA-Z0-9._-]+$/.test(sudoUser)) {
    console.log(colors.red('⚠️ Invalid SUDO_USER value — ignoring'))
    return undefined
  }
  return sudoUser
}

/**
 * Resolve the real user's home directory.
 * When running under `sudo`, HOME points to /root but the credentials
 * live in the invoking user's home. Use SUDO_USER to find it.
 * Note: slv targets Linux servers only — uses /home/<user> convention.
 */
export function resolveHome(): string {
  const sudoUser = sanitizeSudoUser()
  if (sudoUser) {
    if (sudoUser === 'root') return '/root'
    return `/home/${sudoUser}`
  }
  const home = Deno.env.get('HOME')
  if (!home) {
    console.log(colors.red('⚠️ HOME environment variable not found'))
    Deno.exit(1)
  }
  return home
}

// ---------------------------------------------------------------------------
// Credentials in ~/.slv/api.yml (`slv:` section)
//
//   api_key                 RPC endpoints only (never sent to user-api)
//   access_token            account access token — the user-api credential
//   storage_access_key_id   storage access key, used by restic (REST
//   storage_secret          username / password)
// ---------------------------------------------------------------------------

/** Check UUID v4 (the API key). */
export const isValidApiKey = (apiKey: string): boolean => {
  const uuidV4Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  return uuidV4Pattern.test(apiKey)
}

/** Account access token: `erpcat_` + 43 base64url characters. */
export const isValidAccessToken = (token: string): boolean =>
  /^erpcat_[A-Za-z0-9_-]{43}$/.test(token)

/** Storage access key id: `erpcsk_` + 16 characters from a-z and 2-7. */
export const isValidStorageAccessKeyId = (id: string): boolean =>
  /^erpcsk_[a-z2-7]{16}$/.test(id)

/** Storage access key secret: 43 base64url characters. */
export const isValidStorageSecret = (secret: string): boolean =>
  /^[A-Za-z0-9_-]{43}$/.test(secret)

export type StorageAccessKey = { id: string; secret: string }

const CREDENTIAL_KEYS = [
  'api_key',
  'access_token',
  'storage_access_key_id',
  'storage_secret',
] as const

export type SlvCredentialKey = (typeof CREDENTIAL_KEYS)[number]

/**
 * Values to merge into `slv:`. A string sets the value, `null` clears it,
 * and a key that is left out (or `undefined`) keeps what is stored.
 */
export type SlvCredentialUpdate = Partial<
  Record<SlvCredentialKey, string | null>
>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const apiYmlPathFor = (home: string): string => `${home}/.slv/api.yml`

const readApiYml = async (home: string): Promise<Record<string, unknown>> => {
  try {
    const parsed = parse(await Deno.readTextFile(apiYmlPathFor(home)))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const readSlvSection = async (
  home: string,
): Promise<Record<string, unknown>> => {
  const slv = (await readApiYml(home)).slv
  return isRecord(slv) ? slv : {}
}

const storedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

/** Create ~/.slv/api.yml (mode 600, directory 700) when it is missing. */
const ensureApiYml = async (home: string): Promise<void> => {
  const path = apiYmlPathFor(home)
  try {
    await Deno.stat(path)
  } catch {
    try {
      await Deno.mkdir(`${home}/.slv`, { recursive: true, mode: 0o700 })
      await Deno.writeTextFile(path, defaultApiKeyYml(), { mode: 0o600 })
    } catch {
      // Not writable: the readers below treat the file as empty.
    }
  }
}

/**
 * Merge credentials into the `slv:` section of ~/.slv/api.yml. Every other
 * key in `slv:` and every other section of the file is kept. The file is
 * written with mode 600 inside a 700 directory.
 */
export const mergeSlvCredentials = async (
  update: SlvCredentialUpdate,
  home: string = resolveHome(),
): Promise<void> => {
  const path = apiYmlPathFor(home)
  await Deno.mkdir(`${home}/.slv`, { recursive: true, mode: 0o700 })

  // Read existing config to preserve the other sections (e.g. ai). A file
  // that is missing or cannot be parsed starts fresh.
  const yml = await readApiYml(home)
  const slv: Record<string, unknown> = isRecord(yml.slv) ? { ...yml.slv } : {}
  for (const key of CREDENTIAL_KEYS) {
    const value = update[key]
    if (value === undefined) continue
    slv[key] = value === null ? null : value.trim()
  }
  yml.slv = slv

  try {
    await Deno.chmod(path, 0o600) // tighten an existing file before it holds a secret
  } catch { /* not created yet */ }
  await Deno.writeTextFile(path, stringify(yml), { mode: 0o600 })
  await Deno.chmod(path, 0o600)
}

/** Remove every credential from `slv:` (`slv logout`). */
export const clearSlvCredentials = (
  home: string = resolveHome(),
): Promise<void> =>
  mergeSlvCredentials({
    api_key: null,
    access_token: null,
    storage_access_key_id: null,
    storage_secret: null,
  }, home)

/**
 * The account access token as a user-api auth value, or null when none is
 * stored (or the stored value does not have the token shape). The API key is
 * never returned here.
 */
export const findUserApiAuth = async (
  home: string = resolveHome(),
): Promise<UserApiAuth | null> => {
  await ensureApiYml(home)
  const token = storedString((await readSlvSection(home)).access_token)
  return isValidAccessToken(token) ? userApiAuthFromAccessToken(token) : null
}

/**
 * Like `findUserApiAuth`, but a missing token prints how to save one and
 * ends the process with exit code 1 — before any request is made.
 */
export const getUserApiAuth = async (): Promise<UserApiAuth> => {
  const home = resolveHome()
  const auth = await findUserApiAuth(home)
  if (!auth) {
    console.log(
      colors.yellow(
        `⚠️ Account access token not found in ${apiYmlPathFor(home)}`,
      ),
    )
    const text = `
🚀 Get started with one of the commands below:

$ slv signup # For new users
$ slv login  # Save your account access token on this machine

Create an account access token in the ERPC dashboard (https://dashboard.erpc.global).
Then run $ slv login to save it on this machine.`
    console.log(colors.white(text))
    Deno.exit(1)
  }
  return auth
}

/** The stored storage access key (id + secret), or null. */
export const findStorageAccessKey = async (
  home: string = resolveHome(),
): Promise<StorageAccessKey | null> => {
  const slv = await readSlvSection(home)
  const id = storedString(slv.storage_access_key_id)
  const secret = storedString(slv.storage_secret)
  return isValidStorageAccessKeyId(id) && isValidStorageSecret(secret)
    ? { id, secret }
    : null
}

/**
 * Like `findStorageAccessKey`, but a missing key prints how to save one and
 * ends the process with exit code 1.
 */
export const getStorageAccessKey = async (): Promise<StorageAccessKey> => {
  const home = resolveHome()
  const key = await findStorageAccessKey(home)
  if (!key) {
    console.log(
      colors.yellow(
        `⚠️ Storage access key not found in ${apiYmlPathFor(home)}`,
      ),
    )
    const text = `
Backups with restic connect with a storage access key.

Create a storage access key on the Storage page of the ERPC dashboard (https://dashboard.erpc.global).
Then run $ slv login to save it on this machine.
Use a key with read_write permission if you want --retention (it runs forget --prune).`
    console.log(colors.white(text))
    Deno.exit(1)
  }
  return key
}
