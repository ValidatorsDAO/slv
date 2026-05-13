// getTransactionsForAddress — Helius-wire-compatible JSON-RPC method backed
// by the `gtfa_tx_mentions` ClickHouse table emitted by slv-gtfa-plugin
// (see vs2-app/elsoul-proxy/slv_gtfa_plugin).
//
// Two modes:
//   `signatures` — index-only response from ClickHouse
//   `full`       — same index lookup, then per-sig `getTransaction` fan-out
//                  to the upstream of1 (yellowstone-faithful + rolling cache)
//
// Request:
//   { jsonrpc: "2.0", id, method: "getTransactionsForAddress",
//     params: [ "<base58 pubkey>", {
//       transactionDetails?: "signatures" | "full",     // default "signatures"
//       sortOrder?:          "desc" | "asc",            // default "desc"
//       limit?:              <int>,                     // default 100 (max 1000
//                                                       //   sigs / 100 full)
//       paginationToken?:    "<slot>:<txIndex>",        // cursor
//       commitment?:         "finalized" | "confirmed", // no-op (always finalized)
//       encoding?:           "json" | "base64" | "base58",  // full mode only
//       maxSupportedTransactionVersion?: 0,              // full mode only
//       filters?: {
//         slot?:      { gte?: int, gt?: int, lte?: int, lt?: int, eq?: int },
//         blockTime?: { gte?: int, gt?: int, lte?: int, lt?: int, eq?: int },
//         signature?: { eq?: "<base58>" },
//         status?:    "succeeded" | "failed" | "any",
//       },
//     } ] }
//
// Response (signatures mode):
//   { result: { transactions: [{ signature, slot, transactionIndex,
//       blockTime, status }], paginationToken: "<slot>:<txIndex>" | null } }
//
// Response (full mode):
//   same shape plus `transaction`, `meta`, `version` per entry (taken from
//   the of1 `getTransaction` response).  If of1 lookup for a single sig
//   fails, the entry still appears but with `transaction: null` and an
//   `error: "<msg>"` field — the caller can retry that one sig if needed.

import { ClickHouseClient, quoteString } from '../lib/clickhouse.ts'
import { err, ERROR_CODES, type JsonRpcRequest, type JsonRpcResponse, ok } from '../jsonrpc.ts'

const DEFAULT_LIMIT = 100
const MAX_LIMIT_SIGNATURES = 1000
const MAX_LIMIT_FULL = 100

type Encoding = 'json' | 'jsonParsed' | 'base64' | 'base58'
const VALID_ENCODINGS: ReadonlyArray<Encoding> = ['json', 'jsonParsed', 'base64', 'base58']
const FULL_MODE_SUPPORTED_ENCODINGS: ReadonlyArray<Encoding> = ['json', 'base64', 'base58']

export type GtfaConfig = {
  of1Url: string
  of1TimeoutMs?: number
  /** Cap on simultaneous of1 getTransaction calls in full mode. */
  fullConcurrency?: number
}

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

type SigRow = {
  signature: string
  slot: number
  transactionIndex: number
  blockTime: number
  status: 'succeeded' | 'failed'
}

export class GtfaHandlers {
  private of1Url: string
  private of1TimeoutMs: number
  private fullConcurrency: number

  constructor(private ch: ClickHouseClient, cfg: GtfaConfig) {
    this.of1Url = cfg.of1Url
    this.of1TimeoutMs = cfg.of1TimeoutMs ?? 60_000
    this.fullConcurrency = Math.max(1, cfg.fullConcurrency ?? 20)
  }

