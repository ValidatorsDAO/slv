import { parse, stringify } from '@std/yaml'
import { AUTH_API_ORIGIN } from '@cmn/constants/url.ts'

/**
 * The ERPC login of the CLI.
 *
 * `slv login` uses the OAuth 2.0 device authorization grant (RFC 8628): the
 * CLI shows a URL and a code, the user confirms them in a browser, and the
 * CLI receives a short-lived access token and a refresh token. The CLI is a
 * public client — it has a client id and no client secret.
 *
 * The login is kept in the `slv:` section of ~/.slv/api.yml (mode 600):
 *
 *   access_token             JWT that user-api accepts as the credential
 *   refresh_token            JWT that gets a new access token; the server
 *                            replaces it with a new one on every use
 *   access_token_expires_at  Unix seconds by this machine's clock: the time
 *                            the token arrived + `expires_in` (the JWT `exp`
 *                            is not used, so a skewed clock does not matter)
 *
 * Every write to api.yml — `slv:` through `saveSlvCredentials` (or, while
 * the lock is already held, `writeSlvCredentialsLocked`), every other section
 * through `updateApiYml` — takes an exclusive lock on ~/.slv/api.yml.lock,
 * reads the file again, changes only its own part and replaces api.yml with a
 * rename. So two processes never refresh with the same refresh token, no
 * writer puts an old refresh token back, and a reader never sees a
 * half-written file.
 */

export const ERPC_CLI_CLIENT_ID = 'erpc-cli'
const DEVICE_SCOPE = 'openid profile email'
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const DEVICE_AUTHORIZATION_URL = `${AUTH_API_ORIGIN}/oauth/device/authorization`
const TOKEN_URL = `${AUTH_API_ORIGIN}/oauth/token`
const REVOKE_URL = `${AUTH_API_ORIGIN}/oauth/revoke`

/** Refresh the access token this many seconds before it expires. */
const REFRESH_MARGIN_SECONDS = 60
/** Upper bound for one request to the auth server, body included. */
const AUTH_REQUEST_TIMEOUT_MS = 30_000
const MIN_POLL_INTERVAL_SECONDS = 5
const SLOW_DOWN_STEP_SECONDS = 5

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** Three base64url segments joined by dots. Nothing is decoded. */
export const isJwtShaped = (value: unknown): value is string =>
  typeof value === 'string' && JWT_SHAPE.test(value)

export const nowInSeconds = (): number => Math.floor(Date.now() / 1000)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------
// ~/.slv/api.yml
// ---------------------------------------------------------------------------

export const apiYmlPathFor = (home: string): string => `${home}/.slv/api.yml`
const lockPathFor = (home: string): string => `${home}/.slv/api.yml.lock`

export const SLV_CREDENTIAL_KEYS = [
  'api_key',
  'access_token',
  'refresh_token',
  'access_token_expires_at',
  'storage_access_key_id',
  'storage_secret',
  'storage_access_key_record_id',
] as const

export type SlvCredentialKey = (typeof SLV_CREDENTIAL_KEYS)[number]

/**
 * Values to merge into `slv:`. A value sets the key, `null` removes it, and a
 * key that is left out (or `undefined`) keeps what is stored.
 */
export type SlvCredentialUpdate = Partial<
  Record<SlvCredentialKey, string | number | null>
>

