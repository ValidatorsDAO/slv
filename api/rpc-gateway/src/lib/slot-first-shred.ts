// SlotFirstShredBridge — emit slotNotification at `firstShredReceived`
// instead of the standard `processed` (= bank-frozen) semantic.
//
// Why: a standard `slotSubscribe` fires when the validator finishes
// replaying a slot's last shred and freezes the bank.  Some providers
// fire noticeably earlier — measurement on FRA-1 (2026-05-17) showed
// the reference provider beat us by avg +5.6 ms on `slotSubscribe`,
// but only +2.5 ms when we subscribed to `slotsUpdatesSubscribe` and
// re-emitted the `firstShredReceived` events as `slotNotification`.
// The gap closed because `firstShredReceived` fires the instant the
// validator sees the first shred for a slot — same physics as the
// earlier-firing source.
//
// Trade-off: clients still see `slotNotification` with `{slot, parent,
// root}`, but the slot has only just *started* — the bank for that
// slot does not yet exist, so a follow-up `getAccountInfo` /
// `getBalance` at that slot may race the validator's own replay.
// Use this when the customer wants early slot ticks (e.g. for trading
// loops or progress UIs), NOT when they want guaranteed bank state.
//
// Implementation: opens ONE upstream WebSocket to a Solana-pubsub-compat
// endpoint, sends `slotsUpdatesSubscribe`, and fans the filtered events
// out to N registered listeners.  Cost: one upstream subscription per
// process regardless of client count.

export type SlotUpdate = {
  slot: number
  parent: number | null
  root: number | null
}

type Listener = (u: SlotUpdate) => void

export class SlotFirstShredBridge {
  private url: string
  private listeners = new Set<Listener>()
  private ws: WebSocket | null = null
  private reconnectDelay = 1_000
  private starting = false
  // Sliding-window dedupe so a reconnect surge doesn't re-deliver old slots.
  private delivered = new Set<number>()
  private deliveredOrder: number[] = []
  private static MAX_DELIVERED = 1024

  constructor(url: string) {
    this.url = url
  }

  subscribe(listener: Listener): { cancel: () => void } {
    const firstListener = this.listeners.size === 0
    this.listeners.add(listener)
    if (firstListener) this.connect()
    return {
      cancel: () => {
        this.listeners.delete(listener)
      },
    }
  }

  private connect() {
    if (this.starting || this.ws) return
    this.starting = true
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.starting = false
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'slot_first_shred_connect_error',
        url: this.url,
        error: String(e),
      }))
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.starting = false
      this.reconnectDelay = 1_000
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'slotsUpdatesSubscribe',
      }))
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'slot_first_shred_connected',
        url: this.url,
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
      if (!r || r.type !== 'firstShredReceived' || typeof r.slot !== 'number') return
      if (r.slot <= 0 || this.delivered.has(r.slot)) return
      this.delivered.add(r.slot)
      this.deliveredOrder.push(r.slot)
      if (this.deliveredOrder.length > SlotFirstShredBridge.MAX_DELIVERED) {
        const evicted = this.deliveredOrder.shift()
        if (evicted !== undefined) this.delivered.delete(evicted)
      }
      const update: SlotUpdate = {
        slot: r.slot,
        parent: typeof r.parent === 'number' ? r.parent : r.slot - 1,
        // `root` is unknown at first-shred-received time — slotsUpdates
        // doesn't carry it.  Approximate with `slot - 32`; clients that
        // need real root should call `rootSubscribe` separately.
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
        msg: 'slot_first_shred_ws_error',
        url: this.url,
        error: String((e as ErrorEvent).message ?? e),
      }))
    }
    ws.onclose = () => {
      this.ws = null
      this.starting = false
      if (this.listeners.size > 0) this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    setTimeout(() => this.connect(), delay)
  }
}
