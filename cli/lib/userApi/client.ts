import { USER_API_ORIGIN } from '@cmn/constants/url.ts'
import { type UserApiAuth, userApiAuthHeader } from '/lib/userApi/auth.ts'
import {
  formatUserApiError,
  type UserApiHttpError,
} from '/lib/userApi/httpError.ts'

export type { UserApiAuth }

export type UserApiErrorBody = {
  error?: string
  message?: string
  errorCode?: string
  [k: string]: unknown
}

export type UserApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; body: UserApiErrorBody | null; raw: string }

export type UserApiRawResponse = {
  ok: boolean
  status: number
  statusText: string
  raw: string
  error?: UserApiHttpError
}

type ParseResult<T> = { ok: true; value: T } | { ok: false }

// Distinguishes "the body is valid JSON `null`" from "the body did
// not parse at all" — both would collapse to the same `null` if this
// just returned `T | null`, which is what let a 2xx non-JSON body
// silently become `{ ok: true, data: null }` before this fix.
const tryParseJson = <T>(raw: string): ParseResult<T> => {
  try {
    return { ok: true, value: JSON.parse(raw) as T }
  } catch {
    return { ok: false }
  }
}

/**
 * Normalize a (possibly non-JSON) error body. The input-validation
 * 400 path sometimes returns `error` as a nested object (zod issue
 * list) rather than a string — callers only ever want to branch on
 * a string error code, so a non-string `error` / `message` is
 * dropped rather than surfaced as-is.
 */
const normalizeErrorBody = (raw: string): UserApiErrorBody | null => {
  const parsed = tryParseJson<Record<string, unknown>>(raw)
  if (
    !parsed.ok || parsed.value === null || typeof parsed.value !== 'object' ||
    Array.isArray(parsed.value)
  ) {
    return null
  }
  const body: UserApiErrorBody = { ...parsed.value }
  if (typeof body.error !== 'string') delete body.error
  if (typeof body.message !== 'string') delete body.message
  return body
}

/**
 * The one `fetch` call in `cli/lib/userApi/` — `userApiRequest`
 * (JSON) and `userApiRequestRaw` (raw text) both build their request
 * through this, so there is exactly one place in this directory that
 * attaches the `Authorization` header. (Other parts of the `@slv/cli`
 * package that call user-api with their own `fetch` take the header
 * value from `userApiAuthHeader` too.)
 * Network failures (DNS, connection reset,
 * …) are never caught here — they throw and propagate to the caller,
 * since masking them would hide a real outage behind a misleading
 * result value. With `timeoutMs`, a request whose answer (body included)
 * does not arrive in time is aborted and throws the same way.
 */
const send = async (
  auth: UserApiAuth,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<UserApiRawResponse> => {
  const headers: Record<string, string> = {
    'Authorization': await userApiAuthHeader(auth),
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const controller = new AbortController()
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs)
  if (timer !== undefined) init.signal = controller.signal
  try {
    const res = await fetch(`${USER_API_ORIGIN}${path}`, init)
    const raw = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      raw,
      ...(!res.ok ? { error: formatUserApiError(res, raw) } : {}),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type UserApiRequestOptions = {
  /** Abort when the answer, body included, takes longer than this. */
  timeoutMs?: number
}

/** JSON-parsing request function for the direct user-api REST client. */
export const userApiRequest = async <T>(
  auth: UserApiAuth,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  options: UserApiRequestOptions = {},
): Promise<UserApiResult<T>> => {
  const res = await send(auth, method, path, body, options.timeoutMs)
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body: normalizeErrorBody(res.raw),
      raw: res.raw,
    }
  }
  const parsed = tryParseJson<T>(res.raw)
  if (!parsed.ok) {
    // A 2xx with a body that isn't valid JSON (an HTML error page from
    // a proxy in front of user-api, an empty body, …) is not success —
    // callers destructure `data` immediately, so letting this through
    // as `{ ok: true, data: null }` turned into a crash at the call
    // site instead of a handled failure.
    return {
      ok: false,
      status: res.status,
      body: { error: 'parse_error', message: 'response was not valid JSON' },
      raw: res.raw,
    }
  }
  return { ok: true, status: res.status, data: parsed.value }
}

/**
 * Raw-text variant for callers that format their own success/failure
 * text instead of parsing JSON (the console's fixed read-tools
 * table).
 */
export const userApiRequestRaw = (
  auth: UserApiAuth,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
): Promise<UserApiRawResponse> => send(auth, method, path)
