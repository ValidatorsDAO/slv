// Yellowstone gRPC ↔ enhanced WebSocket bridge.
//
// Opens a streaming Subscribe call against an upstream Yellowstone-compatible
// gRPC endpoint (e.g. richat daemon on :10000) and translates each
// SubscribeUpdate into the `transactionNotification` JSON shape served on
// the gateway's enhanced WS.

import grpcModule from 'npm:@triton-one/yellowstone-grpc@1.3.0'

// The npm package exports its `Client` class as a CJS default export, which
// Deno's npm interop wraps once more — so the actual constructor lives at
// `grpcModule.default` (see deno eval probing for shape).
// deno-lint-ignore no-explicit-any
const Client = (grpcModule as any).default as new (
  endpoint: string,
  xToken?: string,
  channelOptions?: Record<string, unknown>,
) => {
  subscribe(): Promise<{
    write(req: unknown, cb: (err: Error | null | undefined) => void): void
    on(event: 'data', cb: (u: SubscribeUpdate) => void): void
    on(event: 'error', cb: (e: unknown) => void): void
    cancel(): void
    end(): void
  }>
}

// deno-lint-ignore no-explicit-any
const CommitmentLevel = (grpcModule as any).CommitmentLevel as {
  PROCESSED: number
  CONFIRMED: number
  FINALIZED: number
}

type SubscribeRequest = Record<string, unknown>
type SubscribeUpdate = {
  transaction?: {
    slot: number | string | bigint
    transaction?: {
      signature?: Uint8Array
      transaction?: {
        signatures?: Uint8Array[]
        message?: unknown
      }
      meta?: unknown
    }
  }
}

import { Buffer } from 'node:buffer'
import bs58 from 'npm:bs58@5.0.0'

export type TxSubscribeFilter = {
  vote?: boolean | null
  failed?: boolean | null
  signature?: string | null
  accountInclude?: string[]
  accountExclude?: string[]
  accountRequired?: string[]
}

export type TxSubscribeOpts = {
  commitment?: 'processed' | 'confirmed' | 'finalized'
  encoding?: 'base64' | 'base58' | 'json' | 'jsonParsed'
  transactionDetails?: 'full' | 'signatures' | 'accounts' | 'none'
  showRewards?: boolean
  maxSupportedTransactionVersion?: number
}

export type TxNotification = {
  transaction?: unknown
  meta?: unknown
  signature?: string
  slot: number
  blockTime?: number | null
}

const COMMITMENT_MAP: Record<string, number> = {
  processed: CommitmentLevel.PROCESSED,
  confirmed: CommitmentLevel.CONFIRMED,
  finalized: CommitmentLevel.FINALIZED,
}

export class YellowstoneBridge {
  private endpoint: string

  constructor(endpoint: string) {
    // @triton-one/yellowstone-grpc Client wants a full URL (it parses scheme
    // to choose http/2 vs https/2).  Add http:// when bare host:port is
    // given, leave http:// or https:// intact.
    if (/^https?:\/\//.test(endpoint)) {
      this.endpoint = endpoint
    } else {
      this.endpoint = `http://${endpoint.replace(/^grpc:\/\//, '')}`
    }
  }

  /**
   * Open a Subscribe stream filtered by the enhanced transactionSubscribe
   * filter shape.  Returns an async iterator of notifications and a cancel
   * handle.
   */
  async subscribeTransactions(
    filter: TxSubscribeFilter,
    opts: TxSubscribeOpts,
    onUpdate: (n: TxNotification) => void,
    onError: (e: unknown) => void,
  ): Promise<{ cancel: () => void }> {
    const client = new Client(this.endpoint, undefined, {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
    })

    const stream = await client.subscribe()
    const subId = `txsub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const req: SubscribeRequest = {
      slots: {},
      accounts: {},
      transactions: {
        [subId]: {
          vote: filter.vote ?? false,
          failed: filter.failed ?? false,
          signature: filter.signature ?? undefined,
          accountInclude: filter.accountInclude ?? [],
          accountExclude: filter.accountExclude ?? [],
          accountRequired: filter.accountRequired ?? [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: COMMITMENT_MAP[opts.commitment ?? 'confirmed'] ??
        CommitmentLevel.CONFIRMED,
      accountsDataSlice: [],
    }

    await new Promise<void>((resolve, reject) => {
      stream.write(req, (err: Error | null | undefined) => {
        if (err) reject(err)
        else resolve()
      })
    })

    stream.on('data', (update: SubscribeUpdate) => {
      try {
        if (update.transaction) {
          onUpdate(transformToNotification(update, opts))
        }
      } catch (e) {
        onError(e)
      }
    })
    stream.on('error', onError)

    return {
      cancel: () => {
        try {
          stream.cancel()
        } catch { /* ignore */ }
        try {
          stream.end()
        } catch { /* ignore */ }
      },
    }
  }
}

function transformToNotification(update: SubscribeUpdate, opts: TxSubscribeOpts): TxNotification {
  const txu = update.transaction!
  const slot = Number(txu.slot)
  const tx = txu.transaction

  if (!tx) return { slot }

  const sig = tx.signature ? bs58.encode(Buffer.from(tx.signature)) : undefined
  const detailLevel = opts.transactionDetails ?? 'full'

  if (detailLevel === 'none') {
    return { signature: sig, slot, blockTime: null }
  }

  if (detailLevel === 'signatures') {
    return {
      transaction: {
        signatures: tx.transaction?.signatures?.map((s) => bs58.encode(Buffer.from(s))),
      },
      signature: sig,
      slot,
      blockTime: null,
    }
  }

  return {
    transaction: tx.transaction
      ? {
        signatures: tx.transaction.signatures?.map((s) => bs58.encode(Buffer.from(s))),
        message: tx.transaction.message,
      }
      : undefined,
    meta: tx.meta,
    signature: sig,
    slot,
    blockTime: null,
  }
}
