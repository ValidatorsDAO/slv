import { ERPC_LOGIN_REJECTED_MESSAGE } from '/lib/userApi/auth.ts'

export type UserApiErrorKind =
  | 'authentication'
  | 'provider_configuration'
  | 'activation_required'
  | 'edge_block'
  | 'token_limit'
  | 'http'

/** Safe, structured diagnostics. Never keep an HTML response in an error. */
export class UserApiHttpError extends Error {
  constructor(
    message: string,
    readonly kind: UserApiErrorKind,
    readonly status: number,
    readonly rayId: string | null,
    readonly payload: Record<string, unknown> | null,
  ) {
    super(message)
    this.name = 'UserApiHttpError'
  }
}

const ERROR_BODY_LIMIT = 32 * 1024

/** Read only enough to identify a proxy page or a small JSON error. */
async function readErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  let done = false
  try {
    while (size < ERROR_BODY_LIMIT) {
      const part = await reader.read()
      if (part.done) {
        done = true
        break
      }
      const bytes = part.value.subarray(0, ERROR_BODY_LIMIT - size)
      size += bytes.byteLength
      text += decoder.decode(bytes, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function validRayId(value: string | null): string | null {
  return value && /^[a-f\d]{16,32}(?:-[a-z\d]{2,8})?$/i.test(value.trim())
    ? value.trim()
    : null
}

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null
  } catch {
    return null
  }
}

/**
 * Classify failures before rendering them. A Cloudflare response is not proof
 * of a bad OAuth session or an empty balance; neither logging in nor buying
 * tokens resolves a request rejected by the edge security policy.
 * Does not retry, refresh credentials, or make another API request.
 */
export async function readUserApiError(
  response: Response,
  service = 'SLV AI',
): Promise<UserApiHttpError> {
  const raw = await readErrorBody(response)
  return formatUserApiError(response, raw, service)
}

/** For clients which already consumed the body to parse a JSON result. */
export function formatUserApiError(
  response: Pick<Response, 'status' | 'headers'>,
  body: string,
  service = 'ERPC API',
): UserApiHttpError {
  const raw = body.slice(0, ERROR_BODY_LIMIT)
  const status = response.status
  const isHtml =
    /text\/html/i.test(response.headers.get('content-type') ?? '') ||
    /^\s*(?:<!doctype\s+html|<html\b)/i.test(raw)
  const rayId = validRayId(response.headers.get('cf-ray')) ??
    (isHtml
      ? validRayId(
        raw.match(/Cloudflare Ray ID:\s*(?:<[^>]+>\s*)*([a-f\d]{16,32})/i)
          ?.[1] ?? null,
      )
      : null)
  const cloudflarePage = isHtml &&
    (rayId !== null || /cloudflare|cf-error-details|cf-chl-/i.test(raw))
  const payload = isHtml ? null : jsonObject(raw)
  const prefix = `${service} request failed (HTTP ${status}).`
  const trace = rayId ? ` Cloudflare Ray ID: ${rayId}.` : ''

  if (cloudflarePage && status === 403) {
    return new UserApiHttpError(
      `${prefix} Cloudflare blocked this request before it reached the API.${trace} Contact ERPC support with the Ray ID and time of the request so the security rule can be checked.`,
      'edge_block',
      status,
      rayId,
      null,
    )
  }
  const providerError = payload?.type === 'error' && payload.error &&
      typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : null
  if (
    (status === 401 && providerError?.type === 'authentication_error') ||
    (status === 402 && providerError?.type === 'billing_error') ||
    (status === 403 && providerError?.type === 'permission_error')
  ) {
    return new UserApiHttpError(
      `${prefix} The AI provider rejected the service credentials, billing or access. Contact ERPC support to check the AI service configuration; signing in again will not resolve this provider error.${trace}`,
      'provider_configuration',
      status,
      rayId,
      payload,
    )
  }
  if (status === 401) {
    return new UserApiHttpError(
      `${prefix} ${ERPC_LOGIN_REJECTED_MESSAGE}`,
      'authentication',
      status,
      rayId,
      payload,
    )
  }
  // The account gate currently returns a message; also accept its stable
  // machine-readable code when supplied. Never repeat server-provided pricing.
  if (
    status === 400 && (payload?.error === 'payment_auth_required' ||
      (payload?.success === false && typeof payload.message === 'string' &&
        /^Complete\b.{0,100}\b(?:card|payment) authentication\b/i.test(
          payload.message,
        )))
  ) {
    return new UserApiHttpError(
      `${prefix} Complete account activation in the ERPC dashboard before using SLV AI. Run slv ai product to review your account status.`,
      'activation_required',
      status,
      rayId,
      payload,
    )
  }
  if (status === 403 && payload?.error === 'ai_token_limit_reached') {
    if (payload.plan === 'unknown') {
      return new UserApiHttpError(
        `${prefix} The service could not check your AI token allowance. Try again later; your balance has not been confirmed.`,
        'http',
        status,
        rayId,
        payload,
      )
    }
    return new UserApiHttpError(
      `${prefix} Insufficient AI tokens for this request. Run slv ai usage to check your balance and slv ai product to view token options.`,
      'token_limit',
      status,
      rayId,
      payload,
    )
  }

  let detail: string
  if (status === 529 || status === 503) {
    detail =
      'The AI service is temporarily unavailable or overloaded. Try again later.'
  } else if (status === 429) {
    detail = 'The request limit was reached. Wait before trying again.'
  } else if (isHtml) {
    detail =
      'An intermediary returned an HTML error page. Contact ERPC support with the status and request time.'
  } else if (status === 403) {
    detail =
      'The API denied access to this request. Contact ERPC support to check your access.'
  } else {
    // Keep server text and arbitrary HTML out of the terminal and model
    // context. A bounded machine-readable code is useful for support.
    const code = typeof payload?.error === 'string' &&
        /^[a-z][a-z\d_.-]{0,79}$/i.test(payload.error)
      ? ` Error code: ${payload.error}.`
      : ''
    detail = `Contact ERPC support if the problem continues.${code}`
  }
  return new UserApiHttpError(
    `${prefix} ${detail}${trace}`,
    'http',
    status,
    rayId,
    payload,
  )
}
