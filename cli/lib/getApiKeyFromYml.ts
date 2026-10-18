import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import {
  type UserApiAuth,
  userApiAuthFromAccessToken,
  userApiAuthFromSession,
} from '/lib/userApi/auth.ts'
import { userApiRequest } from '/lib/userApi/client.ts'
import {
  apiYmlPathFor,
  ensureFreshAccessToken,
  hasStoredLogin,
  readSlvSection,
  saveSlvCredentials,
  SessionExpiredError,
  SessionRefreshError,
  SLV_CREDENTIAL_KEYS,
  type SlvCredentialKey,
  type SlvCredentialUpdate,
  withCredentialLock,
  writeSlvCredentialsLocked,
} from '/lib/userApi/session.ts'

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
//   api_key                       RPC endpoints only (never sent to user-api)
//   access_token                  ERPC login (`slv login`) — see
//   refresh_token                 lib/userApi/session.ts
//   access_token_expires_at
//   storage_access_key_id         storage access key, used by restic (REST
//   storage_secret                username / password); issued for this
//   storage_access_key_record_id  machine on first use, revoked by logout
// ---------------------------------------------------------------------------

export type { SlvCredentialKey, SlvCredentialUpdate }

/** Check UUID v4 (the API key). */
export const isValidApiKey = (apiKey: string): boolean => {
  const uuidV4Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  return uuidV4Pattern.test(apiKey)
}

/** Storage access key id: `erpcsk_` + 16 characters from a-z and 2-7. */
export const isValidStorageAccessKeyId = (id: string): boolean =>
  /^erpcsk_[a-z2-7]{16}$/.test(id)

/** Storage access key secret: 43 base64url characters. */
export const isValidStorageSecret = (secret: string): boolean =>
  /^[A-Za-z0-9_-]{43}$/.test(secret)

export type StorageAccessKey = { id: string; secret: string }

const storedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

/**
 * Merge credentials into the `slv:` section of ~/.slv/api.yml (under the
 * api.yml lock). Every other key in `slv:` and every other section of the
 * file is kept. The file is written with mode 600 inside a 700 directory.
 */
export const mergeSlvCredentials = (
  update: SlvCredentialUpdate,
  home: string = resolveHome(),
): Promise<void> => saveSlvCredentials(home, update)

/** Remove every credential from `slv:` (`slv logout`). */
export const clearSlvCredentials = (
  home: string = resolveHome(),
): Promise<void> =>
  saveSlvCredentials(
    home,
    Object.fromEntries(SLV_CREDENTIAL_KEYS.map((key) => [key, null])),
  )

/** The API key for RPC, or null. */
export const findApiKey = async (
  home: string = resolveHome(),
): Promise<string | null> => {
  const apiKey = storedString((await readSlvSection(home)).api_key)
  return isValidApiKey(apiKey) ? apiKey : null
}

/** Create ~/.slv/api.yml (mode 600, directory 700) when it is missing. */
const ensureApiYml = async (home: string): Promise<void> => {
  try {
    await Deno.stat(apiYmlPathFor(home))
    return
  } catch {
    // missing
  }
  try {
    await saveSlvCredentials(home, {})
  } catch {
    // Not writable: the readers below treat the file as empty.
  }
}

/**
 * The saved ERPC login as a user-api auth value, or null when there is none
 * or it cannot be refreshed right now. For callers that skip their user-api
 * part without a login. The API key is never returned here.
 */
export const findUserApiAuth = async (
  home: string = resolveHome(),
): Promise<UserApiAuth | null> => {
  await ensureApiYml(home)
  if (!hasStoredLogin(await readSlvSection(home))) return null
  try {
    await ensureFreshAccessToken(home)
  } catch {
    return null
  }
  return userApiAuthFromSession(home)
}

/** Why a command cannot get its credential: a headline, then what to do. */
export type CredentialProblem = { ok: false; lines: string[] }

/** Print a `CredentialProblem` (no exit). */
export const printCredentialProblem = (problem: CredentialProblem): void => {
  console.log(colors.yellow(`⚠️ ${problem.lines[0]}`))
  if (problem.lines.length > 1) {
    console.log(colors.white(problem.lines.slice(1).join('\n')))
  }
}

const exitWith = (problem: CredentialProblem): never => {
  printCredentialProblem(problem)
  Deno.exit(1)
}

/** A fresh access token of the saved login, or why there is none. */
const checkLogin = async (
  home: string,
): Promise<{ ok: true; accessToken: string } | CredentialProblem> => {
  if (!hasStoredLogin(await readSlvSection(home))) {
    return {
      ok: false,
      lines: [
        'You are not signed in to ERPC on this machine.',
        'SLV AI and account features require an OAuth login; an RPC API key cannot sign you in.',
        '',
        '🚀 Get started with one of the commands below:',
        '',
        '$ slv signup # For new users',
        '$ slv login  # Sign in to ERPC in your browser',
      ],
    }
  }
  try {
    return { ok: true, accessToken: await ensureFreshAccessToken(home) }
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return {
        ok: false,
        lines: [
          'Your ERPC login has expired.',
          'Sign in again with:',
          '',
          '$ slv login',
        ],
      }
    }
    if (error instanceof SessionRefreshError) {
      return {
        ok: false,
        lines: [
          `Could not refresh your ERPC login (${error.reason}).`,
          'Try again, or sign in again with:',
          '',
          '$ slv login',
        ],
      }
    }
    throw error
  }
}

