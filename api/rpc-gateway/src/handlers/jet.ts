// jet_* JSON-RPC methods backed by ClickHouse (jetstreamer data).
//
// Method naming convention: `jet_<camelCase>`, never colliding with standard
// Solana RPC.  Each handler validates params, builds a parametrized SQL query
// (no raw user-string interpolation into expressions), and returns the rows
// as the JSON-RPC `result`.

import { ClickHouseClient, quoteString } from '../lib/clickhouse.ts'
import { err, ERROR_CODES, ok, type JsonRpcRequest, type JsonRpcResponse } from '../jsonrpc.ts'

const SLOTS_PER_EPOCH = 432_000

function asInt(v: unknown, name: string, fallback?: number): number {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback
    throw new Error(`missing ${name}`)
  }
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${name}`)
  return n
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true' || v === '1'
  if (typeof v === 'number') return v !== 0
  return fallback
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing ${name}`)
  return v
}

function paramObj(params: unknown): Record<string, unknown> {
  if (Array.isArray(params)) return (params[0] as Record<string, unknown>) ?? {}
  if (typeof params === 'object' && params !== null) return params as Record<string, unknown>
  return {}
}

export class JetHandlers {
  constructor(private ch: ClickHouseClient) {}

  /**
   * jet_topPrograms({ since?, until?, includeVotes?, limit? })
   * Top-N programs by invocation count over a time window.
   */
  async topPrograms(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const p = paramObj(req.params)
      const since = p.since ? quoteString(asString(p.since, 'since')) : null
      const until = p.until ? quoteString(asString(p.until, 'until')) : null
      const includeVotes = asBool(p.includeVotes, false)
      const limit = Math.min(asInt(p.limit, 'limit', 20), 1000)

      const where: string[] = []
      if (since) where.push(`timestamp >= toDateTime(${since})`)
      if (until) where.push(`timestamp <  toDateTime(${until})`)
      if (!includeVotes) where.push('is_vote = 0')
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

      const rows = await this.ch.query<{
        program: string
        invocations: string
        errors: string
        total_cus: string
      }>(`
        SELECT
          base58Encode(toString(program_id)) AS program,
          sum(count)        AS invocations,
          sum(error_count)  AS errors,
          sum(total_cus)    AS total_cus
        FROM program_invocations
        ${whereSql}
        GROUP BY program_id
        ORDER BY invocations DESC
        LIMIT ${limit}
      `)
      return ok(req.id ?? null, rows)
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }

  /**
   * jet_slotStats({ slot } | { fromSlot, toSlot })
   * Per-slot transaction counts, vote/non-vote split, blocktime.
   */
  async slotStats(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const p = paramObj(req.params)
      let where = ''
      if (p.slot !== undefined) {
        where = `WHERE slot = ${asInt(p.slot, 'slot')}`
      } else {
        const from = asInt(p.fromSlot, 'fromSlot')
        const to = asInt(p.toSlot, 'toSlot')
        if (to < from) throw new Error('toSlot must be >= fromSlot')
        if (to - from > 100_000) throw new Error('range too large (max 100k slots)')
        where = `WHERE slot BETWEEN ${from} AND ${to}`
      }
      const rows = await this.ch.query(`
        SELECT
          slot,
          transaction_count,
          vote_transaction_count,
          non_vote_transaction_count,
          toUnixTimestamp(block_time) AS block_time
        FROM jetstreamer_slot_status
        ${where}
        ORDER BY slot
      `)
      return ok(req.id ?? null, rows)
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }

  /**
   * jet_tpsTimeseries({ from, to, bucketSec? })
   * TPS time series (non-vote and total) over a time window.
   */
  async tpsTimeseries(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const p = paramObj(req.params)
      const from = quoteString(asString(p.from, 'from'))
      const to = quoteString(asString(p.to, 'to'))
      const bucketSec = Math.min(Math.max(asInt(p.bucketSec, 'bucketSec', 300), 1), 86_400)
      const rows = await this.ch.query(`
        SELECT
          toUnixTimestamp(toStartOfInterval(block_time, INTERVAL ${bucketSec} SECOND)) AS bucket,
          sum(non_vote_transaction_count) / ${bucketSec} AS non_vote_tps,
          sum(transaction_count)          / ${bucketSec} AS total_tps
        FROM jetstreamer_slot_status
        WHERE block_time >= toDateTime(${from})
          AND block_time <  toDateTime(${to})
        GROUP BY bucket
        ORDER BY bucket
      `)
      return ok(req.id ?? null, rows)
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }

  /**
   * jet_epochSummary({ epoch })
   * Aggregate stats for a single epoch.
   */
  async epochSummary(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const p = paramObj(req.params)
      const epoch = asInt(p.epoch, 'epoch')
      const fromSlot = epoch * SLOTS_PER_EPOCH
      const toSlot = fromSlot + SLOTS_PER_EPOCH - 1
      const row = await this.ch.queryOne<{
        slots: string
        non_vote_txs: string
        vote_txs: string
        total_txs: string
        first_block_time: number
        last_block_time: number
      }>(`
        SELECT
          count() AS slots,
          sum(non_vote_transaction_count) AS non_vote_txs,
          sum(vote_transaction_count)     AS vote_txs,
          sum(transaction_count)          AS total_txs,
          toUnixTimestamp(min(block_time)) AS first_block_time,
          toUnixTimestamp(max(block_time)) AS last_block_time
        FROM jetstreamer_slot_status
        WHERE slot BETWEEN ${fromSlot} AND ${toSlot}
      `)
      if (!row || asInt(row.slots, 'slots', 0) === 0) {
        return ok(req.id ?? null, null)
      }
      const programInvocations = await this.ch.queryOne<{ programs: string; invocations: string }>(`
        SELECT
          uniqExact(program_id) AS programs,
          sum(count)            AS invocations
        FROM program_invocations
        WHERE slot BETWEEN ${fromSlot} AND ${toSlot}
      `)
      return ok(req.id ?? null, {
        epoch,
        ...row,
        distinct_programs: programInvocations?.programs ?? '0',
        program_invocations: programInvocations?.invocations ?? '0',
      })
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }

  /**
   * jet_programStats({ programIdBase58, since?, until?, bucketSec? })
   * Time series for a single program.
   */
  async programStats(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const p = paramObj(req.params)
      const programB58 = asString(p.programIdBase58, 'programIdBase58')
      const since = p.since ? quoteString(asString(p.since, 'since')) : null
      const until = p.until ? quoteString(asString(p.until, 'until')) : null
      const bucketSec = Math.min(Math.max(asInt(p.bucketSec, 'bucketSec', 3600), 60), 86_400)

      const where: string[] = [
        `program_id = base58Decode(${quoteString(programB58)})`,
      ]
      if (since) where.push(`timestamp >= toDateTime(${since})`)
      if (until) where.push(`timestamp <  toDateTime(${until})`)

      const rows = await this.ch.query(`
        SELECT
          toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL ${bucketSec} SECOND)) AS bucket,
          sum(count)        AS invocations,
          sum(error_count)  AS errors,
          sum(total_cus)    AS total_cus
        FROM program_invocations
        WHERE ${where.join(' AND ')}
        GROUP BY bucket
        ORDER BY bucket
      `)
      return ok(req.id ?? null, rows)
    } catch (e) {
      return err(req.id ?? null, ERROR_CODES.INVALID_PARAMS, (e as Error).message)
    }
  }
}
