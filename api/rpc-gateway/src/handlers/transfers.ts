// getTransfersByAddress — Helius-wire-compatible JSON-RPC method backed
// by the `token_transfers` ClickHouse table emitted by slv-transfers-plugin
// (see vs2-app/elsoul-proxy/slv_transfers_plugin — Phase 1 in flight).
//
// Helius spec: https://www.helius.dev/docs/rpc/gettransfersbyaddress
// (verified 2026-05-14 via WebFetch; full per-field details in
// `.claude/design_slv_transfers_plugin.md`)
//
// Request:
//   { jsonrpc: "2.0", id, method: "getTransfersByAddress",
//     params: [ "<base58 address>", {
//       with?:             "<base58 counterparty>",
//       direction?:        "in" | "out" | "any",            // default "any"
//       mint?:             "<base58 mint>",
//       solMode?:          "merged" | "separate",            // default "merged"
//       limit?:            <int 1-100>,                      // default 100
//       paginationToken?:  "<slot>:<txIdx>:<instrIdx>:<innerInstrIdx>:<type>",
//       commitment?:       "finalized" | "confirmed",        // no-op (always finalized)
//       sortOrder?:        "desc" | "asc",                   // default "desc"
//       filters?: {
//         amount?:    { gt?: int, gte?: int, lt?: int, lte?: int },
//         blockTime?: { gt?: int, gte?: int, lt?: int, lte?: int },
//         slot?:      { gt?: int, gte?: int, lt?: int, lte?: int },
//       },
//     } ] }
//
// Response (Helius wire-compat):
//   { result: { data: [{ signature, slot, blockTime, type,
//       fromUserAccount, toUserAccount, fromTokenAccount, toTokenAccount,
//       mint, amount, decimals, uiAmount, feeAmount, feeUiAmount,
//       confirmationStatus, transactionIdx, instructionIdx,
//       innerInstructionIdx }],
//     paginationToken: "<slot>:<txIdx>:<instrIdx>:<innerInstrIdx>:<type>" | null } }
//
// `confirmationStatus` is always "finalized" because jetstreamer only
// ingests Old Faithful (= finalized) blocks.
//
// `solMode=merged` (default): rows whose mint is wSOL are surfaced with
// `mint=null` and `type=transfer` so wSOL UX matches native SOL.  This
// is a pure output-time transformation — the underlying CH row keeps
// the wSOL mint.

import { ClickHouseClient, quoteString } from '../lib/clickhouse.ts'
import { err, ERROR_CODES, type JsonRpcRequest, type JsonRpcResponse, ok } from '../jsonrpc.ts'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100
const WSOL_MINT = 'So11111111111111111111111111111111111111112'

// ClickHouse schema enum: keep in sync with slv-transfers-plugin's
// CREATE TABLE statement (see .claude/design_slv_transfers_plugin.md).
const TRANSFER_TYPE_NAMES = [
  '_unknown', // 0 — unused, kept so 1..7 maps directly
  'transfer',
  'mint',
  'burn',
  'wrap',
  'unwrap',
  'changeOwner',
  'withdrawWithheldFee',
] as const

type TransferType = typeof TRANSFER_TYPE_NAMES[number]

const VALID_TYPE_NAMES: ReadonlySet<string> = new Set(TRANSFER_TYPE_NAMES.slice(1))

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing ${name}`)
  return v
}

function asBase58Pubkey(v: unknown, name: string): string {
  const s = asString(v, name)
  if (!BASE58_RE.test(s)) throw new Error(`invalid ${name}: not a valid base58 pubkey`)
  return s
}

function asInt(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`invalid ${name}: expected non-negative integer`)
  }
  return n
}

type Cmp = { gt?: number; gte?: number; lt?: number; lte?: number }

function parseCmp(raw: unknown, name: string): Cmp {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid ${name}: expected object with gt/gte/lt/lte`)
  }
  const o = raw as Record<string, unknown>
  const out: Cmp = {}
  for (const k of ['gt', 'gte', 'lt', 'lte'] as const) {
    if (o[k] !== undefined) out[k] = asInt(o[k], `${name}.${k}`)
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`invalid ${name}: at least one of gt/gte/lt/lte required`)
  }
  return out
}

