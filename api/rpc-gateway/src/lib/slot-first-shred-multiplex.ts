// SlotFirstShredMultiplex — N-URL fan-in of `slotsUpdatesSubscribe` →
// `firstShredReceived` events, first-arrival-wins per slot.
//
// Combines the design of `SlotFirstShredBridge` (early signal at
// first-shred receipt) with `SlotMultiplex` (process-wide dedup across
// multiple upstream sources).  One outbound WS per URL, one shared
// listener set per process, first arrival wins per slot.
//
// Why both axes matter:
//
//   - `firstShredReceived` semantics close the bulk of the latency gap
//     versus earlier-firing reference sources by emitting on shred
//     receipt instead of bank-frozen (`SlotFirstShredBridge` brought
//     reference-provider avg lead +5.6 ms → +2.5 ms on FRA-1,
//     2026-05-17).
//
//   - Multiplexing across N upstream pubsub sources catches the slots
//     where any individual source happened to win the jitter race
//     (`SlotMultiplex` measured our win share 6.7 % → 12.8 % with
//     native + richat, 2026-05-17).
//
// Pointing this class at the same N URLs as `SlotMultiplex` but
// filtered through the `firstShredReceived` event type combines both
// improvements in a single subscription stream.  Wire-format on the
// output side is still a regular `slotNotification` so client SDKs
// (web3.js etc.) need no changes.
//
// Trade-off: same as `SlotFirstShredBridge` — clients see the slot
// tick before the bank for that slot is frozen, so a follow-up
// `getAccountInfo` at the new slot can race the validator's replay.

export type SlotUpdate = {
  slot: number
  parent: number | null
  root: number | null
}

type Listener = (u: SlotUpdate) => void

export class SlotFirstShredMultiplex {
  private urls: string[]
  private listeners = new Set<Listener>()
  // Sliding-window dedupe so a reconnect surge doesn't re-deliver
  // old slots and so two simultaneous sources never deliver twice.
  private delivered = new Set<number>()
  private deliveredOrder: number[] = []
  private static MAX_DELIVERED = 1024
  // Tracked so close() can stop them and tests don't trip Deno's
  // op-leak detector on pending reconnects.
  private reconnectTimers = new Set<number>()
  private openSockets = new Set<WebSocket>()
  private shutdownRequested = false

  constructor(urls: string[]) {
    this.urls = urls.filter((u) => u.length > 0)
  }

  /** Lazy: opens upstream connections on the first listener. */
  subscribe(listener: Listener): { cancel: () => void } {
    const firstListener = this.listeners.size === 0
    this.listeners.add(listener)
    if (firstListener) this.start()
    return {
      cancel: () => {
        this.listeners.delete(listener)
        // Upstreams stay open — process-shared singleton pattern.
      },
    }
  }

  /** Stop reconnecting and close every open upstream socket. */
  close() {
    this.shutdownRequested = true
    for (const t of this.reconnectTimers) clearTimeout(t)
    this.reconnectTimers.clear()
    for (const ws of this.openSockets) {
      try {
        ws.close()
      } catch { /* ignore */ }
    }
    this.openSockets.clear()
  }

  private start() {
    if (this.shutdownRequested) return
    for (const url of this.urls) this.connect(url)
  }

  private scheduleReconnect(open: () => void, delay: number) {
    if (this.shutdownRequested) return
    const id = setTimeout(() => {
      this.reconnectTimers.delete(id)
      if (!this.shutdownRequested) open()
    }, delay) as unknown as number
    this.reconnectTimers.add(id)
  }

  private connect(url: string) {
    let reconnectDelay = 1_000
    const open = () => {
      if (this.shutdownRequested) return
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (e) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_first_shred_multiplex_connect_error',
          url,
          error: String(e),
        }))
        this.scheduleReconnect(open, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
        return
      }
      this.openSockets.add(ws)
      ws.onopen = () => {
        if (this.shutdownRequested) {
          try {
            ws.close()
          } catch { /* ignore */ }
          return
        }
        reconnectDelay = 1_000
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'slotsUpdatesSubscribe',
        }))
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_first_shred_multiplex_connected',
          url,
        }))
      }
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === 'string'
          ? ev.data
          : new TextDecoder().decode(ev.data as ArrayBuffer)
        let msg: unknown
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        const m = msg as {
          method?: string
          params?: {
            result?: {
              slot?: number
              parent?: number
              type?: string
            }
          }
        }
        if (m.method !== 'slotsUpdatesNotification') return
        const r = m.params?.result
        if (!r || r.type !== 'firstShredReceived') return
        if (typeof r.slot !== 'number' || r.slot <= 0) return
        if (this.delivered.has(r.slot)) return
        this.delivered.add(r.slot)
        this.deliveredOrder.push(r.slot)
        if (this.deliveredOrder.length > SlotFirstShredMultiplex.MAX_DELIVERED) {
          const evicted = this.deliveredOrder.shift()
          if (evicted !== undefined) this.delivered.delete(evicted)
        }
        const update: SlotUpdate = {
          slot: r.slot,
          parent: typeof r.parent === 'number' ? r.parent : r.slot - 1,
          // `root` is unknown at first-shred-received time — clients
          // that need real root should call `rootSubscribe` instead.
          root: Math.max(0, r.slot - 32),
        }
        for (const l of this.listeners) {
          try {
            l(update)
          } catch {
            // Per-listener errors shouldn't kill the bridge.
          }
        }
      }
      ws.onerror = (e) => {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_first_shred_multiplex_ws_error',
          url,
          error: String((e as ErrorEvent).message ?? e),
        }))
      }
      ws.onclose = () => {
        this.openSockets.delete(ws)
        if (this.shutdownRequested) return
        this.scheduleReconnect(open, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      }
    }
    open()
  }
}
