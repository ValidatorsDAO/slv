import { assert, assertEquals } from '@std/assert'
import { join } from '@std/path'

// End-to-end WS tests for Phase 2B's `session.echo` + `session.abort`
// methods. Boots a real gateway subprocess, authenticates, issues the
// session methods, and collects streaming event frames.

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
  const home = await Deno.makeTempDir({ prefix: 'slv-gw-sess-' })
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

type Frame =
  | { kind: 'res'; id: string; ok: boolean; payload?: unknown; error?: string }
  | { kind: 'event'; event: string; payload?: unknown; seq: number }

type WsClient = {
  socket: WebSocket
  call: (
    method: string,
    params?: unknown,
  ) => Promise<Extract<Frame, { kind: 'res' }>>
  events: Frame[]
  eventsOfType: (t: string) => unknown[]
  waitForEvent: (
    predicate: (f: Extract<Frame, { kind: 'event' }>) => boolean,
    timeoutMs?: number,
  ) => Promise<Extract<Frame, { kind: 'event' }>>
  close: () => void
}

const openWs = (port: number): Promise<WsClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session/ws`)
    const pendingRes = new Map<
      string,
      (r: Extract<Frame, { kind: 'res' }>) => void
    >()
    const events: Frame[] = []
    const eventWaiters: Array<{
      check: (f: Extract<Frame, { kind: 'event' }>) => boolean
      resolve: (f: Extract<Frame, { kind: 'event' }>) => void
    }> = []
    let counter = 0
    ws.onopen = () => {
      resolve({
        socket: ws,
        call: (method, params) =>
          new Promise((res) => {
            const id = `t${++counter}`
            pendingRes.set(id, res)
            ws.send(JSON.stringify({ kind: 'req', id, method, params }))
          }),
        events,
        eventsOfType: (t) =>
          events
            .filter((e): e is Extract<Frame, { kind: 'event' }> =>
              e.kind === 'event' && e.event === t
            )
            .map((e) => e.payload),
        waitForEvent: (predicate, timeoutMs = 5000) =>
          new Promise((resolve2, reject2) => {
            const existing = events.find((e): e is Extract<Frame, { kind: 'event' }> =>
              e.kind === 'event' && predicate(e)
            )
            if (existing) {
              resolve2(existing)
              return
            }
            const timer = setTimeout(() => reject2(new Error('event wait timeout')), timeoutMs)
            eventWaiters.push({
              check: predicate,
              resolve: (f) => {
                clearTimeout(timer)
                resolve2(f)
              },
            })
          }),
        close: () => ws.close(),
      })
    }
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Frame
      if (f.kind === 'res') {
        const r = pendingRes.get(f.id)
        if (r) {
          pendingRes.delete(f.id)
          r(f)
        }
      } else if (f.kind === 'event') {
        events.push(f)
        for (let i = eventWaiters.length - 1; i >= 0; i--) {
          if (eventWaiters[i].check(f)) {
            eventWaiters[i].resolve(f)
            eventWaiters.splice(i, 1)
          }
        }
      }
    }
    ws.onerror = (e) => reject(e)
  })

const sub = { sanitizeResources: false, sanitizeOps: false } as const

Deno.test(
  'ws: session.echo streams text_delta events then complete',
  sub,
  async () => {
    const gw = await startGateway()
    try {
      const c = await openWs(gw.port)
      try {
        const auth = await c.call('gateway.auth', { token: gw.token })
        assertEquals(auth.ok, true)

        const res = await c.call('session.echo', { text: 'hello world foo' })
        assertEquals(res.ok, true)
        assertEquals((res.payload as { accepted: boolean }).accepted, true)

        // Wait for the complete event
        await c.waitForEvent((f) => {
          const p = f.payload as { type: string } | undefined
          return p?.type === 'complete'
        })

        const deltas = c.eventsOfType('text_delta') as Array<{ text: string }>
        assertEquals(deltas.length, 3)
        const concat = deltas.map((d) => d.text).join('')
        assertEquals(concat, 'hello world foo')

        // Seq is monotonically increasing
        const seqs = c.events
          .filter((e): e is Extract<Frame, { kind: 'event' }> => e.kind === 'event')
          .map((e) => e.seq)
        for (let i = 1; i < seqs.length; i++) {
          assert(seqs[i] > seqs[i - 1], `seq must increase: ${seqs[i - 1]} → ${seqs[i]}`)
        }
      } finally {
        c.close()
      }
    } finally {
      await stopGateway(gw)
    }
  },
)

Deno.test('ws: session.abort cancels in-flight echo', sub, async () => {
  const gw = await startGateway()
  try {
    const c = await openWs(gw.port)
    try {
      await c.call('gateway.auth', { token: gw.token })

      const sent = await c.call('session.echo', {
        text: 'one two three four five six seven eight',
      })
      assertEquals(sent.ok, true)

      // Let ~one token stream, then abort
      await new Promise((r) => setTimeout(r, 60))
      const abort = await c.call('session.abort')
      assertEquals(abort.ok, true)
      assertEquals((abort.payload as { wasRunning: boolean }).wasRunning, true)

      await c.waitForEvent((f) => {
        const p = f.payload as { type: string } | undefined
        return p?.type === 'aborted'
      })

      // No `complete` should have fired
      const complete = c.eventsOfType('complete')
      assertEquals(complete.length, 0)
    } finally {
      c.close()
    }
  } finally {
    await stopGateway(gw)
  }
})

Deno.test('ws: session.echo requires auth', sub, async () => {
  const gw = await startGateway()
  try {
    const c = await openWs(gw.port)
    try {
      const res = await c.call('session.echo', { text: 'hi' })
      assertEquals(res.ok, false)
      assert(res.error && /not authenticated/.test(res.error))
    } finally {
      c.close()
    }
  } finally {
    await stopGateway(gw)
  }
})
