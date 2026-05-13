// getTransactionsForAddress — Helius-wire-compatible JSON-RPC method backed
// by the `gtfa_tx_mentions` ClickHouse table emitted by slv-gtfa-plugin
// (see vs2-app/elsoul-proxy/slv_gtfa_plugin).
//
// Phase 1: `transactionDetails: "signatures"` only.  Full mode (with of1
// `getTransaction` fan-out) lands in a follow-up.
//
// Request:
//   { jsonrpc: "2.0", id, method: "getTransactionsForAddress",
//     params: [ "<base58 pubkey>", {
//       transactionDetails?: "signatures" | "full",     // "full" rejected in v1
//       sortOrder?:          "desc" | "asc",            // default "desc"
//       limit?:              <int, max 1000>,           // default 100
//       paginationToken?:    "<slot>:<txIndex>",        // cursor
//       commitment?:         "finalized" | "confirmed", // no-op (always finalized)
//       filters?: {
//         slot?:      { gte?: int, gt?: int, lte?: int, lt?: int, eq?: int },
//         blockTime?: { gte?: int, gt?: int, lte?: int, lt?: int, eq?: int },
//         signature?: { eq?: "<base58>" },
//         status?:    "succeeded" | "failed" | "any",
//       },
//     } ] }
//
// Response:
//   { result: { transactions: [{ signature, slot, transactionIndex,
//       blockTime, status }], paginationToken: "<slot>:<txIndex>" | null } }

import { ClickHouseClient, quoteString } from '../lib/clickhouse.ts'
import { err, ERROR_CODES, type JsonRpcRequest, type JsonRpcResponse, ok } from '../jsonrpc.ts'

const DEFAULT_LIMIT = 100
const MAX_LIMIT_SIGNATURES = 1000

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const BASE58_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing ${name}`)
  return v
}

function asBase58Pubkey(v: unknown, name: string): string {
  const s = asString(v, name)
  if (!BASE58_RE.test(s)) throw new Error(`invalid ${name}: not a valid base58 pubkey`)
  return s
}

function asBase58Signature(v: unknown, name: string): string {
  const s = asString(v, name)
  if (!BASE58_SIG_RE.test(s)) throw new Error(`invalid ${name}: not a valid base58 signature`)
  return s
}

function asInt(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`invalid ${name}: expected non-negative integer`)
  }
  return n
}

type Cmp = { gte?: number; gt?: number; lte?: number; lt?: number; eq?: number }

function parseCmp(raw: unknown, name: string): Cmp {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid ${name}: expected object with gte/gt/lte/lt/eq`)
  }
  const o = raw as Record<string, unknown>
  const out: Cmp = {}
  for (const k of ['gte', 'gt', 'lte', 'lt', 'eq'] as const) {
    if (o[k] !== undefined) out[k] = asInt(o[k], `${name}.${k}`)
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`invalid ${name}: at least one of gte/gt/lte/lt/eq required`)
  }
  return out
}

function cmpToSql(col: string, cmp: Cmp): string[] {
  const parts: string[] = []
  if (cmp.eq !== undefined) parts.push(`${col} = ${cmp.eq}`)
  if (cmp.gte !== undefined) parts.push(`${col} >= ${cmp.gte}`)
  if (cmp.gt !== undefined) parts.push(`${col} > ${cmp.gt}`)
  if (cmp.lte !== undefined) parts.push(`${col} <= ${cmp.lte}`)
  if (cmp.lt !== undefined) parts.push(`${col} < ${cmp.lt}`)
  return parts
}

/**
 * Parse Helius-style positional params: `[ addressBase58, optionsObj? ]`.
 * Helius also tolerates a single object with `address` inside — we accept
 * that variant for symmetry with `jet_*` ergonomics.
 */
function parseParams(params: unknown): {
  address: string
  options: Record<string, unknown>
} {
  if (Array.isArray(params)) {
    if (params.length < 1) throw new Error('missing address (first positional param)')
    const address = asBase58Pubkey(params[0], 'address')
    const options = params.length >= 2 && params[1] !== null && params[1] !== undefined
      ? (params[1] as Record<string, unknown>)
      : {}
    if (typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('invalid options: expected object')
    }
    return { address, options }
  }
  if (typeof params === 'object' && params !== null) {
    const o = params as Record<string, unknown>
    if (o.address === undefined) throw new Error('missing address')
    return { address: asBase58Pubkey(o.address, 'address'), options: o }
  }
  throw new Error('missing params')
}

function parsePaginationToken(s: string): { slot: number; txIndex: number } {
  const idx = s.indexOf(':')
  if (idx <= 0) throw new Error('invalid paginationToken: expected "<slot>:<txIndex>"')
  const slot = asInt(s.slice(0, idx), 'paginationToken.slot')
  const txIndex = asInt(s.slice(idx + 1), 'paginationToken.txIndex')
  return { slot, txIndex }
}

export class GtfaHandlers {
  constructor(private ch: ClickHouseClient) {}

