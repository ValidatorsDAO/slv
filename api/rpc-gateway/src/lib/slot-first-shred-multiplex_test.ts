// Unit test for SlotFirstShredMultiplex: two upstream WS sources,
// overlapping `firstShredReceived` events, verify first-arrival
// dedup so each slot is delivered to the listener exactly once.

import { assertEquals } from '@std/assert'
import { SlotFirstShredMultiplex, type SlotUpdate } from './slot-first-shred-multiplex.ts'

type Mock = {
  port: number
  url: string
  shutdown: () => Promise<void>
  send: (slot: number, type?: string) => void
}

function spawnMockPubsub(label: string): Promise<Mock> {
  return new Promise((resolve) => {
    const sockets = new Set<WebSocket>()
    const ac = new AbortController()
    const server = Deno.serve({
      port: 0,
      signal: ac.signal,
      onListen: ({ port }) => {
        resolve({
          port,
          url: `ws://127.0.0.1:${port}/`,
          async shutdown() {
            for (const s of sockets) {
              try {
                s.close()
              } catch { /* ignore */ }
            }
            ac.abort()
            await server.finished
          },
          send(slot, type = 'firstShredReceived') {
            const payload = JSON.stringify({
              jsonrpc: '2.0',
              method: 'slotsUpdatesNotification',
              params: {
                result: { slot, parent: slot - 1, type },
                subscription: 1,
              },
            })
            for (const s of sockets) {
              try {
                s.send(payload)
              } catch { /* ignore closed */ }
            }
          },
        })
      },
    }, (req) => {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response(`mock ${label}`, { status: 426 })
      }
      const { socket, response } = Deno.upgradeWebSocket(req)
      socket.onopen = () => {
        sockets.add(socket)
      }
      socket.onclose = () => {
        sockets.delete(socket)
      }
      socket.onmessage = () => {/* swallow client subscribe; we drive sends manually */}
      return response
    })
  })
}

function waitUntil(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

Deno.test('SlotFirstShredMultiplex: first-arrival dedup across two sources', async () => {
  const a = await spawnMockPubsub('a')
  const b = await spawnMockPubsub('b')
  try {
    const mux = new SlotFirstShredMultiplex([a.url, b.url])
    const received: SlotUpdate[] = []
    const handle = mux.subscribe((u) => {
      received.push(u)
    })

    // Give the multiplex a tick to connect to both upstreams.
    await waitUntil(() => true, 200) // unconditional small wait
    await new Promise((r) => setTimeout(r, 250))

    // slot 100: a first, then b (= dup, should be dropped)
    a.send(100)
    await new Promise((r) => setTimeout(r, 30))
    b.send(100)

    // slot 101: only b (= unique)
    await new Promise((r) => setTimeout(r, 30))
    b.send(101)

    // slot 102: only a (= unique)
    await new Promise((r) => setTimeout(r, 30))
    a.send(102)

    // slot 103: both send roughly simultaneously (= one wins)
    await new Promise((r) => setTimeout(r, 30))
    a.send(103)
    b.send(103)

    await waitUntil(() => received.length >= 4, 1_000)
    handle.cancel()
    mux.close()

    const slots = received.map((u) => u.slot).sort((x, y) => x - y)
    assertEquals(slots, [100, 101, 102, 103], 'each slot delivered exactly once across sources')

    // parent / root sanity (root is approximated as slot-32, parent given by upstream).
    for (const u of received) {
      assertEquals(u.parent, u.slot - 1, `parent for slot ${u.slot}`)
      assertEquals(u.root, Math.max(0, u.slot - 32), `root for slot ${u.slot}`)
    }
  } finally {
    await a.shutdown()
    await b.shutdown()
  }
})

Deno.test('SlotFirstShredMultiplex: ignores non-firstShredReceived event types', async () => {
  const a = await spawnMockPubsub('a')
  try {
    const mux = new SlotFirstShredMultiplex([a.url])
    const received: SlotUpdate[] = []
    const handle = mux.subscribe((u) => {
      received.push(u)
    })

    await new Promise((r) => setTimeout(r, 250))

    a.send(200, 'completed')
    a.send(201, 'frozen')
    a.send(202, 'optimisticConfirmation')
    a.send(203, 'firstShredReceived') // only this should reach the listener

    await waitUntil(() => received.length >= 1, 1_000)
    // Give a small buffer to ensure no late deliveries.
    await new Promise((r) => setTimeout(r, 100))
    handle.cancel()
    mux.close()

    assertEquals(received.length, 1, 'only firstShredReceived events are forwarded')
    assertEquals(received[0].slot, 203)
  } finally {
    await a.shutdown()
  }
})