  /**
   * Helius-wire-compatible.  Supports `signatures` and `full` modes.
   *
   * Notes:
   * - `commitment` is a no-op.  All data in `gtfa_tx_mentions` comes from
   *   yellowstone-faithful via slv-jetstreamer, which by definition only
   *   carries finalized slots.
   * - `tokenAccounts != "none"` and `encoding="jsonParsed"` return
   *   INVALID_PARAMS until the Phase 3 work lands.
   */
  async getTransactionsForAddress(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const { address, options } = parseParams(req.params)

      const transactionDetails = options.transactionDetails === undefined
        ? 'signatures'
        : asString(options.transactionDetails, 'transactionDetails')
      if (transactionDetails !== 'signatures' && transactionDetails !== 'full') {
        throw new Error(
          `invalid transactionDetails: expected "signatures" or "full"`,
        )
      }
      const fullMode = transactionDetails === 'full'

      // Encoding is only meaningful in full mode; in signatures mode it's
      // silently ignored.  We still validate it so a typo isn't masked.
      let encoding: Encoding = 'json'
      if (options.encoding !== undefined) {
        const e = asString(options.encoding, 'encoding')
        if (!(VALID_ENCODINGS as ReadonlyArray<string>).includes(e)) {
          throw new Error(
            `invalid encoding: expected one of ${VALID_ENCODINGS.join(', ')}`,
          )
        }
        encoding = e as Encoding
      }
      if (fullMode && !FULL_MODE_SUPPORTED_ENCODINGS.includes(encoding)) {
        return err(
          req.id ?? null,
          ERROR_CODES.INVALID_PARAMS,
          `encoding="${encoding}" not yet supported; ` +
            `full mode supports ${FULL_MODE_SUPPORTED_ENCODINGS.join(', ')}`,
        )
      }

      let maxSupportedTransactionVersion = 0
      if (options.maxSupportedTransactionVersion !== undefined) {
        maxSupportedTransactionVersion = asInt(
          options.maxSupportedTransactionVersion,
          'maxSupportedTransactionVersion',
        )
      }

      const sortOrderRaw = options.sortOrder === undefined
        ? 'desc'
        : asString(options.sortOrder, 'sortOrder')
      if (sortOrderRaw !== 'desc' && sortOrderRaw !== 'asc') {
        throw new Error(`invalid sortOrder: expected "desc" or "asc"`)
      }
      const desc = sortOrderRaw === 'desc'

      const maxLimit = fullMode ? MAX_LIMIT_FULL : MAX_LIMIT_SIGNATURES
      const limit = options.limit === undefined
        ? Math.min(DEFAULT_LIMIT, maxLimit)
        : Math.min(asInt(options.limit, 'limit'), maxLimit)
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

      const rows = await this.ch.query<SigRow>(sql)

      let paginationToken: string | null = null
      if (rows.length > limit) {
        const sentinel = rows[limit]
        paginationToken = `${sentinel.slot}:${sentinel.transactionIndex}`
        rows.length = limit
      }

      if (!fullMode) {
        return ok(req.id ?? null, { transactions: rows, paginationToken })
      }

      // Full mode: fan out to of1 with a concurrency cap.  We keep CH-sourced
      // fields authoritative (the index lookup is what the user asked for);
      // of1 contributes `transaction`, `meta`, `version`.
      const fullRows = await mapWithConcurrency(
        rows,
        this.fullConcurrency,
        async (row): Promise<FullRow> => {
          const fetched = await this.of1GetTransaction(
            row.signature,
            encoding,
            maxSupportedTransactionVersion,
          )
          if (fetched.kind === 'ok') {
            return {
              ...row,
              transaction: fetched.transaction,
              meta: fetched.meta,
              version: fetched.version,
            }
          }
          return {
            ...row,
            transaction: null,
            meta: null,
            version: null,
            error: fetched.error,
          }
        },
      )

      return ok(req.id ?? null, { transactions: fullRows, paginationToken })
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }

  private async of1GetTransaction(
    signature: string,
    encoding: Encoding,
    maxSupportedTransactionVersion: number,
  ): Promise<Of1Result> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.of1TimeoutMs)
    try {
      const res = await fetch(this.of1Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [signature, { encoding, maxSupportedTransactionVersion }],
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        return { kind: 'err', error: `of1 HTTP ${res.status}` }
      }
      const body = await res.json() as Record<string, unknown>
      if (body.error) {
        const e = body.error as { message?: string }
        return { kind: 'err', error: e.message ?? 'of1 error' }
      }
      const result = body.result as
        | { transaction?: unknown; meta?: unknown; version?: unknown }
        | null
        | undefined
      if (result == null) {
        // of1 returns null when the tx is outside the indexed window.  Keep
        // the entry in the response with `transaction: null` so the client
        // sees which signatures are missing without a separate retry path.
        return { kind: 'err', error: 'transaction not found in of1 window' }
      }
      return {
        kind: 'ok',
        transaction: result.transaction ?? null,
        meta: result.meta ?? null,
        version: result.version ?? null,
      }
    } catch (e) {
      return { kind: 'err', error: e instanceof Error ? e.message : String(e) }
    } finally {
      clearTimeout(timer)
    }
  }
}

type FullRow = SigRow & {
  transaction: unknown
  meta: unknown
  version: unknown
  error?: string
}

type Of1Result =
  | { kind: 'ok'; transaction: unknown; meta: unknown; version: unknown }
  | { kind: 'err'; error: string }

/**
 * Run `fn` over each `items` element with at most `concurrency` in flight at
 * a time.  Preserves input order in the output.  Used for the of1 fan-out
 * so we don't open `limit` (up to 100) sockets simultaneously.
 */
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push((async () => {
      while (true) {
        const idx = next++
        if (idx >= items.length) return
        out[idx] = await fn(items[idx])
      }
    })())
  }
  await Promise.all(workers)
  return out
}
