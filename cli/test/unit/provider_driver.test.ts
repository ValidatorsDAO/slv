import { assert, assertEquals } from '@std/assert'
import { providerDriver } from '/src/ai/core/drivers/provider.ts'
import { Session } from '/src/ai/core/session.ts'
import type { SessionEvent } from '/src/ai/core/events.ts'
import type { ChatCallbacks } from '/src/ai/console/consoleAction.ts'
import type { ProviderLike } from '/src/ai/core/drivers/provider.ts'

// Tests use a mock provider to keep the cookbook-translation logic
// (cumulative-text → delta, onToolCall → tool_use_start, etc.)
// exercised without network. Real-provider wire-level behavior is
// verified by the existing remote VPS smoke.

type MockScript = ({
  stream?: string
  toolCall?: { name: string; detail: string }
  throw?: Error
  delayMs?: number
})[]

const buildMock = (script: MockScript) => (callbacks: ChatCallbacks): ProviderLike => ({
  chat: async (_text: string) => {
    for (const step of script) {
      if (step.delayMs) {
        await new Promise((r) => setTimeout(r, step.delayMs))
      }
      if (step.throw) throw step.throw
      if (step.stream !== undefined) callbacks.onStream(step.stream)
      if (step.toolCall) {
        callbacks.onToolCall(step.toolCall.name, step.toolCall.detail)
      }
    }
    callbacks.onComplete()
  },
})

const collect = (session: Session): SessionEvent[] => {
  const events: SessionEvent[] = []
  session.on((e) => events.push(e))
  return events
}

Deno.test('providerDriver computes text_delta from cumulative stream', async () => {
  const build = buildMock([
    { stream: 'Hel' },
    { stream: 'Hello' },
    { stream: 'Hello, wo' },
    { stream: 'Hello, world' },
  ])
  const session = new Session(providerDriver({ build }))
  const events = collect(session)
  await session.send('hi')

  const deltas = events
    .filter((e): e is Extract<SessionEvent, { type: 'text_delta' }> =>
      e.type === 'text_delta'
    )
    .map((e) => e.text)
  // Cumulative: Hel → Hello → Hello, wo → Hello, world
  // Deltas:      Hel  +   lo  +   , wo  +   rld
  assertEquals(deltas, ['Hel', 'lo', ', wo', 'rld'])
  assertEquals(
    events.find((e) => e.type === 'complete') !== undefined,
    true,
  )
})

Deno.test('providerDriver emits tool_use_start with parsed args', async () => {
  const build = buildMock([
    {
      toolCall: {
        name: 'run_command',
        detail: '{"command":"echo hi"}',
      },
    },
  ])
  const session = new Session(providerDriver({ build }))
  const events = collect(session)
  await session.send('run it')

  const tool = events.find((e): e is Extract<SessionEvent, { type: 'tool_use_start' }> =>
    e.type === 'tool_use_start'
  )
  assert(tool)
  assertEquals(tool.name, 'run_command')
  assertEquals((tool.args as { command: string }).command, 'echo hi')
  // Tool ID includes the tool name
  assert(tool.id.startsWith('run_command-'))
})

Deno.test('providerDriver falls back to raw string args if JSON invalid', async () => {
  const build = buildMock([
    {
      toolCall: {
        name: 'mystery',
        detail: 'not json',
      },
    },
  ])
  const session = new Session(providerDriver({ build }))
  const events = collect(session)
  await session.send('x')

  const tool = events.find((e): e is Extract<SessionEvent, { type: 'tool_use_start' }> =>
    e.type === 'tool_use_start'
  )
  assert(tool)
  assertEquals(tool.args, 'not json')
})

Deno.test('providerDriver emits error when provider throws (not aborted)', async () => {
  const build = buildMock([{ throw: new Error('API limit exceeded') }])
  const session = new Session(providerDriver({ build }))
  const events = collect(session)
  await session.send('x')

  const err = events.find((e): e is Extract<SessionEvent, { type: 'error' }> =>
    e.type === 'error'
  )
  assert(err)
  assertEquals(err.message, 'API limit exceeded')
  // NOT `aborted` — the provider threw independently
  assertEquals(events.find((e) => e.type === 'aborted'), undefined)
})

Deno.test('providerDriver emits aborted when Session.abort fires mid-chat', async () => {
  const build = buildMock([
    { stream: 'start', delayMs: 50 },
    { stream: 'start middle', delayMs: 50 },
    { stream: 'start middle end', delayMs: 50 },
  ])
  const session = new Session(providerDriver({ build }))
  const events = collect(session)
  const promise = session.send('x')
  // Abort after the first chunk but before the last
  setTimeout(() => session.abort('test'), 75)
  await promise

  // We should see an aborted terminal, not complete
  const aborted = events.find((e) => e.type === 'aborted')
  const complete = events.find((e) => e.type === 'complete')
  assert(aborted, 'expected aborted event')
  assertEquals(complete, undefined, 'complete should not fire when aborted')
})

Deno.test('providerDriver ignores zero-length text_delta', async () => {
  // If the provider fires onStream with identical cumulative text
  // twice (no new chars), we should NOT emit an empty text_delta.
  const build = buildMock([
    { stream: 'hi' },
    { stream: 'hi' }, // same — delta is empty
    { stream: 'hi!' }, // adds '!'
  ])
  const session = new Session(providerDriver({ build }))
  const events = collect(session)
  await session.send('x')

  const deltas = events
    .filter((e): e is Extract<SessionEvent, { type: 'text_delta' }> =>
      e.type === 'text_delta'
    )
    .map((e) => e.text)
  assertEquals(deltas, ['hi', '!'])
})