/** The whole file, or `{}` when it is missing or cannot be parsed. */
export const readApiYml = async (
  home: string,
): Promise<Record<string, unknown>> => {
  try {
    const parsed = parse(await Deno.readTextFile(apiYmlPathFor(home)))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export const readSlvSection = async (
  home: string,
): Promise<Record<string, unknown>> => {
  const slv = (await readApiYml(home)).slv
  return isRecord(slv) ? slv : {}
}

/**
 * Under `sudo`, the uid / gid of the user who ran it. A refresh can happen
 * inside any command, so one `sudo slv …` would otherwise leave api.yml owned
 * by root and the next run as the user would find no login.
 */
const sudoInvoker = (): { uid: number; gid: number } | null => {
  try {
    if (Deno.uid() !== 0) return null
  } catch {
    return null
  }
  const uid = Deno.env.get('SUDO_UID') ?? ''
  const gid = Deno.env.get('SUDO_GID') ?? ''
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) return null
  return { uid: Number(uid), gid: Number(gid) }
}

const handBackToSudoUser = async (path: string): Promise<void> => {
  const owner = sudoInvoker()
  if (!owner) return
  try {
    await Deno.chown(path, owner.uid, owner.gid)
  } catch {
    // Best effort: the file is still written.
  }
}

const ensureSlvDir = async (home: string): Promise<void> => {
  const dir = `${home}/.slv`
  try {
    await Deno.stat(dir)
    return
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 })
  await handBackToSudoUser(dir)
}

/**
 * Run `fn` holding the exclusive lock on ~/.slv/api.yml.lock.
 *
 * The lock belongs to the open file, so a second `withCredentialLock` on the
 * same home from inside `fn` would wait for itself forever. Code that already
 * holds the lock writes with `writeSlvCredentialsLocked`.
 */
export const withCredentialLock = async <T>(
  home: string,
  fn: () => Promise<T>,
): Promise<T> => {
  await ensureSlvDir(home)
  const lockPath = lockPathFor(home)
  const lockFile = await Deno.open(lockPath, {
    create: true,
    write: true,
    mode: 0o600,
  })
  try {
    await handBackToSudoUser(lockPath)
    await lockFile.lock(true)
    try {
      return await fn()
    } finally {
      await lockFile.unlock()
    }
  } finally {
    lockFile.close()
  }
}

/**
 * api.yml exists but cannot be read, or is not a YAML mapping. Writers stop
 * with this before anything is replaced, so no section is lost.
 */
export class ApiYmlUnreadableError extends Error {
  override name = 'ApiYmlUnreadableError'
  constructor(path: string, problem: string) {
    super(
      `${path} ${problem}, so it was not changed. If it belongs to root (for example after running slv with sudo), give it back with: sudo chown "$USER" ${path}`,
    )
  }
}

/** The whole file for a writer: only a missing file counts as empty. */
const readApiYmlForWrite = async (
  home: string,
): Promise<Record<string, unknown>> => {
  const path = apiYmlPathFor(home)
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {}
    throw new ApiYmlUnreadableError(
      path,
      `could not be read (${error instanceof Error ? error.name : 'error'})`,
    )
  }
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    throw new ApiYmlUnreadableError(path, 'is not valid YAML')
  }
  if (parsed === null || parsed === undefined) return {}
  if (!isRecord(parsed)) {
    throw new ApiYmlUnreadableError(path, 'is not a YAML mapping')
  }
  return parsed
}

/**
 * Read api.yml again, let `change` edit it, and replace api.yml (mode 600)
 * with a rename. The caller holds the lock (`withCredentialLock`). Throws
 * `ApiYmlUnreadableError` — before anything is written — when the file
 * exists but cannot be read or parsed.
 */
const rewriteApiYmlLocked = async (
  home: string,
  change: (yml: Record<string, unknown>) => void,
): Promise<void> => {
  const yml = await readApiYmlForWrite(home)
  change(yml)

  await ensureSlvDir(home)
  const tmp = `${home}/.slv/.api.yml.${crypto.randomUUID()}.tmp`
  try {
    await Deno.writeTextFile(tmp, stringify(yml), {
      mode: 0o600,
      createNew: true,
    })
    await Deno.chmod(tmp, 0o600)
    await handBackToSudoUser(tmp)
    await Deno.rename(tmp, apiYmlPathFor(home))
  } catch (error) {
    await Deno.remove(tmp).catch(() => {})
    throw error
  }
}

/**
 * Merge `update` into `slv:`. Every other key in `slv:` and every other
 * section is kept. The caller holds the lock (`withCredentialLock`).
 */
