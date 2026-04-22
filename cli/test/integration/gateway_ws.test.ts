import { assert, assertEquals } from '@std/assert'
import { join } from '@std/path'

// End-to-end WS protocol tests against a real gateway subprocess.
// Spawns `slv gateway run` with isolated HOME + random port, opens a
// browser WebSocket to /v1/session/ws, walks the hello → auth → ping
// handshake, and verifies invalid frames + unknown methods are
// rejected cleanly.

const CLI_ENTRY = new URL('../../src/index.ts', import.meta.url).pathname
const pickPort = (): number => 30000 + Math.floor(Math.random() * 10000)

type Gw = {
  child: Deno.ChildProcess
  home: string
  port: number
  token: string
  stderr: Promise<string>
}

const startGateway = async (): Promise<Gw> => {
  const home = await Deno.makeTempDir({ prefix: 'slv-gw-ws-' })
  const port = pickPort()
  const child = new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', '--no-check', CLI_ENTRY, 'gateway', 'run'],
    env: {
      HOME: home,
      PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
      SLV_GATEWAY_PORT: String(port),
    },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  const drain = async (s: ReadableStream<Uint8Array>): Promise<string> => {
    const r = s.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await r.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const buf = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      buf.set(c, o)
      o += c.length
    }
    return new TextDecoder().decode(buf)
  }
  drain(child.stdout).catch(() => {})
  const stderr = drain(child.stderr).catch(() => '')

  // Poll /healthz until the server is up, then read the token from
  // the config file written by the first run.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) {
        await res.body?.cancel()
        break
      }
      await res.body?.cancel()
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  const cfg = JSON.parse(
    await Deno.readTextFile(join(home, '.slv/gateway/gateway.json')),
  ) as { token: string }

  return { child, home, port, token: cfg.token, stderr }
}

const stopGateway = async (gw: Gw): Promise<void> => {
  try {
    gw.child.kill('SIGTERM')
  } catch { /* already dead */ }
  await gw.child.status.catch(() => {})
  await gw.stderr
  await Deno.remove(gw.home, { recursive: true }).catch(() => {})
}

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

const sub = { sanitizeResources: false, sanitizeOps: false } as const

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