/**
 * The saved ERPC login as a user-api auth value, or why it cannot be used
 * (none saved, expired, or the refresh failed). Sends nothing to user-api.
 * For callers that report the problem themselves (e.g. a backup that also
 * posts it to its webhook).
 */
export const resolveUserApiAuth = async (): Promise<
  { ok: true; auth: UserApiAuth } | CredentialProblem
> => {
  const home = resolveHome()
  const login = await checkLogin(home)
  return login.ok ? { ok: true, auth: userApiAuthFromSession(home) } : login
}

/**
 * Like `findUserApiAuth`, but a missing or expired login prints how to sign
 * in and ends the process with exit code 1 — before any request is made.
 */
export const getUserApiAuth = async (): Promise<UserApiAuth> => {
  const login = await resolveUserApiAuth()
  return login.ok ? login.auth : exitWith(login)
}

const storageKeyIn = (
  slv: Record<string, unknown>,
): StorageAccessKey | null => {
  const id = storedString(slv.storage_access_key_id)
  const secret = storedString(slv.storage_secret)
  return isValidStorageAccessKeyId(id) && isValidStorageSecret(secret)
    ? { id, secret }
    : null
}

/** The stored storage access key (id + secret), or null. Never issues one. */
export const findStorageAccessKey = async (
  home: string = resolveHome(),
): Promise<StorageAccessKey | null> => storageKeyIn(await readSlvSection(home))

const storageKeyLabel = (): string => {
  let host = ''
  try {
    host = Deno.hostname()
  } catch {
    // no permission to read the host name
  }
  return `slv-${host || 'machine'}`.slice(0, 64)
}

type IssuedStorageKey = {
  id?: unknown
  accessKeyId?: unknown
  secret?: unknown
}

type IssueResult =
  | { ok: true; key: StorageAccessKey; createdLabel: string | null }
  | CredentialProblem

const STORAGE_PAGE =
  `the Storage page of the ERPC dashboard (${ERPC_DASHBOARD_URL})`

/**
 * Ask user-api for a read_write storage access key for this machine and save
 * it. read_write because the backup cron runs `restic forget --prune`.
 * Runs under the api.yml lock, so two processes issue one key between them;
 * the access token is taken before the lock (a refresh needs the same lock).
 */
const issueStorageAccessKey = (
  home: string,
  accessToken: string,
): Promise<IssueResult> =>
  withCredentialLock(home, async () => {
    const saved = storageKeyIn(await readSlvSection(home))
    if (saved) return { ok: true, key: saved, createdLabel: null }

    const label = storageKeyLabel()
    let res
    try {
      res = await userApiRequest<IssuedStorageKey>(
        userApiAuthFromAccessToken(accessToken),
        'POST',
        '/v3/storage/access-keys',
        { permission: 'read_write', label },
        // the api.yml lock is held: do not wait for an answer forever
        { timeoutMs: 30_000 },
      )
    } catch (error) {
      return {
        ok: false,
        lines: [
          `Could not reach user-api to create a storage access key: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      }
    }
    if (res.ok) {
      const { id, accessKeyId, secret } = res.data
      if (
        typeof id !== 'number' || !Number.isInteger(id) ||
        typeof accessKeyId !== 'string' ||
        !isValidStorageAccessKeyId(accessKeyId) ||
        typeof secret !== 'string' || !isValidStorageSecret(secret)
      ) {
        return {
          ok: false,
          lines: [
            'The storage access key in the response does not have the expected format.',
          ],
        }
      }
      await writeSlvCredentialsLocked(home, {
        storage_access_key_id: accessKeyId,
        storage_secret: secret,
        storage_access_key_record_id: id,
      })
      return { ok: true, key: { id: accessKeyId, secret }, createdLabel: label }
    }
    switch (res.status) {
      case 400:
        return {
          ok: false,
          lines: [
            res.body?.message ?? 'The storage access key was not created.',
            `Storage access keys are on ${STORAGE_PAGE}.`,
          ],
        }
      case 409:
        return {
          ok: false,
          lines: [
            'Active storage access keys are at the limit (10).',
            `Please revoke one you no longer use on ${STORAGE_PAGE}, then try again.`,
          ],
        }
      case 401:
        return {
          ok: false,
          lines: [
            'Your ERPC login was not accepted. Sign in again with $ slv login',
          ],
        }
      default:
        return {
          ok: false,
          lines: [
            `Could not create a storage access key (HTTP ${res.status}).`,
          ],
        }
    }
  })

/**
 * The storage access key restic connects with, or why there is none. When
 * none is saved, one is created for this machine with the ERPC login and
 * saved. For callers that report the problem themselves.
 */
export const resolveStorageAccessKey = async (): Promise<
  { ok: true; key: StorageAccessKey } | CredentialProblem
> => {
  const home = resolveHome()
  const saved = await findStorageAccessKey(home)
  if (saved) return { ok: true, key: saved }

  const login = await checkLogin(home)
  if (!login.ok) return login
  const result = await issueStorageAccessKey(home, login.accessToken)
  if (!result.ok) return result
  if (result.createdLabel) {
    console.log(
      colors.green(
        `✔️ Created a storage access key for this machine (${result.createdLabel}) and saved it to ~/.slv/api.yml.`,
      ),
    )
  }
  return { ok: true, key: result.key }
}

/**
 * Like `resolveStorageAccessKey`, but without a key it prints why and ends
 * the process with exit code 1 — restic is not started.
 */
export const getStorageAccessKey = async (): Promise<StorageAccessKey> => {
  const storage = await resolveStorageAccessKey()
  return storage.ok ? storage.key : exitWith(storage)
}
