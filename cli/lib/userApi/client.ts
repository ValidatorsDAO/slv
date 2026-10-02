import { USER_API_ORIGIN } from '@cmn/constants/url.ts'
import { type UserApiAuth, userApiAuthHeader } from '/lib/userApi/auth.ts'

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
 * package, such as `src/ai/authorization.ts`, call user-api directly
 * with their own header — this claim is scoped to `cli/lib/userApi/`.)
 * Network failures (DNS, connection reset,
 * …) are never caught here — they throw and propagate to the caller,
 * since masking them would hide a real outage behind a misleading
 * result value.
 */
const send = async (
  auth: UserApiAuth,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<UserApiRawResponse> => {
  const headers: Record<string, string> = {
    'Authorization': userApiAuthHeader(auth),
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const res = await fetch(`${USER_API_ORIGIN}${path}`, init)
  const raw = await res.text()
  return { ok: res.ok, status: res.status, statusText: res.statusText, raw }
}

/** JSON-parsing request function for the direct user-api REST client. */
export const userApiRequest = async <T>(
  auth: UserApiAuth,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<UserApiResult<T>> => {
  const res = await send(auth, method, path, body)
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
