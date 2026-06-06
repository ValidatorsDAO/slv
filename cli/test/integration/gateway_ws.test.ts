import { assert, assertEquals } from '@std/assert'
import {
  startGateway,
  stopGateway,
  sub,
} from '/test/integration/_gateway_helpers.ts'

// End-to-end WS protocol tests against a real gateway subprocess.
// Boots `slv gateway run` with an isolated HOME + free port, opens a
// browser WebSocket to /v1/session/ws, walks the hello → auth → ping
// handshake, and verifies invalid frames + unknown methods are
// rejected cleanly. Shared spawn/health/cleanup lives in
// _gateway_helpers.ts.

/** Thin RPC helper over a WS: send a req, await the matching res. */
type WsClient = {
  socket: WebSocket
  call: (
    method: string,
    params?: unknown,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: string }>
  close: () => void
}

const openWs = (port: number): Promise<WsClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session/ws`)
    const pending = new Map<
      string,
      (r: { ok: boolean; payload?: unknown; error?: string }) => void
    >()
    let counter = 0
    ws.onopen = () => {
      resolve({
        socket: ws,
        call: (method, params) =>
          new Promise((res) => {
            const id = `t${++counter}`
            pending.set(id, res)
            ws.send(JSON.stringify({ kind: 'req', id, method, params }))
          }),
        close: () => ws.close(),
      })
    }
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as {
        kind: string
        id?: string
        ok?: boolean
        payload?: unknown
        error?: string
      }
      if (f.kind === 'res' && typeof f.id === 'string') {
        const r = pending.get(f.id)
        if (r) {
          pending.delete(f.id)
          r({ ok: !!f.ok, payload: f.payload, error: f.error })
        }
      }
    }
    ws.onerror = (e) => reject(e)
  })

Deno.test('ws: hello → auth → ping handshake happy path', sub, async () => {
  const gw = await startGateway()
  try {
    const c = await openWs(gw.port)
    try {
      const hello = await c.call('gateway.hello')
      assertEquals(hello.ok, true)
      assertEquals(
        (hello.payload as { service: string }).service,
        'slv-gateway',
      )

      const authWrong = await c.call('gateway.auth', { token: 'nope' })
      assertEquals(authWrong.ok, false)

      // ping before auth must still be rejected
      const pingNoAuth = await c.call('gateway.ping')
      assertEquals(pingNoAuth.ok, false)

      const auth = await c.call('gateway.auth', { token: gw.token })
      assertEquals(auth.ok, true)

      const ping = await c.call('gateway.ping')
      assertEquals(ping.ok, true)
      assertEquals((ping.payload as { pong: boolean }).pong, true)
    } finally {
      c.close()
    }
  } finally {
    await stopGateway(gw)
  }
})

Deno.test('ws: unknown method returns structured error', sub, async () => {
  const gw = await startGateway()
  try {
    const c = await openWs(gw.port)
    try {
      const res = await c.call('gateway.nonexistent')
      assertEquals(res.ok, false)
      assert(res.error && /method not found/.test(res.error))
    } finally {
      c.close()
    }
  } finally {
    await stopGateway(gw)
  }
})

Deno.test(
  'ws: non-WS request to /v1/session/ws returns 426',
  sub,
  async () => {
    const gw = await startGateway()
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/v1/session/ws`)
      assertEquals(res.status, 426)
      await res.body?.cancel()
    } finally {
      await stopGateway(gw)
    }
  },
)
