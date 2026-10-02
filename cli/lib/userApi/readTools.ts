/**
 * Fixed, read-only user-api route table for the AI console's
 * `call_mcp` tool. Every entry is a GET — there is no mutation path
 * through this table by construction (the `method` field is typed
 * to the `'GET'` literal). Names follow the existing `call_mcp` tool
 * names (`<method>_<path segments>`, with `/v3` dropped).
 *
 * `{param}` segments in `path` are filled from the caller's
 * arguments and percent-encoded. `query` lists every other argument
 * name the route accepts; anything not in `query` and not a path
 * param is rejected without sending a request — the model cannot
 * smuggle an arbitrary parameter onto a request just by naming it.
 */
import { type UserApiAuth, userApiRequestRaw } from '/lib/userApi/client.ts'

export type ReadToolEntry = {
  method: 'GET'
  path: string
  /** Query parameter names this route accepts. Omit for none. */
  query?: readonly string[]
}

export const READ_TOOLS: Record<string, ReadToolEntry> = {
  get_user_get: { method: 'GET', path: '/v3/user/get' },
  get_user_dashboard: { method: 'GET', path: '/v3/user/dashboard' },
  get_user_profile_avatar_user_id_file_name: {
    method: 'GET',
    path: '/v3/user/profile/avatar/{userId}/{fileName}',
    // Tokened avatar URLs carry `?token=…` and 404 without it.
    query: ['token'],
  },
  get_user_subscription: { method: 'GET', path: '/v3/user/subscription' },
  get_user_unsubscribe_success: {
    method: 'GET',
    path: '/v3/user/unsubscribe/success',
  },
  get_user_billing_address: {
    method: 'GET',
    path: '/v3/user/billing-address',
  },
  get_user_credit_receipts_invoice_number_pdf: {
    method: 'GET',
    path: '/v3/user/credit-receipts/{invoiceNumber}/pdf',
    query: ['token'],
  },
  get_user_credit_snapshot: {
    method: 'GET',
    path: '/v3/user/credit-snapshot',
  },
  get_user_credit_auto_buy: {
    method: 'GET',
    path: '/v3/user/credit-auto-buy',
  },
  get_user_hourly_cancellation_schedules: {
    method: 'GET',
    path: '/v3/user/hourly-cancellation-schedules',
  },
  get_erpc_usage: { method: 'GET', path: '/v3/erpc/usage' },
  get_erpc_usage_daily: {
    method: 'GET',
    path: '/v3/erpc/usage-daily',
    query: ['days'],
  },
  get_grpc_status: { method: 'GET', path: '/v3/grpc/status' },
  get_shreds_shared_status: {
    method: 'GET',
    path: '/v3/shreds-shared/status',
  },
  get_vps_list_public: { method: 'GET', path: '/v3/vps/list/public' },
  get_vps_list_public_annual: {
    method: 'GET',
    path: '/v3/vps/list/public/annual',
  },
  get_vps_status: { method: 'GET', path: '/v3/vps/status' },
  get_vps_search_available_vps: {
    method: 'GET',
    path: '/v3/vps/search-available-vps',
    query: ['name', 'region', 'cpu', 'ram', 'disk', 'limit', 'cursor'],
  },
  get_super_vps_list_public: {
    method: 'GET',
    path: '/v3/super-vps/list/public',
  },
  get_super_vps_list_public_annual: {
    method: 'GET',
    path: '/v3/super-vps/list/public/annual',
  },
  get_super_vps_search_available_vps: {
    method: 'GET',
    path: '/v3/super-vps/search-available-vps',
    query: ['name', 'region', 'cpu', 'ram', 'disk', 'limit', 'cursor'],
  },
  get_super_vps_my_vps: { method: 'GET', path: '/v3/super-vps/my-vps' },
  get_premium_vps_list_public: {
    method: 'GET',
    path: '/v3/premium-vps/list/public',
  },
  get_premium_vps_list_public_annual: {
    method: 'GET',
    path: '/v3/premium-vps/list/public/annual',
  },
  get_premium_vps_search_available_vps: {
    method: 'GET',
    path: '/v3/premium-vps/search-available-vps',
    query: ['name', 'region', 'cpu', 'ram', 'disk', 'limit', 'cursor'],
  },
  get_premium_vps_my_vps: {
    method: 'GET',
    path: '/v3/premium-vps/my-vps',
  },
  get_user_unlimited_status: {
    method: 'GET',
    path: '/v3/user-unlimited/status',
  },
  get_shreds_dedicated_status: {
    method: 'GET',
    path: '/v3/shreds-dedicated/status',
  },
  get_geyser_grpc_status: {
    method: 'GET',
    path: '/v3/geyser-grpc/status',
  },
  get_dedicated_status: { method: 'GET', path: '/v3/dedicated/status' },
  get_baremetal_list_public_node_type: {
    method: 'GET',
    path: '/v3/baremetal/list/public/{nodeType}',
  },
  get_baremetal_list_public_node_type_annual: {
    method: 'GET',
    path: '/v3/baremetal/list/public/{nodeType}/annual',
  },
  get_baremetal_status: { method: 'GET', path: '/v3/baremetal/status' },
  get_baremetal_availability: {
    method: 'GET',
    path: '/v3/baremetal/availability',
  },
  get_baremetal_search_available_baremetal: {
    method: 'GET',
    path: '/v3/baremetal/search-available-baremetal',
    query: [
      'name',
      'region',
      'productId',
      'priceId',
      'cpu',
      'provider',
      'ram',
      'disk',
      'limit',
      'cursor',
    ],
  },
  get_rpc_index_status: { method: 'GET', path: '/v3/rpc-index/status' },
  get_epic_shreds_direct_availability: {
    method: 'GET',
    path: '/v3/epic-shreds-direct/availability',
  },
  get_epic_shreds_direct_my: {
    method: 'GET',
    path: '/v3/epic-shreds-direct/my',
  },
  get_billing_get_product_by_product_id: {
    method: 'GET',
    path: '/v3/billing/get-product-by-product-id',
    query: ['productId'],
  },
  get_billing_my_subscriptions: {
    method: 'GET',
    path: '/v3/billing/my-subscriptions',
  },
  get_billing_bdlc_status: {
    method: 'GET',
    path: '/v3/billing/bdlc-status',
  },
  get_billing_credit_balance: {
    method: 'GET',
    path: '/v3/billing/credit/balance',
  },
  get_billing_credit_transactions: {
    method: 'GET',
    path: '/v3/billing/credit/transactions',
    query: [
      'cursor',
      'limit',
      'kind',
      'source',
      'productType',
      'createdAtFrom',
      'createdAtTo',
    ],
  },
  get_billing_credit_summary: {
    method: 'GET',
    path: '/v3/billing/credit/summary',
    query: [
      'kind',
      'source',
      'productType',
      'createdAtFrom',
      'createdAtTo',
      'bucket',
    ],
  },
  get_billing_credit_recurring_catalog: {
    method: 'GET',
    path: '/v3/billing/credit-recurring/catalog',
  },
  get_billing_credit_recurring_pending_changes: {
    method: 'GET',
    path: '/v3/billing/credit-recurring/pending-changes',
  },
  get_billing_user_ssh: { method: 'GET', path: '/v3/billing/user-ssh' },
  get_storage_list: {
    method: 'GET',
    path: '/v3/storage/list',
    query: ['prefix', 'region', 'limit', 'cursor'],
  },
  get_storage_usage: { method: 'GET', path: '/v3/storage/usage' },
  get_storage_restic_config: {
    method: 'GET',
    path: '/v3/storage/restic/config',
  },
  get_storage_restic_type: {
    method: 'GET',
    path: '/v3/storage/restic/{type}',
  },
  get_storage_restic_type_id: {
    method: 'GET',
    path: '/v3/storage/restic/{type}/{id}',
  },
  get_ai_usage: {
    method: 'GET',
    path: '/v3/ai/usage',
    query: ['boost'],
  },
  get_dns_status: { method: 'GET', path: '/v3/dns/status' },
  get_system_health: {
    method: 'GET',
    path: '/v3/system/health',
    query: ['service', 'window'],
  },
  get_system_uptime: {
    method: 'GET',
    path: '/v3/system/uptime',
    query: ['days'],
  },
  get_system_announcements: {
    method: 'GET',
    path: '/v3/system/announcements',
    query: ['locale'],
  },
  get_subscription_subscription_id_migration_preview: {
    method: 'GET',
    path: '/v3/subscription/{subscriptionId}/migration-preview',
  },
  get_support_chat_rooms: {
    method: 'GET',
    path: '/v3/support-chat/rooms',
    query: ['category', 'type', 'status', 'priority', 'limit', 'cursor'],
  },
  get_support_chat_rooms_chat_room_id: {
    method: 'GET',
    path: '/v3/support-chat/rooms/{chatRoomId}',
  },
  get_support_chat_rooms_chat_room_id_messages: {
    method: 'GET',
    path: '/v3/support-chat/rooms/{chatRoomId}/messages',
    query: ['limit', 'cursor'],
  },
  get_support_chat_rooms_chat_room_id_attachments_attachment_id: {
    method: 'GET',
    path:
      '/v3/support-chat/rooms/{chatRoomId}/attachments/{attachmentId}/{fileName}',
    query: ['token'],
  },
  get_waitlist_my_entries: {
    method: 'GET',
    path: '/v3/waitlist/my-entries',
  },
}

