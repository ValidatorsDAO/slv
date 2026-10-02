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

const tryParseJson = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const body: UserApiErrorBody = { ...parsed }
  if (typeof body.error !== 'string') delete body.error
  if (typeof body.message !== 'string') delete body.message
  return body
}

/**
 * Single fetch entry point for the direct user-api REST client.
 * Network failures (DNS, connection reset, …) are never caught
 * here — they throw and propagate to the caller, since masking
 * them would hide a real outage behind a misleading result value.
 */
export const userApiRequest = async <T>(
  auth: UserApiAuth,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<UserApiResult<T>> => {
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
  if (!res.ok) {
    return { ok: false, status: res.status, body: normalizeErrorBody(raw), raw }
  }
  return { ok: true, status: res.status, data: tryParseJson<T>(raw) as T }
}