function cmpToSql(col: string, cmp: Cmp): string[] {
  const parts: string[] = []
  if (cmp.gt !== undefined) parts.push(`${col} > ${cmp.gt}`)
  if (cmp.gte !== undefined) parts.push(`${col} >= ${cmp.gte}`)
  if (cmp.lt !== undefined) parts.push(`${col} < ${cmp.lt}`)
  if (cmp.lte !== undefined) parts.push(`${col} <= ${cmp.lte}`)
  return parts
}

/** Parse `[address, options?]` positional params. */
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

type Cursor = {
  slot: number
  txIdx: number
  instrIdx: number
  innerInstrIdx: number
  type: TransferType
}

function parsePaginationToken(s: string): Cursor {
  // Format: "<slot>:<txIdx>:<instrIdx>:<innerInstrIdx>:<type>"
  const parts = s.split(':')
  if (parts.length !== 5) {
    throw new Error(
      'invalid paginationToken: expected "<slot>:<txIdx>:<instrIdx>:<innerInstrIdx>:<type>"',
    )
  }
  const [slotStr, txStr, instrStr, innerStr, typeStr] = parts
  const slot = asInt(slotStr, 'paginationToken.slot')
  const txIdx = asInt(txStr, 'paginationToken.txIdx')
  const instrIdx = asInt(instrStr, 'paginationToken.instrIdx')
  // innerInstrIdx may be -1 (top-level) — handle as signed
  const innerInstrIdx = parseInt(innerStr, 10)
  if (!Number.isFinite(innerInstrIdx) || !Number.isInteger(innerInstrIdx)) {
    throw new Error('invalid paginationToken.innerInstrIdx')
  }
  if (!VALID_TYPE_NAMES.has(typeStr)) {
    throw new Error(`invalid paginationToken.type: ${typeStr}`)
  }
  return { slot, txIdx, instrIdx, innerInstrIdx, type: typeStr as TransferType }
}

function encodePaginationToken(c: {
  slot: number
  tx_index: number
  instr_index: number
  inner_index: number
  transfer_type: string
}): string {
  return `${c.slot}:${c.tx_index}:${c.instr_index}:${c.inner_index}:${c.transfer_type}`
}

/** Raw u64 → ui-formatted string with `decimals` digit shift. */
function formatUiAmount(amount: string, decimals: number): string {
  if (decimals <= 0) return amount
  // Pad with zeros, insert decimal point.  amount is a numeric string
  // (we keep u64 as string to avoid JS Number precision loss).
  const padded = amount.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, padded.length - decimals)
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
}

/**
 * Row shape ClickHouse returns from the SELECT.  Note `signature` and
 * pubkey columns come back as base58 thanks to `base58Encode(...)` in
 * the SELECT projection — ClickHouse handles the FixedString encoding.
 */
type RawRow = {
  signature: string
  slot: number
  block_time: number
  transfer_type: string
  from_owner: string
  to_owner: string
  from_token_account: string | null
  to_token_account: string | null
  mint: string
  amount: string // u64 as string
  fee_amount: string
  decimals: number
  tx_index: number
  instr_index: number
  inner_index: number
}

const ZERO_PUBKEY_B58 = '11111111111111111111111111111111' // 32-zero-bytes base58 encoding

export class TransfersHandlers {
  constructor(private ch: ClickHouseClient) {}

