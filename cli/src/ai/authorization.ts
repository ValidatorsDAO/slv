export type AuthState = 'authorized' | 'unauthorized' | 'unknown'

export type AuthorizationStatus = {
  state: AuthState
  customerId: string | null
  isPaymentValid: boolean | null
  authorizationLink: string | null
}

const USER_DASHBOARD_URL = 'https://user-api.erpc.global/v3/user/dashboard'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return null
}

function collectCandidates(
  payload: Record<string, unknown> | null,
): Record<string, unknown>[] {
  if (!payload) return []

  const candidates: Record<string, unknown>[] = []
  const push = (value: unknown) => {
    const record = asRecord(value)
    if (record) candidates.push(record)
  }

  push(payload)
  push(payload.message)
  push(payload.data)
  push(payload.user)
  push(payload.profile)
  push(payload.account)
  push(payload.dashboard)

  const message = asRecord(payload.message)
  push(message?.user)
  push(message?.profile)
  push(message?.account)

  const data = asRecord(payload.data)
  push(data?.user)
  push(data?.profile)
  push(data?.account)

  return candidates
}

function getCustomerId(candidates: Record<string, unknown>[]): string | null {
  for (const candidate of candidates) {
    const customerId = firstString(
      candidate.customerId,
      candidate.customer_id,
      candidate.stripeCustomerId,
      candidate.stripe_customer_id,
    )
    if (customerId) return customerId
  }
  return null
}

function getIsPaymentValid(
  candidates: Record<string, unknown>[],
): boolean | null {
  for (const candidate of candidates) {
    const isPaymentValid = firstBoolean(
      candidate.isPaymentValid,
      candidate.is_payment_valid,
      candidate.paymentValid,
      candidate.payment_valid,
    )
    if (isPaymentValid !== null) return isPaymentValid
  }
  return null
}

function getAuthorizationLink(
  candidates: Record<string, unknown>[],
): string | null {
  for (const candidate of candidates) {
    const authorizationLink = firstString(
      candidate.authorizationLink,
      candidate.authorization_link,
      candidate.authorizationUrl,
      candidate.authorization_url,
      candidate.authLink,
      candidate.auth_link,
      candidate.authUrl,
      candidate.auth_url,
      candidate.paymentLink,
      candidate.payment_link,
      candidate.paymentUrl,
      candidate.payment_url,
    )
    if (authorizationLink) return authorizationLink
  }
  return null
}

export function getAuthorizationStatus(
  payload: Record<string, unknown> | null | undefined,
): AuthorizationStatus {
  const candidates = collectCandidates(payload ?? null)
  if (candidates.length === 0) {
    return {
      state: 'unknown',
      customerId: null,
      isPaymentValid: null,
      authorizationLink: null,
    }
  }

  const customerId = getCustomerId(candidates)
  const isPaymentValid = getIsPaymentValid(candidates)
  const authorizationLink = getAuthorizationLink(candidates)

  return {
    state: customerId ? 'authorized' : 'unauthorized',
    customerId,
    isPaymentValid,
    authorizationLink,
  }
}

export async function fetchAuthorizationStatus(
  apiKey: string,
): Promise<AuthorizationStatus> {
  try {
    const response = await fetch(USER_DASHBOARD_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) {
      return {
        state: 'unknown',
        customerId: null,
        isPaymentValid: null,
        authorizationLink: null,
      }
    }

    const data = await response.json() as Record<string, unknown>
    return getAuthorizationStatus(data)
  } catch {
    return {
      state: 'unknown',
      customerId: null,
      isPaymentValid: null,
      authorizationLink: null,
    }
  }
}
