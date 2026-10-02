/**
 * Direct client for the erpc `/v3/dns/*` routes. Replaces the old
 * SLV Cloud MCP indirection — same call-site shapes, straight
 * REST calls under the hood.
 */
import {
  type UserApiAuth,
  type UserApiErrorBody,
  userApiRequest,
} from '/lib/userApi/client.ts'

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
export type DnsDeleteSuccessResponse = {
  success: true
  fqdn: string
  // Absent when deleting the free default (server may omit).
  slug?: string
  message?: string
}
export type DnsApiError = UserApiErrorBody

export type DnsStatusResult =
  | { ok: true; data: DnsStatusResponse }
  | { ok: false; status: number; body: DnsApiError | null }

export const getDnsStatus = async (
  auth: UserApiAuth,
): Promise<DnsStatusResult> => {
  const r = await userApiRequest<DnsStatusResponse>(
    auth,
    'GET',
    '/v3/dns/status',
  )
  if (r.ok) return { ok: true, data: r.data }
  return { ok: false, status: r.status, body: r.body }
}

export type DnsSetResult =
  | { ok: true; data: DnsSetSuccessResponse }
  | { ok: false; status: number; body: DnsApiError | null }

export const setDnsRecord = async (
  auth: UserApiAuth,
  opts: { ip: string; slug?: string; proxied?: boolean },
): Promise<DnsSetResult> => {
  const body: Record<string, unknown> = { ip: opts.ip }
  if (opts.slug) body.slug = opts.slug
  if (typeof opts.proxied === 'boolean') body.proxied = opts.proxied
  const r = await userApiRequest<DnsSetSuccessResponse>(
    auth,
    'POST',
    '/v3/dns/set',
    body,
  )
  if (r.ok) return { ok: true, data: r.data }
  return { ok: false, status: r.status, body: r.body }
}

export type DnsDeleteResult =
  | { ok: true; data: DnsDeleteSuccessResponse }
  | { ok: false; status: number; body: DnsApiError | null }

/**
 * `/v3/dns/delete` requires `slug` in the body. When the caller
 * omits it (the common "delete my default subdomain" case), read
 * `/v3/dns/status` first to resolve the default slug. If that read
 * fails, the delete is never attempted — surfacing the status
 * failure is more honest than guessing a slug.
 */
export const deleteDnsRecord = async (
  auth: UserApiAuth,
  opts: { slug?: string } = {},
): Promise<DnsDeleteResult> => {
  let slug = opts.slug
  if (!slug) {
    const status = await getDnsStatus(auth)
    if (!status.ok) {
      return { ok: false, status: status.status, body: status.body }
    }
    slug = status.data.default.slug
  }
  const r = await userApiRequest<DnsDeleteSuccessResponse>(
    auth,
    'DELETE',
    '/v3/dns/delete',
    { slug },
  )
  if (r.ok) return { ok: true, data: r.data }
  return { ok: false, status: r.status, body: r.body }
}

/** Human-readable explanation for the common DNS set errors. */
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

export const explainDnsDeleteError = (result: {
  status: number
  body: DnsApiError | null
}): string => {
  const err = result.body?.error ?? ''
  const msg = result.body?.message ?? ''
  switch (result.status) {
    case 401:
      return 'SLV API key missing or invalid — run `slv login`.'
    case 403:
      if (err === 'not_owner') {
        return msg || 'That slug is owned by another user.'
      }
      return msg || 'Forbidden.'
    case 404:
      return msg || 'No record found to delete.'
    case 400:
      return msg || 'Bad request.'
    default:
      return msg || `DNS delete failed with status ${result.status}.`
  }
}

// ---------- Origin CA certificate issuance ------------------------------

export type OriginCertSuccess = {
  success: true
  fqdn: string
  /** PEM-encoded certificate chain signed by Cloudflare Origin CA. */
  certificate: string
  /** Cloudflare's raw `expires_on` string (ISO-ish). */
  expires_on: string
  /** Cloudflare certificate ID — kept for audit / future revocation. */
  certificate_id: string
}

/**
 * `not_available` means a 404 with a non-JSON body — the route
 * hasn't been deployed yet on this user-api (stale CLI/server
 * combination). The route never returns 404 for a real request, so
 * a JSON-bodied 404 (if it ever happens) still falls through to the
 * typed `error` branch instead of being swallowed as "not deployed".
 */
export type OriginCertResult =
  | { ok: true; data: OriginCertSuccess }
  | { ok: false; kind: 'not_available' }
  | { ok: false; kind: 'error'; status: number; body: UserApiErrorBody | null }

export const requestOriginCert = async (
  auth: UserApiAuth,
  opts: { csr: string; slug?: string; validityDays?: number },
): Promise<OriginCertResult> => {
  const body: Record<string, unknown> = { csr: opts.csr }
  if (opts.slug) body.slug = opts.slug
  if (typeof opts.validityDays === 'number') {
    body.validity_days = opts.validityDays
  }
  const r = await userApiRequest<OriginCertSuccess>(
    auth,
    'POST',
    '/v3/dns/origin-cert',
    body,
  )
  if (r.ok) return { ok: true, data: r.data }
  if (r.status === 404 && r.body === null) {
    return { ok: false, kind: 'not_available' }
  }
  return { ok: false, kind: 'error', status: r.status, body: r.body }
}