  /**
   * Helius-wire-compatible.  Phase 2 of the slv-transfers-plugin work.
   * Schema: see `slv:.claude/design_slv_transfers_plugin.md`.
   */
  async getTransfersByAddress(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const { address, options } = parseParams(req.params)

      // Direction routing — picks the table.  `out` queries the primary
      // table sorted by from_owner; `in` queries the materialised view
      // sorted by to_owner; `any` UNIONs both.
      const direction = options.direction === undefined
        ? 'any'
        : asString(options.direction, 'direction')
      if (direction !== 'in' && direction !== 'out' && direction !== 'any') {
        throw new Error(`invalid direction: expected "in" | "out" | "any"`)
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
        : Math.min(asInt(options.limit, 'limit'), MAX_LIMIT)
      if (limit === 0) {
        return ok(req.id ?? null, { data: [], paginationToken: null })
      }

      const solMode = options.solMode === undefined
        ? 'merged'
        : asString(options.solMode, 'solMode')
      if (solMode !== 'merged' && solMode !== 'separate') {
        throw new Error(`invalid solMode: expected "merged" or "separate"`)
      }

      // Commitment — accepted but no-op (jetstreamer is finalized only).
      if (options.commitment !== undefined) {
        const c = asString(options.commitment, 'commitment')
        if (c !== 'finalized' && c !== 'confirmed') {
          throw new Error(`invalid commitment: expected "finalized" or "confirmed"`)
        }
      }

      // Build per-direction predicates.  These select the address column
      // and (optionally) the counterparty column for `with`.
      const wherePredicates: string[] = []

      // `with` filter — opposite-side counterparty constraint.
      let withCounterparty: string | null = null
      if (options.with !== undefined) {
        withCounterparty = asBase58Pubkey(options.with, 'with')
      }

      // mint filter
      if (options.mint !== undefined) {
        const mint = asBase58Pubkey(options.mint, 'mint')
        wherePredicates.push(`mint = base58Decode(${quoteString(mint)})`)
      }

      // numeric filters
      const filters = options.filters
      if (filters !== undefined) {
        if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
          throw new Error('invalid filters: expected object')
        }
        const f = filters as Record<string, unknown>
        if (f.amount !== undefined) {
          wherePredicates.push(...cmpToSql('amount', parseCmp(f.amount, 'filters.amount')))
        }
        if (f.blockTime !== undefined) {
          wherePredicates.push(
            ...cmpToSql('block_time', parseCmp(f.blockTime, 'filters.blockTime')),
          )
        }
        if (f.slot !== undefined) {
          wherePredicates.push(...cmpToSql('slot', parseCmp(f.slot, 'filters.slot')))
        }
      }

      // Pagination cursor — strict tuple comparison on (slot, tx, instr, inner).
      let cursorPredicate = ''
      if (options.paginationToken !== undefined) {
        const tok = parsePaginationToken(asString(options.paginationToken, 'paginationToken'))
        const op = desc ? '<' : '>'
        // ClickHouse supports tuple comparison natively.
        cursorPredicate = `(slot, tx_index, instr_index, inner_index) ${op} ` +
          `(${tok.slot}, ${tok.txIdx}, ${tok.instrIdx}, ${tok.innerInstrIdx})`
      }

      // SQL fragment per direction.  The address filter changes column
      // (from_owner vs to_owner) and the counterparty filter selects the
      // other side.
      const buildSelect = (dir: 'out' | 'in'): string => {
        const tableAndAddr = dir === 'out'
          ? `FROM token_transfers WHERE from_owner = base58Decode(${quoteString(address)})`
          : `FROM token_transfers_by_to WHERE to_owner = base58Decode(${quoteString(address)})`
        const counterpartyPredicate = withCounterparty !== null
          ? (dir === 'out'
            ? `AND to_owner = base58Decode(${quoteString(withCounterparty)})`
            : `AND from_owner = base58Decode(${quoteString(withCounterparty)})`)
          : ''
        const wherePart = wherePredicates.length > 0 ? `AND ${wherePredicates.join(' AND ')}` : ''
        const cursorPart = cursorPredicate.length > 0 ? `AND ${cursorPredicate}` : ''
        return `${tableAndAddr} ${counterpartyPredicate} ${wherePart} ${cursorPart}`
      }

      const orderDir = desc ? 'DESC' : 'ASC'
      // Project columns out of the FixedString format the schema uses.
      const projection = `
        base58Encode(signature) AS signature,
        slot,
        block_time,
        transfer_type,
        base58Encode(from_owner) AS from_owner,
        base58Encode(to_owner) AS to_owner,
        if(isNotNull(from_token_account), base58Encode(from_token_account), NULL) AS from_token_account,
        if(isNotNull(to_token_account), base58Encode(to_token_account), NULL) AS to_token_account,
        base58Encode(mint) AS mint,
        toString(amount) AS amount,
        toString(fee_amount) AS fee_amount,
        decimals,
        tx_index,
        instr_index,
        inner_index
      `

      let sql: string
      if (direction === 'out') {
        sql = `
          SELECT ${projection}
          ${buildSelect('out')}
          ORDER BY slot ${orderDir}, tx_index ${orderDir}, instr_index ${orderDir}, inner_index ${orderDir}
          LIMIT ${limit + 1}
        `
      } else if (direction === 'in') {
        sql = `
          SELECT ${projection}
          ${buildSelect('in')}
          ORDER BY slot ${orderDir}, tx_index ${orderDir}, instr_index ${orderDir}, inner_index ${orderDir}
          LIMIT ${limit + 1}
        `
      } else {
        // any: UNION ALL the two halves, then sort + limit at the outer.
        // DISTINCT to dedupe the rare self-transfer (from == to) case
        // where both tables emit the same row.
        sql = `
          SELECT ${projection} FROM (
            SELECT * ${buildSelect('out')}
            UNION DISTINCT
            SELECT * ${buildSelect('in')}
          )
          ORDER BY slot ${orderDir}, tx_index ${orderDir}, instr_index ${orderDir}, inner_index ${orderDir}
          LIMIT ${limit + 1}
        `
      }

      const rows = await this.ch.query<RawRow>(sql)

      let paginationToken: string | null = null
      if (rows.length > limit) {
        const sentinel = rows[limit]
        paginationToken = encodePaginationToken(sentinel)
        rows.length = limit
      }

      const data = rows.map((r) => rawRowToHeliusEntry(r, solMode))

      return ok(req.id ?? null, { data, paginationToken })
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }
}

