// SlotMultiplex — N-source slotSubscribe with first-arrival-wins per slot.
//
// Subscribes once per upstream URL to `slotSubscribe`, parses incoming
// `slotNotification` payloads, dedupes by slot number, and fans the
// FIRST notification per slot out to N registered listeners.  Late
// duplicates from slower upstreams are dropped.
//
// Why: a 60-second slot race on FRA-1 showed that richat (:7111) and
// native validator pubsub (:7212) each occasionally beat the other —
// the two pipelines have different jitter profiles even though native
// is faster on average.  Multiplexing across both raised the share of
// slots where we beat the reference provider from 6.7 % (native only)
// to 12.8 % (native + richat first-wins) while also shaving the average
// reference-provider lead by ~0.2 ms.
//
// Compared to the earlier per-client `PubsubForward` approach, this
// shares ONE upstream subscription per URL across the whole process,
// so cost scales with `URLS × 1` instead of `URLS × clients`.

export type SlotUpdate = {
  slot: number
  parent: number | null
  root: number | null
}

type Listener = (u: SlotUpdate) => void

export class SlotMultiplex {
  private urls: string[]
  private listeners = new Set<Listener>()
  // Sliding window of slots we've already delivered.  Keeps the last
  // ~1024 slots so reconnect floods don't re-deliver old slots.
  private delivered: Set<number> = new Set()
  private deliveredOrder: number[] = []
  private static MAX_DELIVERED = 1024

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
        // Keep upstreams open — process-shared singleton.
      },
    }
  }

  private start() {
    for (const url of this.urls) this.connect(url)
  }

  private connect(url: string) {
    let reconnectDelay = 1_000
    const open = () => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (e) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_multiplex_connect_error',
          url,
          error: String(e),
        }))
        setTimeout(open, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
        return
      }
      ws.onopen = () => {
        reconnectDelay = 1_000
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'slotSubscribe',
        }))
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_multiplex_connected',
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
          params?: { result?: { slot?: number; parent?: number; root?: number } }
        }
        if (m.method !== 'slotNotification') return
        const r = m.params?.result
        if (!r || typeof r.slot !== 'number' || r.slot <= 0) return
        if (this.delivered.has(r.slot)) return
        this.delivered.add(r.slot)
        this.deliveredOrder.push(r.slot)
        if (this.deliveredOrder.length > SlotMultiplex.MAX_DELIVERED) {
          const evicted = this.deliveredOrder.shift()
          if (evicted !== undefined) this.delivered.delete(evicted)
        }
        const u: SlotUpdate = {
          slot: r.slot,
          parent: typeof r.parent === 'number' ? r.parent : null,
          root: typeof r.root === 'number' ? r.root : null,
        }
        for (const l of this.listeners) {
          try {
            l(u)
          } catch {
            // Per-listener errors shouldn't kill the bridge.
          }
        }
      }
      ws.onerror = (e) => {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          msg: 'slot_multiplex_ws_error',
          url,
          error: String((e as ErrorEvent).message ?? e),
        }))
      }
      ws.onclose = () => {
        setTimeout(open, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      }
    }
    open()
  }
}
