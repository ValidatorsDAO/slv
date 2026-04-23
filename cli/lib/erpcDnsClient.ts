/**
 * Typed client for the erpc `/v3/dns/*` endpoints.
 *
 * Every authenticated SLV user gets a deterministic default
 * subdomain under `*.erpc.global` (slug derived from their user
 * id), proxied through Cloudflare's Universal SSL — so pointing
 * this default at a VPS IP gives the user HTTPS with no cert work
 * on the origin. Custom slugs exist for paid tiers but return 402
 * until the Stripe product launches.
 *
 * These functions wrap the HTTP surface; callers still need to
 * handle the documented non-200 cases (403 `ip_not_owned`, 402
 * `premium_required`, etc.) — we surface status + body verbatim
 * rather than throwing, so the CLI layer can render targeted
 * error messages.
 */

export type DnsRecord = {
  fqdn: string
  slug: string
  ip: string | null
  proxied: boolean
  exists: boolean
  updatedAt: string | null
}

export type DnsCustomRecord = DnsRecord & { plan: 'paid' }

export type DnsStatusResponse = {
  default: DnsRecord
  custom: DnsCustomRecord[]
}

export type DnsSetSuccessResponse = {
  success: true
  fqdn: string
  slug: string
  ip: string
  proxied: boolean
  message: string
}

export type DnsApiError = {
  error: string
  message: string
  [k: string]: unknown
}

export type DnsSetResult =
  | { ok: true; data: DnsSetSuccessResponse }
  | { ok: false; status: number; body: DnsApiError | null }

export type DnsStatusResult =
  | { ok: true; data: DnsStatusResponse }
  | { ok: false; status: number; body: unknown }

const ERPC_BASE = 'https://user-api.erpc.global'

/**
 * Fetch the caller's DNS state (default slug + any custom slugs).
 * Non-200s are surfaced via {ok:false}; network errors throw and
 * are the caller's problem.
 */
export const getDnsStatus = async (
  apiKey: string,
): Promise<DnsStatusResult> => {
  const res = await fetch(`${ERPC_BASE}/v3/dns/status`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      /* non-JSON body — body stays null */
    }
    return { ok: false, status: res.status, body }
  }
  const data = (await res.json()) as DnsStatusResponse
  return { ok: true, data }
}

/**
 * Point an A record at a VPS IP. Omit `slug` to configure the
 * default subdomain (always available). Pass `slug` for a custom
 * name — currently gated on 402 `premium_required`.
 */
export const setDnsRecord = async (
  apiKey: string,
  opts: { ip: string; slug?: string; proxied?: boolean },
): Promise<DnsSetResult> => {
  const body: Record<string, unknown> = { ip: opts.ip }
  if (opts.slug) body.slug = opts.slug
  if (typeof opts.proxied === 'boolean') body.proxied = opts.proxied

  const res = await fetch(`${ERPC_BASE}/v3/dns/set`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let err: DnsApiError | null = null
    try {
      err = (await res.json()) as DnsApiError
    } catch {
      /* non-JSON */
    }
    return { ok: false, status: res.status, body: err }
  }
  const data = (await res.json()) as DnsSetSuccessResponse
  return { ok: true, data }
}

/**
 * Delete an A record by slug. The slug must be the caller's — a
 * slug owned by another user returns 403 `not_owner`.
 */
export const deleteDnsRecord = async (
  apiKey: string,
  slug: string,
): Promise<DnsSetResult> => {
  const res = await fetch(`${ERPC_BASE}/v3/dns/delete`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ slug }),
  })
  if (!res.ok) {
    let err: DnsApiError | null = null
    try {
      err = (await res.json()) as DnsApiError
    } catch {
      /* non-JSON */
    }
    return { ok: false, status: res.status, body: err }
  }
  const data = (await res.json()) as DnsSetSuccessResponse
  return { ok: true, data }
}

/**
 * Human-readable explanation for the common error responses from
 * `/v3/dns/set`. Kept here so the CLI and any future skill doc can
 * use identical wording.
 */
export const explainDnsSetError = (result: {
  status: number
  body: DnsApiError | null
}): string => {
  const err = result.body?.error ?? ''
  const msg = result.body?.message ?? ''
  switch (result.status) {
    case 401:
      return 'SLV API key missing or invalid — run `slv login`.'
    case 402:
      return msg ||
        'Custom subdomains require a paid subscription (not yet launched).'
    case 403:
      if (err === 'ip_not_owned') {
        return 'The detected IP is not registered against your account. Register the VPS in erpc first, or pass --ip <owned-ip>.'
      }
      if (err === 'not_owner') {
        return msg || 'That slug is already claimed by another user.'
      }
      return msg || 'Forbidden.'
    case 400:
      return msg || 'Bad request.'
    default:
      return msg || `DNS set failed with status ${result.status}.`
  }
}
