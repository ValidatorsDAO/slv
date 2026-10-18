import { type UserApiAuth, userApiAuthHeader } from '/lib/userApi/auth.ts'
import { readUserApiError } from '/lib/userApi/httpError.ts'
import { fetchAuthorizationStatus } from '@/ai/authorization.ts'

export type OnboardReadiness =
  | { kind: 'ready'; remainingTokens: number }
  | { kind: 'empty'; remainingTokens: number }
  | { kind: 'activation_required' }
  | { kind: 'unavailable'; message: string }

/** Read account availability only. Never send a chat or start a purchase. */
export const checkOnboardReadiness = async (
  auth: UserApiAuth,
): Promise<OnboardReadiness> => {
  try {
    const response = await fetch('https://user-api.erpc.global/v3/ai/usage', {
      headers: { Authorization: await userApiAuthHeader(auth) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw await readUserApiError(response, 'ERPC account')
    const body = await response.json()
    const remaining = body?.message?.remaining_tokens
    if (
      body?.success !== true || typeof remaining !== 'number' ||
      !Number.isFinite(remaining)
    ) {
      throw new Error(
        'Unexpected AI usage response. Run `slv ai usage` to retry.',
      )
    }
    if (remaining <= 0) return { kind: 'empty', remainingTokens: remaining }
    const authorization = await fetchAuthorizationStatus(auth)
    if (authorization.state === 'unauthorized') {
      return { kind: 'activation_required' }
    }
    if (authorization.state !== 'authorized') {
      return {
        kind: 'unavailable',
        message:
          'Could not verify ERPC account activation. Run `slv ai product` to review your account status.',
      }
    }
    return { kind: 'ready', remainingTokens: remaining }
  } catch (error) {
    return {
      kind: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
