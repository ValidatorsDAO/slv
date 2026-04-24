/**
 * Single entry point for the SLV Cloud MCP at
 * `https://mcp-slv-cloud.erpc.global/mcp`. All user-api operations
 * we need from onboard / install flows (DNS state, DNS set,
 * support ticket creation) go through the same MCP channel.
 *
 * Response shape (MCP JSON-RPC 2.0, method `tools/call`):
 *   success: { result: { content: [{text: "<json-string>"}], isError: false } }
 *   tool err: { result: { content: [{text: "Request failed (NNN Status).\\n<json>"}], isError: true } }
 *   proto err:{ error: { code, message } }
 *
 * We parse both paths and return a discriminated union the
 * callers can switch on without string-matching.
 */

const MCP_URL = 'https://mcp-slv-cloud.erpc.global/mcp'

export type McpResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; body: McpErrorBody | null; raw: string }

export type McpErrorBody = {
  error?: string
  message?: string
  [k: string]: unknown
}

type RawResponse = {
  error?: { code?: number; message?: string }
  result?: {
    content?: Array<{ type: string; text: string }>
    isError?: boolean
  }
}

/**
 * Call a single tool by name. The caller provides the expected
 * success shape as T; we JSON-parse the content text on success
 * and best-effort-parse the error body on failure. Network errors
 * throw (they're never expected in normal flows and masking them
 * would hide real outages).
 */
export const callMcpTool = async <T>(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<McpResult<T>> => {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })

  // HTTP-level failure (401 at MCP gate, 5xx, etc.) short-circuits
  // before we try to parse a result envelope.
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
    } catch { /* ignore */ }
    return { ok: false, status: res.status, body: null, raw: text }
  }

  const data = (await res.json()) as RawResponse
  if (data.error) {
    return {
      ok: false,
      status: data.error.code ?? 500,
      body: { error: 'mcp_protocol_error', message: data.error.message ?? '' },
      raw: JSON.stringify(data.error),
    }
  }

  const text = data.result?.content?.[0]?.text ?? ''
  if (data.result?.isError) {
    // Tool returned an error. Convention across the cloud MCP is
    // `Request failed (<status> <text>).\n<json-body>`; parse both
    // pieces so callers can branch on HTTP status + typed body.
    const match = text.match(/Request failed \((\d+)[^)]*\)\.?\s*(\{[\s\S]*)/)
    const status = match ? Number(match[1]) : 400
    const body = match ? safeJsonParse<McpErrorBody>(match[2]) : null
    return { ok: false, status, body, raw: text }
  }
  const parsed = safeJsonParse<T>(text)
  if (parsed === null) {
    return {
      ok: false,
      status: 500,
      body: { error: 'parse_error', message: 'tool response was not valid JSON' },
      raw: text,
    }
  }
  return { ok: true, data: parsed }
}

const safeJsonParse = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ---------- Typed wrappers ------------------------------------------------
//
// Keep the same result shapes the prior direct-REST client had so
// callers (dns/index.ts, install/nginxFlow.ts, onboard) don't care
// that the transport flipped to MCP. If the shapes drift on the
// server side, this is the one file to update.

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
export type DnsApiError = McpErrorBody

export type DnsStatusResult =
  | { ok: true; data: DnsStatusResponse }
  | { ok: false; status: number; body: DnsApiError | null }

export type DnsSetResult =
  | { ok: true; data: DnsSetSuccessResponse }
  | { ok: false; status: number; body: DnsApiError | null }

export const getDnsStatus = async (
  apiKey: string,
): Promise<DnsStatusResult> => {
  const r = await callMcpTool<DnsStatusResponse>(apiKey, 'get_dns_status')
  if (r.ok) return { ok: true, data: r.data }
  return { ok: false, status: r.status, body: r.body }
}

export const setDnsRecord = async (
  apiKey: string,
  opts: { ip: string; slug?: string; proxied?: boolean },
): Promise<DnsSetResult> => {
  const args: Record<string, unknown> = { ip: opts.ip }
  if (opts.slug) args.slug = opts.slug
  if (typeof opts.proxied === 'boolean') args.proxied = opts.proxied
  const r = await callMcpTool<DnsSetSuccessResponse>(apiKey, 'post_dns_set', args)
  if (r.ok) return { ok: true, data: r.data }
  return { ok: false, status: r.status, body: r.body }
}

export type DnsDeleteSuccessResponse = {
  success: true
  fqdn: string
  // Absent when deleting the free default (server may omit).
  slug?: string
  message?: string
}

export type DnsDeleteResult =
  | { ok: true; data: DnsDeleteSuccessResponse }
  | { ok: false; kind: 'tool_not_found'; status: number; body: DnsApiError | null }
  | { ok: false; kind: 'error'; status: number; body: DnsApiError | null }

