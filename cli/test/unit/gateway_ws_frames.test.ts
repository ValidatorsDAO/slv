import { assertEquals } from '@std/assert'
import {
  encodeFrame,
  parseFrame,
  resErr,
  resOk,
} from '/src/gateway/ws/frames.ts'

Deno.test('parseFrame accepts a minimal req', () => {
  const got = parseFrame({ kind: 'req', id: '1', method: 'gateway.hello' })
  assertEquals(got.kind, 'req')
})

Deno.test('parseFrame rejects missing method', () => {
  const got = parseFrame({ kind: 'req', id: '1' })
  assertEquals(got.kind, 'parse_error')
})

Deno.test('parseFrame rejects empty id', () => {
  const got = parseFrame({ kind: 'req', id: '', method: 'x' })
  assertEquals(got.kind, 'parse_error')
})

Deno.test('parseFrame rejects unknown kind', () => {
  const got = parseFrame({ kind: 'ping', id: '1' })
  assertEquals(got.kind, 'parse_error')
})

Deno.test('parseFrame accepts event with seq', () => {
  const got = parseFrame({ kind: 'event', event: 'foo', seq: 42 })
  assertEquals(got.kind, 'event')
})

Deno.test('resOk echoes req.id and marks ok', () => {
  const req = { kind: 'req' as const, id: 'abc', method: 'x' }
  const got = resOk(req, { hi: true })
  assertEquals(got, { kind: 'res', id: 'abc', ok: true, payload: { hi: true } })
})

Deno.test('resErr echoes id and surfaces message', () => {
  const got = resErr({ id: 'z' }, 'nope')
  assertEquals(got, { kind: 'res', id: 'z', ok: false, error: 'nope' })
})

Deno.test('resErr handles null req (pre-parse errors)', () => {
  const got = resErr(null, 'bad json')
  assertEquals(got.id, '')
  assertEquals(got.ok, false)
})

Deno.test('encodeFrame is plain JSON', () => {
  const s = encodeFrame({ kind: 'res', id: '1', ok: true })
  assertEquals(JSON.parse(s), { kind: 'res', id: '1', ok: true })
})
