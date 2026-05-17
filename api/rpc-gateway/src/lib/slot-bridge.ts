// Slot-only Yellowstone-gRPC subscriber, shared across all WebSocket clients.
//
// Opens ONE persistent `Subscribe { slots: { all: {} }, commitment:
// processed }` stream against `endpoint` and fans the resulting
// `SubscribeUpdate.slot` events out to N registered listeners.  One
// subscriber per process keeps the upstream load constant regardless of
// how many web3.js clients call `slotSubscribe`.
//
// Why it exists: routing `slotSubscribe` to the validator-backed pubsub
// (richat WS → validator geyser → block-replay-complete) costs ~5–8 ms
// vs Helius, which fires slot notifications from shred receipt
// (pre-execution).  Pointing this bridge at the yellowstone_shred_bridge
// (1.5.0+ on 198.13.137.159:10005) gives the same first-shred-of-next-slot
// semantic and closes that gap.
//
// `root` field: the shred bridge cannot derive `root` from shreds alone
// (root requires vote/finality info).  For now we emit a deterministic
// approximation (`max(0, slot - 32)`) so web3.js callbacks receive a
// numeric value.  Clients that actually consume `root` need
// `commitmentSubscribe` / `rootSubscribe` instead.

import grpcModule from 'npm:@triton-one/yellowstone-grpc@1.3.0'

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

type SubscribeUpdate = {
  slot?: {
    slot: number | string | bigint
    parent?: number | string | bigint | null
    status?: number
  }
}

export type SlotUpdate = {
  slot: number
  parent: number | null
  root: number
}

type Listener = (u: SlotUpdate) => void

export class SlotBridge {
  private endpoint: string
  private listeners = new Set<Listener>()
  // deno-lint-ignore no-explicit-any
  private stream: any = null
  private starting = false
  private reconnectTimer: number | null = null

  constructor(endpoint: string) {
    if (/^https?:\/\//.test(endpoint)) {
      this.endpoint = endpoint
    } else {
      this.endpoint = `http://${endpoint.replace(/^grpc:\/\//, '')}`
    }
  }

  /** Register a listener; returns a cancel handle. */
  subscribe(listener: Listener): { cancel: () => void } {
    this.listeners.add(listener)
    if (!this.stream && !this.starting) {
      this.start().catch((e) => {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_bridge_start_error',
          error: String(e),
        }))
      })
    }
    return {
      cancel: () => {
        this.listeners.delete(listener)
        // Stream stays open — likely more subscribers coming and the
        // process-wide single stream costs ~one tcp socket.
      },
    }
  }

  private async start() {
    this.starting = true
    try {
      const client = new Client(this.endpoint, undefined, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
      })
      const stream = await client.subscribe()
      this.stream = stream
      const req = {
        slots: { all: {} },
        accounts: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        commitment: CommitmentLevel.PROCESSED,
        accountsDataSlice: [],
      }
      await new Promise<void>((resolve, reject) => {
        stream.write(req, (err: Error | null | undefined) => {
          if (err) reject(err)
          else resolve()
        })
      })
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'slot_bridge_connected',
        endpoint: this.endpoint,
        listeners: this.listeners.size,
      }))
      stream.on('data', (u: SubscribeUpdate) => {
        if (!u.slot) return
        const slot = Number(u.slot.slot)
        if (!Number.isFinite(slot) || slot <= 0) return
        const parent = u.slot.parent != null ? Number(u.slot.parent) : null
        const root = Math.max(0, slot - 32)
        const evt: SlotUpdate = { slot, parent, root }
        for (const l of this.listeners) {
          try {
            l(evt)
          } catch {
            // Swallow per-listener errors to keep the bridge running.
          }
        }
      })
      stream.on('error', (e: unknown) => {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_bridge_stream_error',
          error: String(e),
        }))
        this.stream = null
        this.scheduleReconnect()
      })
    } catch (e) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'slot_bridge_connect_failed',
        error: String(e),
      }))
      this.stream = null
      this.scheduleReconnect()
    } finally {
      this.starting = false
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return
    if (this.listeners.size === 0) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.listeners.size > 0 && !this.stream) {
        this.start().catch((e) =>
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            msg: 'slot_bridge_reconnect_error',
            error: String(e),
          }))
        )
      }
    }, 1000) as unknown as number
  }
}