export const writeSlvCredentialsLocked = (
  home: string,
  update: SlvCredentialUpdate,
): Promise<void> =>
  rewriteApiYmlLocked(home, (yml) => {
    const slv: Record<string, unknown> = isRecord(yml.slv) ? { ...yml.slv } : {}
    for (const key of SLV_CREDENTIAL_KEYS) {
      const value = update[key]
      if (value === undefined) continue
      if (value === null) delete slv[key]
      else slv[key] = typeof value === 'string' ? value.trim() : value
    }
    yml.slv = slv
  })

/**
 * Change a section of api.yml other than `slv:` (ai, lang, notifications, …)
 * under the lock: the file is read again inside the lock, so a refresh that
 * finished a moment ago is kept. `change` must not touch `slv:`.
 */
export const updateApiYml = (
  home: string,
  change: (yml: Record<string, unknown>) => void,
): Promise<void> =>
  withCredentialLock(home, () => rewriteApiYmlLocked(home, change))

/** Take the lock and merge `update` into `slv:`. */
export const saveSlvCredentials = (
  home: string,
  update: SlvCredentialUpdate,
): Promise<void> =>
  withCredentialLock(home, () => writeSlvCredentialsLocked(home, update))

// ---------------------------------------------------------------------------
// The saved login
// ---------------------------------------------------------------------------

/** Signed in = a refresh token of the JWT shape is saved. */
export const hasStoredLogin = (slv: Record<string, unknown>): boolean =>
  isJwtShaped(slv.refresh_token)

/** The saved access token when it is good for more than the margin. */
const freshAccessToken = (
  slv: Record<string, unknown>,
  now: number,
): string | null => {
  const token = slv.access_token
  const expiresAt = slv.access_token_expires_at
  if (!isJwtShaped(token)) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  return now < expiresAt - REFRESH_MARGIN_SECONDS ? token : null
}

/** The refresh token is no longer accepted (or there is none): log in again. */
export class SessionExpiredError extends Error {
  override name = 'SessionExpiredError'
  constructor() {
    super('The ERPC login has expired. Run `slv login` again.')
  }
}

/** The refresh did not complete for another reason (network, server). */
export class SessionRefreshError extends Error {
  override name = 'SessionRefreshError'
  readonly reason: string
  constructor(reason: string) {
    super(`Could not refresh the ERPC login (${reason}).`)
    this.reason = reason
  }
}

export type TokenSet = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/** A token response counts only with all three values in the right shape. */
const parseTokenSet = (body: unknown): TokenSet | null => {
  if (!isRecord(body)) return null
  const { access_token, refresh_token, expires_in } = body
  if (!isJwtShaped(access_token) || !isJwtShaped(refresh_token)) return null
  if (
    typeof expires_in !== 'number' || !Number.isInteger(expires_in) ||
    expires_in <= 0
  ) {
    return null
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresIn: expires_in,
  }
}

const sessionUpdate = (
  tokens: TokenSet,
  receivedAt: number,
): SlvCredentialUpdate => ({
  access_token: tokens.accessToken,
  refresh_token: tokens.refreshToken,
  access_token_expires_at: receivedAt + tokens.expiresIn,
})

/**
 * Save a new login (the storage access key and API key stay). Returns the
 * refresh token it replaced, read under the same lock, or null.
 */
export const saveSession = (
  home: string,
  tokens: TokenSet,
  receivedAt: number,
): Promise<string | null> =>
  withCredentialLock(home, async () => {
    const previous = (await readSlvSection(home)).refresh_token
    await writeSlvCredentialsLocked(home, sessionUpdate(tokens, receivedAt))
    return isJwtShaped(previous) ? previous : null
  })

type FormResult = { status: number; ok: boolean; body: unknown }

/**
 * POST a form to the auth server. The answer, body included, has to arrive
 * within 30 seconds (a refresh waits for it holding the api.yml lock);
 * otherwise the request is aborted and this throws. `body` is the parsed
 * JSON, or `undefined` when the body is not JSON.
 */
