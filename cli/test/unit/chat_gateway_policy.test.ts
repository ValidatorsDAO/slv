import { assertEquals, assertStringIncludes } from '@std/assert'
import { GatewaySessionProvider } from '@/ai/core/sessionClient.ts'
import { dispatchRequest, newConnState } from '@/gateway/ws/router.ts'
import {
  FAR_FUTURE,
  loggedIn,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const response = () =>
  new Response(
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'Ready.' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  )

Deno.test({
  name:
    'CLI intent survives the real WebSocket path and short operational replies retain high effort',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withHome({ lang: 'en', slv: loggedIn(FAR_FUTURE) }, async () => {
      const token = 'a'.repeat(64)
      const state = newConnState()
      let peer: WebSocket | undefined
      let closed: Promise<void> = Promise.resolve()
      const server = Deno.serve({
        hostname: '127.0.0.1',
        port: 0,
        onListen: () => {},
      }, (request) => {
        const upgraded = Deno.upgradeWebSocket(request)
        peer = upgraded.socket
        closed = new Promise((resolve) =>
          upgraded.socket.addEventListener('close', () => resolve(), {
            once: true,
          })
        )
        upgraded.socket.addEventListener('message', async (event) => {
          const result = await dispatchRequest(
            JSON.parse(String(event.data)),
            state,
            {
              token,
              emitEvent: (event) =>
                upgraded.socket.send(
                  JSON.stringify({
                    kind: 'event',
                    event: event.type,
                    payload: event,
                  }),
                ),
            },
          )
          upgraded.socket.send(JSON.stringify(result))
        })
        return upgraded.response
      })
      const client = new GatewaySessionProvider(
        `ws://127.0.0.1:${server.addr.port}`,
        token,
        'SLV AI',
        '',
        { onStream: () => {}, onToolCall: () => {}, onComplete: () => {} },
      )
      try {
        await withFetch((url) => {
          assertStringIncludes(url, '/v3/ai/chat')
          return response()
        }, async (requests) => {
          await client.chat('2', { intent: 'validator_ops' })
          await client.chat('それでお願いします')
          await client.chat('hi')
          assertEquals(
            requests.map((r) => JSON.parse(r.body!).output_config.effort),
            ['high', 'high', 'low'],
          )
          assertEquals(JSON.parse(requests[0].body!).messages[0], {
            role: 'user',
            content: '2',
          })
          assertEquals(JSON.parse(requests[2].body!).tools, [])
        })
      } finally {
        client.dispose()
        if (peer?.readyState === WebSocket.OPEN) peer.close()
        await closed
        await server.shutdown()
      }
    })
  },
})

Deno.test('gateway rejects an invalid intent before resolving credentials or sending a provider request', async () => {
  const state = newConnState()
  state.authenticated = true
  await withFetch(() => {
    throw new Error('No remote request')
  }, async (requests) => {
    const result = await dispatchRequest(
      {
        kind: 'req',
        id: 'invalid',
        method: 'session.send',
        params: { text: '2', intent: 'invented_operation' },
      },
      state,
      { token: 'test', emitEvent: () => {} },
    )
    assertEquals(result.ok, false)
    assertStringIncludes(result.error!, 'params.intent')
    assertEquals(requests.length, 0)
  })
})