/** ClickHouse row → Helius entry. */
function rawRowToHeliusEntry(r: RawRow, solMode: 'merged' | 'separate') {
  const transferType = TRANSFER_TYPE_NAMES[parseInt(r.transfer_type, 10)] ?? 'transfer'

  // Sentinel-zero from_owner/to_owner means "no counterparty" (mint/burn etc.)
  const fromUserAccount = r.from_owner === ZERO_PUBKEY_B58 ? null : r.from_owner
  const toUserAccount = r.to_owner === ZERO_PUBKEY_B58 ? null : r.to_owner

  // solMode=merged: surface wSOL transfers as native SOL (mint=null) so
  // wallet UIs treat them like SOL.  Underlying type stays "transfer";
  // wrap/unwrap stays as-is because the merged view is supposed to hide
  // the wrapping.
  let mint: string | null = r.mint
  let displayType: string = transferType
  if (solMode === 'merged' && r.mint === WSOL_MINT) {
    mint = null
    if (transferType === 'wrap' || transferType === 'unwrap') {
      displayType = 'transfer'
    }
  }

  return {
    signature: r.signature,
    slot: r.slot,
    blockTime: r.block_time,
    type: displayType,
    fromUserAccount,
    toUserAccount,
    fromTokenAccount: r.from_token_account,
    toTokenAccount: r.to_token_account,
    mint,
    amount: r.amount,
    decimals: r.decimals,
    uiAmount: formatUiAmount(r.amount, r.decimals),
    feeAmount: r.fee_amount !== '0' ? r.fee_amount : null,
    feeUiAmount: r.fee_amount !== '0' ? formatUiAmount(r.fee_amount, r.decimals) : null,
    confirmationStatus: 'finalized' as const,
    transactionIdx: r.tx_index,
    instructionIdx: r.instr_index,
    innerInstructionIdx: r.inner_index,
  }
}