const PATH_PARAM_RE = /\{([a-zA-Z0-9_]+)\}/g

// Every failure string `callReadTool` returns starts with one of
// these — used by callers (the console's response-cache) to tell a
// real answer from a failure without re-parsing it.
const FAILURE_PREFIXES = [
  'Unknown tool: ',
  'Invalid or missing path argument: ',
  'Unknown argument for ',
  'Request failed (',
]

export const isReadToolFailure = (result: string): boolean =>
  FAILURE_PREFIXES.some((prefix) => result.startsWith(prefix))

/**
 * Reject empty, `.`, `..`, and any value that *decodes* to one of
 * those — a caller-supplied path segment that looks like a plain
 * string today but would walk a directory/route segment once
 * percent-decoded again downstream. Malformed percent-encoding
 * can't be proven safe, so it's rejected too.
 */
const isUnsafePathValue = (raw: string): boolean => {
  if (raw === '' || raw === '.' || raw === '..') return true
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded === '' || decoded === '.' || decoded === '..') return true
  } catch {
    return true
  }
  return false
}

/**
 * Call one of the fixed GET tools above. Returns a plain string —
 * either the response body, a formatted failure, or an explanatory
 * message for a bad call — since this is the console AI's view of
 * the result, not a typed API surface.
 */