const postForm = async (
  url: string,
  fields: Record<string, string>,
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
): Promise<FormResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return { status: res.status, ok: res.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

const requestRefresh = async (refreshToken: string): Promise<TokenSet> => {
  let res: FormResult
  try {
    res = await postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ERPC_CLI_CLIENT_ID,
    })
  } catch (error) {
    throw new SessionRefreshError(
      error instanceof DOMException && error.name === 'AbortError'
        ? 'no answer within 30 seconds'
        : error instanceof Error
        ? error.message
        : String(error),
    )
  }
  if (
    res.status === 400 && isRecord(res.body) &&
    res.body.error === 'invalid_grant'
  ) {
    throw new SessionExpiredError()
  }
  if (!res.ok) throw new SessionRefreshError(`HTTP ${res.status}`)
  const tokens = parseTokenSet(res.body)
  if (!tokens) throw new SessionRefreshError('incomplete token response')
  return tokens
}

const refreshing = new Map<string, Promise<string>>()

/**
 * The access token to send now. A saved token that is good for more than 60
 * seconds is returned as is; otherwise it is refreshed — one refresh per home
 * in this process, and under the file lock across processes — and the new
 * access token, the new refresh token and the new expiry are saved before
 * the token is returned.
 *
 * Throws `SessionExpiredError` when there is no login or the server rejects
 * the refresh token (nothing saved is changed), `SessionRefreshError` for any
 * other failure. Neither error carries a token value.
 */
export const ensureFreshAccessToken = async (
  home: string,
  now: () => number = nowInSeconds,
): Promise<string> => {
  const slv = await readSlvSection(home)
  const fresh = freshAccessToken(slv, now())
  if (fresh) return fresh
  if (!hasStoredLogin(slv)) throw new SessionExpiredError()

  const running = refreshing.get(home)
  if (running) return await running
  const refresh = withCredentialLock(home, async () => {
    // Another process may have refreshed while this one waited for the lock.
    const current = await readSlvSection(home)
    const refreshed = freshAccessToken(current, now())
    if (refreshed) return refreshed
    const refreshToken = current.refresh_token
    if (!isJwtShaped(refreshToken)) throw new SessionExpiredError()
    const tokens = await requestRefresh(refreshToken)
    await writeSlvCredentialsLocked(home, sessionUpdate(tokens, now()))
    return tokens.accessToken
  }).finally(() => refreshing.delete(home))
  refreshing.set(home, refresh)
  return await refresh
}

/**
 * Ask the auth server to revoke a refresh token (RFC 7009 token revocation;
 * a public client sends its client id and no secret). Best effort for `slv logout`
 * and for the login a new `slv login` replaces: true only on a 2xx. Any other
 * answer or a network failure returns false and nothing is printed — the
 * caller goes on either way.
 */
