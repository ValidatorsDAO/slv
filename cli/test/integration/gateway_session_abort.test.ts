import { assert, assertEquals } from '@std/assert'
import {
  startGateway,
  stopGateway,
  sub,
} from '/test/integration/_gateway_helpers.ts'

// End-to-end tests for Phase 2D-v3: one persistent WS that carries
// both the chat and the mid-stream `session.abort`. Verifies the
// abort sequence fires a single `aborted` terminal with NO trailing
// `complete`, and that the same connection can be reused for a
// follow-up `session.echo` without re-authenticating. Shared
// spawn/health/cleanup lives in _gateway_helpers.ts.

type EventFrame = {
  kind: 'event'
  event: string
  payload?: { type?: string; [k: string]: unknown }
  seq: number
}

type ResFrame = {
  kind: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: string
}

const openWs = (port: number): Promise<{
  socket: WebSocket
  call: (method: string, params?: unknown) => Promise<ResFrame>
  events: EventFrame[]
  waitForEvent: (
    predicate: (e: EventFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<EventFrame>
}> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session/ws`)
    const pending = new Map<string, (r: ResFrame) => void>()
    const events: EventFrame[] = []
    const waiters: {
      check: (e: EventFrame) => boolean
      resolve: (e: EventFrame) => void
    }[] = []
    let n = 0
    ws.onopen = () => {
      resolve({
        socket: ws,
        call: (method, params) =>
          new Promise((res) => {
            const id = `c${++n}`
            pending.set(id, res)
            ws.send(JSON.stringify({ kind: 'req', id, method, params }))
          }),
        events,
        waitForEvent: (pred, timeoutMs = 5000) =>
          new Promise((resW, rejW) => {
            const found = events.find(pred)
            if (found) {
              resW(found)
              return
            }
            const timer = setTimeout(
              () => rejW(new Error('timeout')),
              timeoutMs,
            )
            waiters.push({
              check: pred,
              resolve: (e) => {
                clearTimeout(timer)
                resW(e)
              },
            })
          }),
      })
    }
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data))
      if (f.kind === 'res') {
        const fn = pending.get(f.id)
        if (fn) {
          pending.delete(f.id)
          fn(f)
        }
      } else if (f.kind === 'event') {
        events.push(f as EventFrame)
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].check(f as EventFrame)) {
            waiters[i].resolve(f as EventFrame)
            waiters.splice(i, 1)
          }
        }
      }
    }
    ws.onerror = (e) => reject(e)
  })

Deno.test(
  'ws: session.abort mid-stream cancels echo with `aborted`, no `complete`',
  sub,
  async () => {
    const gw = await startGateway()
    try {
      const c = await openWs(gw.port)
      try {
        await c.call('gateway.auth', { token: gw.token })

        const sent = await c.call('session.echo', {
          text: 'one two three four five six seven eight nine ten',
        })
        assertEquals(sent.ok, true)

        // Let the echo driver emit a few deltas, then abort on the
        // SAME socket.
        await new Promise((r) => setTimeout(r, 80))
        const ab = await c.call('session.abort')
        assertEquals(ab.ok, true)
        assertEquals((ab.payload as { wasRunning: boolean }).wasRunning, true)

        await c.waitForEvent((e) => e.payload?.type === 'aborted')

        const completes = c.events.filter((e) => e.payload?.type === 'complete')
        assertEquals(
          completes.length,
          0,
          'complete must not fire when aborted',
        )
      } finally {
        c.socket.close()
      }
    } finally {
      await stopGateway(gw)
    }
  },
)

Deno.test(
  'ws: persistent connection reuses auth across multiple session.echo calls',
  sub,
  async () => {
    const gw = await startGateway()
    try {
      const c = await openWs(gw.port)
      try {
        await c.call('gateway.auth', { token: gw.token })

        // Turn 1
        await c.call('session.echo', { text: 'first' })
        await c.waitForEvent((e) => e.payload?.type === 'complete')
        const firstCompletes = c.events.filter((e) =>
          e.payload?.type === 'complete'
        ).length

        // Turn 2 — no re-auth, just another session.echo on the
        // same socket.
        const sent2 = await c.call('session.echo', { text: 'second' })
        assertEquals(sent2.ok, true)
        await c.waitForEvent((e) => {
          // Second `complete` event
          const completes = c.events.filter((e2) =>
            e2.payload?.type === 'complete'
          )
          return completes.length > firstCompletes
        })
        const secondCompletes = c.events.filter((e) =>
          e.payload?.type === 'complete'
        ).length
        assert(
          secondCompletes > firstCompletes,
          'second turn did not produce a fresh complete event',
        )
      } finally {
        c.socket.close()
      }
    } finally {
      await stopGateway(gw)
    }
  },
)

Deno.test(
  'ws: session.abort when nothing is running reports wasRunning:false',
  sub,
  async () => {
    const gw = await startGateway()
    try {
      const c = await openWs(gw.port)
      try {
        await c.call('gateway.auth', { token: gw.token })
        const ab = await c.call('session.abort')
        assertEquals(ab.ok, true)
        assertEquals((ab.payload as { wasRunning: boolean }).wasRunning, false)
      } finally {
        c.socket.close()
      }
    } finally {
      await stopGateway(gw)
    }
  },
)