export const callReadTool = async (
  auth: UserApiAuth,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> => {
  // `Object.hasOwn` (not `name in READ_TOOLS` or `READ_TOOLS[name]`)
  // so a model-supplied name like `constructor` or `toString` can't
  // resolve to an inherited `Object.prototype` value and crash the
  // path-building step below — it falls through to "Unknown tool"
  // like any other name not in the table.
  if (!Object.hasOwn(READ_TOOLS, name)) return `Unknown tool: ${name}`
  const entry = READ_TOOLS[name]

  const usedKeys = new Set<string>()
  let invalidParam: string | null = null
  const path = entry.path.replace(PATH_PARAM_RE, (match, key: string) => {
    usedKeys.add(key)
    if (invalidParam) return match
    const value = args[key]
    if (value === undefined || value === null) {
      invalidParam = key
      return match
    }
    const str = String(value)
    if (isUnsafePathValue(str)) {
      invalidParam = key
      return match
    }
    return encodeURIComponent(str)
  })
  if (invalidParam) {
    return `Invalid or missing path argument: ${invalidParam}`
  }

  const allowedQuery = new Set(entry.query ?? [])
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) {
    if (usedKeys.has(key)) continue
    if (value === undefined || value === null) continue
    if (!allowedQuery.has(key)) {
      return `Unknown argument for ${name}: ${key}`
    }
    query.set(key, String(value))
  }
  const qs = query.toString()
  const fullPath = `${path}${qs ? `?${qs}` : ''}`

  const res = await userApiRequestRaw(auth, entry.method, fullPath)
  if (!res.ok) {
    return `Request failed (${res.status} ${res.statusText}).\n${res.raw}`
  }
  return res.raw
}
