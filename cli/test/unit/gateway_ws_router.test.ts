import { assert, assertEquals } from '@std/assert'
import {
  dispatchRequest,
  getSupportedMethods,
  newConnState,
} from '/src/gateway/ws/router.ts'

const TOKEN = 'a'.repeat(64)

Deno.test('gateway.hello works before auth', async () => {
  const state = newConnState()
  const res = await dispatchRequest(
    { kind: 'req', id: '1', method: 'gateway.hello' },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, true)
  const payload = res.payload as Record<string, unknown>
  assertEquals(payload.service, 'slv-gateway')
  assert(typeof payload.protocol === 'number')
  assertEquals(state.authenticated, false, 'hello should not auth')
})

Deno.test('gateway.auth rejects wrong token', async () => {
  const state = newConnState()
  const res = await dispatchRequest(
    {
      kind: 'req',
      id: '2',
      method: 'gateway.auth',
      params: { token: 'wrong' },
    },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, false)
  assertEquals(state.authenticated, false)
})

Deno.test('gateway.auth accepts matching token', async () => {
  const state = newConnState()
  const res = await dispatchRequest(
    {
      kind: 'req',
      id: '3',
      method: 'gateway.auth',
      params: { token: TOKEN },
    },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, true)
  assertEquals(state.authenticated, true)
})

Deno.test('gateway.ping requires auth', async () => {
  const state = newConnState()
  const res = await dispatchRequest(
    { kind: 'req', id: '4', method: 'gateway.ping' },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, false)
  assert(res.error && /not authenticated/.test(res.error))
})

Deno.test('gateway.ping works after auth', async () => {
  const state = newConnState()
  state.authenticated = true
  const res = await dispatchRequest(
    { kind: 'req', id: '5', method: 'gateway.ping' },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, true)
  assertEquals((res.payload as { pong: boolean }).pong, true)
})

Deno.test('unknown method returns "method not found"', async () => {
  const state = newConnState()
  const res = await dispatchRequest(
    { kind: 'req', id: '6', method: 'does.not.exist' },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, false)
  assert(res.error && /method not found/.test(res.error))
})

Deno.test('supported methods include the Phase 2A handshake set', () => {
  const methods = getSupportedMethods()
  assert(methods.includes('gateway.hello'))
  assert(methods.includes('gateway.auth'))
  assert(methods.includes('gateway.ping'))
})

Deno.test('gateway.auth rejects missing token param', async () => {
  const state = newConnState()
  const res = await dispatchRequest(
    { kind: 'req', id: '7', method: 'gateway.auth', params: {} },
    state,
    { token: TOKEN },
  )
  assertEquals(res.ok, false)
  assertEquals(state.authenticated, false)
})