export const revokeRefreshToken = async (
  refreshToken: string,
): Promise<boolean> => {
  try {
    const res = await postForm(REVOKE_URL, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: ERPC_CLI_CLIENT_ID,
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Device authorization (`slv login`)
// ---------------------------------------------------------------------------

export type DeviceAuthorization = {
  /** Kept in memory only: never printed and never saved. */
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type DeviceAuthorizationResult =
  | { ok: true; authorization: DeviceAuthorization }
  | { ok: false; error: string }

/** Start a device login. `error` is an OAuth error code or `HTTP <n>`. */
export const requestDeviceAuthorization = async (): Promise<
  DeviceAuthorizationResult
> => {
  let res: FormResult
  try {
    res = await postForm(DEVICE_AUTHORIZATION_URL, {
      client_id: ERPC_CLI_CLIENT_ID,
      scope: DEVICE_SCOPE,
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const body = res.body
  if (!res.ok) {
    return {
      ok: false,
      error: isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `HTTP ${res.status}`,
    }
  }
  if (!isRecord(body)) return { ok: false, error: 'unexpected response' }
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in,
    interval,
  } = body
  if (
    typeof device_code !== 'string' || !device_code ||
    typeof user_code !== 'string' || !user_code ||
    typeof verification_uri !== 'string' ||
    !verification_uri.startsWith('https://') ||
    typeof expires_in !== 'number' || !Number.isInteger(expires_in) ||
    expires_in <= 0
  ) {
    return { ok: false, error: 'unexpected response' }
  }
  return {
    ok: true,
    authorization: {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      verificationUriComplete: typeof verification_uri_complete === 'string' &&
          verification_uri_complete.startsWith('https://')
        ? verification_uri_complete
        : verification_uri,
      expiresIn: expires_in,
      interval: typeof interval === 'number' && Number.isInteger(interval)
        ? interval
        : MIN_POLL_INTERVAL_SECONDS,
    },
  }
}

export type DevicePollDeps = {
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type DevicePollResult =
  | { ok: true; tokens: TokenSet; receivedAt: number }
  | { ok: false; error: string }

/**
 * Poll the token endpoint until the user has confirmed the login in the
 * browser. Waits `interval` seconds (at least 5) before every poll and 5
 * more after each `slow_down` or HTTP 429. Network failures and 5xx responses
 * are retried; `authorization_pending` keeps waiting; permanent errors
 * (`access_denied`, `expired_token`, …) end the login. Past
 * `expires_in` seconds the login ends with `expired_token`.
 */
export const pollDeviceToken = async (
  authorization: DeviceAuthorization,
  deps: DevicePollDeps,
): Promise<DevicePollResult> => {
  const deadline = deps.now() + authorization.expiresIn
  let interval = Math.max(MIN_POLL_INTERVAL_SECONDS, authorization.interval)
  while (true) {
    const remaining = deadline - deps.now()
    if (remaining <= 0) return { ok: false, error: 'expired_token' }
    await deps.sleep(Math.min(interval, remaining) * 1000)
    if (deps.now() >= deadline) return { ok: false, error: 'expired_token' }

    let res: FormResult
    try {
      res = await postForm(
        TOKEN_URL,
        {
          grant_type: DEVICE_CODE_GRANT,
          client_id: ERPC_CLI_CLIENT_ID,
          device_code: authorization.deviceCode,
        },
        Math.min(AUTH_REQUEST_TIMEOUT_MS, (deadline - deps.now()) * 1000),
      )
    } catch {
      // Back off on connection failures instead of retrying a failed service
      // at the original rate for the whole device-code lifetime.
      interval *= 2
      continue // network failure or no answer within 30 seconds
    }
    const body = res.body
    if (res.status === 429) {
      interval += SLOW_DOWN_STEP_SECONDS
      continue
    }
    if (res.status >= 500) continue

    if (res.ok) {
      const tokens = parseTokenSet(body)
      return tokens
        ? { ok: true, tokens, receivedAt: deps.now() }
        : { ok: false, error: 'incomplete token response' }
    }
    const error = isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `HTTP ${res.status}`
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval += SLOW_DOWN_STEP_SECONDS
      continue
    }
    return { ok: false, error }
  }
}

/**
 * Open `url` in a browser on a desktop session: macOS, or Linux with a
 * display and not over SSH. On a server without a GUI, `xdg-open` would start
 * a text browser that takes over the terminal, so nothing is opened there.
 * The browser runs detached and a failure is ignored — the URL is printed
 * anyway.
 */
export const openInBrowser = (url: string): void => {
  const env = (name: string) => Deno.env.get(name) ?? ''
  let command: string | null = null
  if (Deno.build.os === 'darwin') {
    command = 'open'
  } else if (
    Deno.build.os === 'linux' &&
    (env('DISPLAY') || env('WAYLAND_DISPLAY')) && !env('SSH_CONNECTION')
  ) {
    command = 'xdg-open'
  }
  if (!command) return
  try {
    const child = new Deno.Command(command, {
      args: [url],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).spawn()
    child.unref()
    child.status.catch(() => {})
  } catch {
    // No browser: the URL is on the screen.
  }
}
