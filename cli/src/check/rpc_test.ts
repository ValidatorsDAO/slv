import { assertEquals } from '@std/assert'
import { checkRpcEndpoint, sanitizeEndpointForDisplay } from '@/check/rpc.ts'

async function getFreePort(): Promise<number> {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const { port } = listener.addr as Deno.NetAddr
  listener.close()
  return port
}

Deno.test('sanitizeEndpointForDisplay masks sensitive query params', () => {
  const endpoint =
    'https://rpc.example.com/?api-key=secret&token=abc123&cluster=mainnet'
  assertEquals(
    sanitizeEndpointForDisplay(endpoint),
    'https://rpc.example.com/?api-key=***&token=***&cluster=mainnet',
  )
})

Deno.test('checkRpcEndpoint supports http json-rpc', async () => {
  const port = await getFreePort()

  const server = Deno.serve(
    { hostname: '127.0.0.1', port },
    async (request: Request) => {
      const payload = await request.json()
      assertEquals(payload.method, 'getBlockHeight')
      return Response.json({ jsonrpc: '2.0', id: 1, result: 12345 })
    },
  )

  try {
    const result = await checkRpcEndpoint(
      `http://127.0.0.1:${port}/?api-key=test`,
      3_000,
    )
    assertEquals(result.ok, true)
    assertEquals(result.transport, 'http')
    assertEquals(result.summary, 'HTTP 200, block height 12345')
  } finally {
    await server.shutdown()
  }
})

Deno.test('checkRpcEndpoint reports invalid http json cleanly', async () => {
  const port = await getFreePort()

  const server = Deno.serve(
    { hostname: '127.0.0.1', port },
    () => new Response('nope', { status: 200 }),
  )

  try {
    const result = await checkRpcEndpoint(`http://127.0.0.1:${port}`, 3_000)
    assertEquals(result.ok, false)
    assertEquals(result.summary, 'HTTP 200 returned invalid JSON-RPC response')
  } finally {
    await server.shutdown()
  }
})

Deno.test('checkRpcEndpoint supports websocket json-rpc subscriptions', async () => {
  const port = await getFreePort()

  const server = Deno.serve(
    { hostname: '127.0.0.1', port },
    (request: Request) => {
      const { socket, response } = Deno.upgradeWebSocket(request)
      socket.onmessage = (event) => {
        const payload = JSON.parse(String(event.data))
        assertEquals(payload.method, 'slotSubscribe')
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 77 }))
      }
      return response
    },
  )

  try {
    const result = await checkRpcEndpoint(
      `ws://127.0.0.1:${port}/?api-key=test`,
      3_000,
    )
    assertEquals(result.ok, true)
    assertEquals(result.transport, 'ws')
    assertEquals(result.summary, 'subscription accepted, id 77')
  } finally {
    await server.shutdown()
  }
})

Deno.test('checkRpcEndpoint reports websocket json-rpc errors cleanly', async () => {
  const port = await getFreePort()

  const server = Deno.serve(
    { hostname: '127.0.0.1', port },
    (request: Request) => {
      const { socket, response } = Deno.upgradeWebSocket(request)
      socket.onmessage = () => {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'subscription disabled' },
        }))
      }
      return response
    },
  )

  try {
    const result = await checkRpcEndpoint(`ws://127.0.0.1:${port}`, 3_000)
    assertEquals(result.ok, false)
    assertEquals(result.summary, 'JSON-RPC error -32000: subscription disabled')
  } finally {
    await server.shutdown()
  }
})

Deno.test('checkRpcEndpoint rejects invalid URL input', async () => {
  await Promise.reject()
    .catch(async () => {
      const result = await checkRpcEndpoint('not-a-url', 3_000)
      return result
    })
    .then(() => {
      throw new Error('expected invalid URL to throw')
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assertEquals(message, 'Invalid URL. Use http(s):// or ws(s)://')
    })
})
