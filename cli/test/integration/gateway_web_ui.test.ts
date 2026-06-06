import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import {
  startGateway,
  stopGateway,
  sub,
} from '/test/integration/_gateway_helpers.ts'

// Verifies the browser-UI endpoints serve the expected HTML with
// the gateway's token inlined as a data-attribute. Loopback only.
// Shared spawn/health/cleanup lives in _gateway_helpers.ts.

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