  /**
   * Helius-wire-compatible.  Phase 1: signatures mode only.
   *
   * Notes:
   * - `commitment` is a no-op in v1.  All data in `gtfa_tx_mentions` comes
   *   from yellowstone-faithful via slv-jetstreamer, which by definition
   *   only carries finalized slots.
   * - `transactionDetails: "full"` is rejected with METHOD_NOT_FOUND-style
   *   message in v1 (will be added with of1 fan-out in Phase 2).
   * - `tokenAccounts` and `encoding=jsonParsed` are Phase 3.
   */
  async getTransactionsForAddress(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const { address, options } = parseParams(req.params)

      const transactionDetails = options.transactionDetails === undefined
        ? 'signatures'
        : asString(options.transactionDetails, 'transactionDetails')
      if (transactionDetails !== 'signatures') {
        return err(
          req.id ?? null,
          ERROR_CODES.INVALID_PARAMS,
          `transactionDetails="${transactionDetails}" not yet supported; ` +
            `only "signatures" is implemented in this version`,
        )
      }

      const sortOrderRaw = options.sortOrder === undefined
        ? 'desc'
        : asString(options.sortOrder, 'sortOrder')
      if (sortOrderRaw !== 'desc' && sortOrderRaw !== 'asc') {
        throw new Error(`invalid sortOrder: expected "desc" or "asc"`)
      }
      const desc = sortOrderRaw === 'desc'

      const limit = options.limit === undefined
        ? DEFAULT_LIMIT
        : Math.min(asInt(options.limit, 'limit'), MAX_LIMIT_SIGNATURES)
      if (limit === 0) {
        return ok(req.id ?? null, { transactions: [], paginationToken: null })
      }

      const where: string[] = [
        `pubkey = base58Decode(${quoteString(address)})`,
      ]

      // Filters
      const filters = options.filters
      if (filters !== undefined) {
        if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
          throw new Error('invalid filters: expected object')
        }
        const f = filters as Record<string, unknown>
        if (f.slot !== undefined) where.push(...cmpToSql('slot', parseCmp(f.slot, 'filters.slot')))
        if (f.blockTime !== undefined) {
          where.push(...cmpToSql('block_time', parseCmp(f.blockTime, 'filters.blockTime')))
        }
        if (f.signature !== undefined) {
          if (typeof f.signature !== 'object' || f.signature === null) {
            throw new Error('invalid filters.signature: expected object with eq')
          }
          const sigObj = f.signature as Record<string, unknown>
          if (sigObj.eq === undefined) {
            throw new Error('invalid filters.signature: only { eq } supported')
          }
          const sigB58 = asBase58Signature(sigObj.eq, 'filters.signature.eq')
          where.push(`signature = base58Decode(${quoteString(sigB58)})`)
        }
        if (f.status !== undefined) {
          const s = asString(f.status, 'filters.status')
          if (s === 'succeeded') where.push('status = 1')
          else if (s === 'failed') where.push('status = 0')
          else if (s === 'any') { /* no predicate */ }
          else throw new Error(`invalid filters.status: expected "succeeded" | "failed" | "any"`)
        }
        if (f.tokenAccounts !== undefined && f.tokenAccounts !== 'none') {
          return err(
            req.id ?? null,
            ERROR_CODES.INVALID_PARAMS,
            `filters.tokenAccounts="${f.tokenAccounts}" not yet supported; ` +
              `only "none" is implemented in this version`,
          )
        }
      }

      // Pagination cursor (strict-less-than for desc, strict-greater-than for asc).
      if (options.paginationToken !== undefined) {
        const tok = parsePaginationToken(asString(options.paginationToken, 'paginationToken'))
        if (desc) {
          where.push(
            `(slot < ${tok.slot} OR (slot = ${tok.slot} AND transaction_index < ${tok.txIndex}))`,
          )
        } else {
          where.push(
            `(slot > ${tok.slot} OR (slot = ${tok.slot} AND transaction_index > ${tok.txIndex}))`,
          )
        }
      }

      // Commitment field — accept but ignore (data is always finalized).
      if (options.commitment !== undefined) {
        const c = asString(options.commitment, 'commitment')
        if (c !== 'finalized' && c !== 'confirmed') {
          throw new Error(`invalid commitment: expected "finalized" or "confirmed"`)
        }
      }

      const orderDir = desc ? 'DESC' : 'ASC'
      // Subquery isolates the WHERE clause from the SELECT projection.
      // ClickHouse resolves identifiers in WHERE against SELECT aliases —
      // if we alias `signature` to a base58 string in the outer SELECT,
      // `WHERE signature = base58Decode(...)` would compare String to
      // FixedString and silently match nothing.  Keeping the predicates
      // in an inner SELECT against the raw columns avoids that trap.
      // LIMIT N+1 — the (N+1)th row, if present, becomes the pagination token.
      const sql = `
        SELECT
          base58Encode(signature) AS signature,
          slot,
          transaction_index AS transactionIndex,
          block_time AS blockTime,
          if(status = 1, 'succeeded', 'failed') AS status
        FROM (
          SELECT signature, slot, transaction_index, block_time, status
          FROM gtfa_tx_mentions
          WHERE ${where.join(' AND ')}
          ORDER BY slot ${orderDir}, transaction_index ${orderDir}
          LIMIT ${limit + 1}
        )
        ORDER BY slot ${orderDir}, transaction_index ${orderDir}
      `

      const rows = await this.ch.query<{
        signature: string
        slot: number
        transactionIndex: number
        blockTime: number
        status: 'succeeded' | 'failed'
      }>(sql)

      let paginationToken: string | null = null
      if (rows.length > limit) {
        const sentinel = rows[limit]
        paginationToken = `${sentinel.slot}:${sentinel.transactionIndex}`
        rows.length = limit
      }

      return ok(req.id ?? null, { transactions: rows, paginationToken })
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }
}