// Server decides whether "delete" means unset the IP or release the
// slug — wrapper passes args through as-is.
export const deleteDnsRecord = async (
  apiKey: string,
  opts: { slug?: string } = {},
): Promise<DnsDeleteResult> => {
  const args: Record<string, unknown> = {}
  if (opts.slug) args.slug = opts.slug
  const r = await callMcpTool<DnsDeleteSuccessResponse>(
    apiKey,
    'delete_dns',
    args,
  )
  if (r.ok) return { ok: true, data: r.data }
  // Disambiguate "server doesn't know this tool" from "record not
  // found" so the user gets an actionable error rather than a
  // misleading "No record found."
  const errCode = (r.body?.error ?? '').toString().toLowerCase()
  if (
    r.status === 404 &&
    (errCode === 'tool_not_found' ||
      errCode === 'unknown_tool' ||
      errCode === 'method_not_found')
  ) {
    return { ok: false, kind: 'tool_not_found', status: r.status, body: r.body }
  }
  return { ok: false, kind: 'error', status: r.status, body: r.body }
}

export const explainDnsDeleteError = (result: {
  kind?: 'tool_not_found' | 'error'
  status: number
  body: DnsApiError | null
}): string => {
  if (result.kind === 'tool_not_found') {
    return 'The SLV Cloud MCP does not expose a DNS delete tool yet — update your server / CLI or delete from https://dashboard.erpc.global.'
  }
  const err = result.body?.error ?? ''
  const msg = result.body?.message ?? ''
  switch (result.status) {
    case 401:
      return 'SLV API key missing or invalid — run `slv login`.'
    case 402:
      return msg ||
        'Deleting a custom slug requires a paid subscription (not yet launched).'
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
 * Tagged result shape that distinguishes "erpc returned an error"
 * (e.g. invalid_csr) from "the tool isn't deployed yet on this MCP"
 * (tool_not_found). The latter tells the CLI to fall back to a
 * self-signed cert so users on stale erpc deployments still get
 * something working.
 */
export type OriginCertResult =
  | { ok: true; data: OriginCertSuccess }
  | { ok: false; kind: 'tool_not_found' }
  | { ok: false; kind: 'error'; status: number; body: McpErrorBody | null }

export const requestOriginCert = async (
  apiKey: string,
  opts: { csr: string; slug?: string; validityDays?: number },
): Promise<OriginCertResult> => {
  const args: Record<string, unknown> = { csr: opts.csr }
  if (opts.slug) args.slug = opts.slug
  if (typeof opts.validityDays === 'number') {
    args.validity_days = opts.validityDays
  }
  const r = await callMcpTool<OriginCertSuccess>(
    apiKey,
    'post_dns_origin_cert',
    args,
  )
  if (r.ok) return { ok: true, data: r.data }

  // MCP-level "tool not found" = endpoint hasn't been deployed to
  // the cloud MCP yet. Detection is layered, from strongest to
  // weakest signal, to survive minor wording changes on the MCP
  // server side:
  //   1. HTTP 404 response status — the canonical "not found".
  //   2. Error code literals (`tool_not_found` / `UnknownTool`).
  //   3. Last-resort substring match on the human message.
  // Any of the three triggers the graceful self-signed fallback;
  // everything else surfaces as a real error to the caller.
  if (r.status === 404) {
    return { ok: false, kind: 'tool_not_found' }
  }
  const errCode = (r.body?.error ?? '').toString().toLowerCase()
  if (
    errCode === 'tool_not_found' ||
    errCode === 'unknown_tool' ||
    errCode === 'method_not_found'
  ) {
    return { ok: false, kind: 'tool_not_found' }
  }
  const msg = (r.body?.message ?? r.raw ?? '').toLowerCase()
  if (
    msg.includes('unknown tool') ||
    msg.includes('tool not found') ||
    msg.includes('no such tool')
  ) {
    return { ok: false, kind: 'tool_not_found' }
  }
  return { ok: false, kind: 'error', status: r.status, body: r.body }
}

export type SupportTicketResult =
  | { ok: true; link: string; message: string }
  | { ok: false; status: number; error: string }

export const openSupportTicket = async (
  apiKey: string,
  body: { title: string; description: string },
): Promise<SupportTicketResult> => {
  const r = await callMcpTool<{
    success?: boolean
    link?: string
    message?: string
  }>(apiKey, 'post_user_support_ticket', body)
  if (r.ok) {
    return {
      ok: true,
      link: r.data.link ?? '',
      message: r.data.message ?? '',
    }
  }
  return {
    ok: false,
    status: r.status,
    error: r.body?.message ?? r.raw,
  }
}

/**
 * Public-facing dashboard for provisioning SLV VPS / BareMetal.
 * Exposed as a constant so every flow that wants to point the
 * user there (onboard fallback, support ticket hints, Discord
 * notifications) lands on the same string.
 */
export const ERPC_DASHBOARD_URL = 'https://dashboard.erpc.global'
