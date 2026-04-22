import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

// Verifies the browser-UI endpoints serve the expected HTML with
// the gateway's token inlined as a data-attribute. Loopback only.

const CLI_ENTRY = new URL('../../src/index.ts', import.meta.url).pathname
const pickPort = (): number => 30000 + Math.floor(Math.random() * 10000)

const startGateway = async () => {
  const home = await Deno.makeTempDir({ prefix: 'slv-gw-ui-' })
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
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader()
    while (true) {
      const { done } = await r.read()
      if (done) break
    }
  }
  drain(child.stdout).catch(() => {})
  drain(child.stderr).catch(() => '')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) {
        await res.body?.cancel()
        break
      }
      await res.body?.cancel()
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  const cfg = JSON.parse(
    await Deno.readTextFile(join(home, '.slv/gateway/gateway.json')),
  ) as { token: string }
  return { child, home, port, token: cfg.token }
}

const stopGateway = async (
  gw: { child: Deno.ChildProcess; home: string },
) => {
  try {
    gw.child.kill('SIGTERM')
  } catch { /* already dead */ }
  await gw.child.status.catch(() => {})
  await Deno.remove(gw.home, { recursive: true }).catch(() => {})
}

const sub = { sanitizeResources: false, sanitizeOps: false } as const

Deno.test('ui: GET /ui/ serves HTML with token inlined', sub, async () => {
  const gw = await startGateway()
  try {
    const res = await fetch(`http://127.0.0.1:${gw.port}/ui/`)
    assertEquals(res.status, 200)
    assertStringIncludes(
      res.headers.get('content-type') ?? '',
      'text/html',
    )
    const body = await res.text()
    assertStringIncludes(body, '<!doctype html>')
    assertStringIncludes(body, `data-slv-token="${gw.token}"`)
    assertStringIncludes(body, 'SLV Chat')
    // The JS bootstraps with ws:// + session.send + session.abort
    assertStringIncludes(body, 'v1/session/ws')
    assertStringIncludes(body, 'session.send')
    assertStringIncludes(body, 'session.abort')
  } finally {
    await stopGateway(gw)
  }
})

Deno.test('ui: /ui (no trailing slash) also serves HTML', sub, async () => {
  const gw = await startGateway()
  try {
    const res = await fetch(`http://127.0.0.1:${gw.port}/ui`)
    assertEquals(res.status, 200)
    const body = await res.text()
    assertStringIncludes(body, '<!doctype html>')
  } finally {
    await stopGateway(gw)
  }
})

Deno.test(
  'ui: token inlined is exactly the gateway token (not truncated/escaped)',
  sub,
  async () => {
    const gw = await startGateway()
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/ui/`)
      const body = await res.text()
      // Token is 64 hex chars; make sure nothing mangled it.
      const match = body.match(/data-slv-token="([^"]+)"/)
      assert(match, 'data-slv-token attribute missing')
      assertEquals(match[1], gw.token)
      assertEquals(match[1].length, 64)
    } finally {
      await stopGateway(gw)
    }
  },
)
