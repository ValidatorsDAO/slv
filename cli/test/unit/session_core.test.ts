import { assert, assertEquals } from '@std/assert'
import { echoDriver, Session } from '/src/ai/core/session.ts'
import type { SessionEvent } from '/src/ai/core/events.ts'

const collect = (s: Session): SessionEvent[] => {
  const events: SessionEvent[] = []
  s.on((e) => events.push(e))
  return events
}

Deno.test('echo driver produces one text_delta per token then complete', async () => {
  const s = new Session(echoDriver)
  const events = collect(s)
  await s.send('hello world foo')
  // Events: status(running) + 3 text_delta + complete + status(idle)
  const deltas = events.filter((e) => e.type === 'text_delta')
  assertEquals(deltas.length, 3)
  assertEquals(events.find((e) => e.type === 'complete') !== undefined, true)
  // Terminal + idle always fire
  assertEquals(
    events.filter((e) => e.type === 'status' && e.state === 'idle').length,
    1,
  )
})

Deno.test('Session emits complete even if driver forgets to', async () => {
  const s = new Session(async (_text, _ctx) => {
    // driver emits nothing
  })
  const events = collect(s)
  await s.send('x')
  assertEquals(events.find((e) => e.type === 'complete') !== undefined, true)
})

Deno.test('Session emits error when driver throws (non-abort)', async () => {
  const s = new Session(async () => {
    throw new Error('boom')
  })
  const events = collect(s)
  await s.send('x')
  const err = events.find((e) => e.type === 'error')
  assert(err && err.type === 'error')
  assertEquals(err.message, 'boom')
})

Deno.test('Session.abort during echo fires aborted, not complete', async () => {
  const s = new Session(echoDriver)
  const events = collect(s)
  // Start a multi-token echo but abort before it finishes
  const p = s.send('one two three four five six')
  setTimeout(() => s.abort('test reason'), 60)
  await p
  assert(events.some((e) => e.type === 'aborted'))
  assert(!events.some((e) => e.type === 'complete'))
})

Deno.test('Session refuses overlapping sends', async () => {
  const s = new Session(echoDriver)
  const events = collect(s)
  const first = s.send('one two three')
  await s.send('overlap')
  const errs = events.filter((e) => e.type === 'error')
  assert(errs.some((e) => e.type === 'error' && /already processing/.test(e.message)))
  await first
})

Deno.test('listeners can unsubscribe and stop seeing events', async () => {
  const s = new Session(echoDriver)
  const seen: SessionEvent[] = []
  const unsub = s.on((e) => seen.push(e))
  unsub()
  await s.send('hi')
  assertEquals(seen.length, 0)
})

Deno.test('listener errors do not break other listeners', async () => {
  const s = new Session(echoDriver)
  const good: SessionEvent[] = []
  s.on(() => {
    throw new Error('listener-bug')
  })
  s.on((e) => good.push(e))
  await s.send('hi')
  assert(good.length > 0, 'good listener should still have received events')
})
