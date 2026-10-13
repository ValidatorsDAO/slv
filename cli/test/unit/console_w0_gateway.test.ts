import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStringIncludes,
} from '@std/assert'

import {
  type DispatchCtx,
  dispatchRequest,
  newConnState,
} from '/src/gateway/ws/router.ts'
import { setAutoExecute, setTuiInstance } from '@/ai/console/tools.ts'
import * as tools from '@/ai/console/tools.ts'
import {
  FAR_FUTURE,
  loggedIn,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const CHAT_URL = 'https://user-api.erpc.global/v3/ai/chat'

const sse = (events: unknown[]): Response =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

// What the model sends back: one tool call, then a closing text.
const toolUseTurn = (name: string, input: Record<string, unknown>): Response =>
  sse([
    { type: 'message_start' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(input),
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ])

const textTurn = (text: string): Response =>
  sse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ])

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

/** A home with an ERPC login and the SLV AI provider; `autoExecute` is written
 *  to the agent config only when it is given. */
const withGatewayHome = async (
  autoExecute: boolean | undefined,
  fn: (home: string) => Promise<void>,
): Promise<void> => {
  await withHome(
    {
      slv: loggedIn(FAR_FUTURE),
      ai: { provider: 'slv', model: 'SLV AI' },
    },
    async (home) => {
      if (autoExecute !== undefined) {
        await Deno.mkdir(`${home}/.slv/agent`, { recursive: true })
        await Deno.writeTextFile(
          `${home}/.slv/agent/config.yml`,
          `auto_execute: ${autoExecute}\n`,
        )
      }
      const log = console.log
      console.log = () => {}
      try {
        await fn(home)
      } finally {
        console.log = log
        setAutoExecute(false)
        setTuiInstance(null)
      }
    },
  )
}

/**
 * Send one chat turn through the gateway router. The model answers with a
 * call to one tool and the result it gets back is returned.
 */
const gatewayToolCall = async (
  name: string,
  input: Record<string, unknown>,
): Promise<string> => {
  let calls = 0
  let toolResult = ''
  await withFetch((url) => {
    assertEquals(url, CHAT_URL)
    calls++
    return calls === 1 ? toolUseTurn(name, input) : textTurn('done')
  }, async (requests) => {
    const state = newConnState()
    state.authenticated = true
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const events: string[] = []
    const ctx: DispatchCtx = {
      token: crypto.randomUUID(),
      emitEvent: (event) => {
        events.push(event.type)
        if (
          event.type === 'complete' || event.type === 'error' ||
          event.type === 'aborted'
        ) finish()
      },
    }
    const res = await dispatchRequest(
      { kind: 'req', id: '1', method: 'session.send', params: { text: 'go' } },
      state,
      ctx,
    )
    assertEquals(res.ok, true, res.error)
    await finished
    assertEquals(events.includes('error'), false, events.join(','))
    assertEquals(requests.length, 2)
    const second = JSON.parse(requests[1].body ?? '{}')
    const last = second.messages.at(-1)
    toolResult = String(last.content[0].content)
  })
  return toolResult
}

const gatewayRunCommand = (command: string): Promise<string> =>
  gatewayToolCall('run_command', { command })

Deno.test('a gateway session runs no command with the default config and runs a read-only one with auto_execute: true', async () => {
  await withGatewayHome(undefined, async (home) => {
    const marker = `${home}/ran`
    const ls = await gatewayRunCommand(`ls -la '${home}'`)
    assertStringIncludes(ls, 'not run')
    assertStringIncludes(ls, 'auto_execute: true')
    assertFalse(/ \.slv$/m.test(ls), 'the listing was returned')

    const touched = await gatewayRunCommand(`touch '${marker}'`)
    assertStringIncludes(touched, 'not run')
    assertFalse(await exists(marker), 'the command ran')
  })

  await withGatewayHome(true, async (home) => {
    const marker = `${home}/ran`
    const ls = await gatewayRunCommand(`ls -la '${home}'`)
    assertFalse(ls.includes('not run'), ls)
    assert(/ \.slv$/m.test(ls), 'the listing was not returned')

    // a command that writes is not read-only: no person, no run
    const touched = await gatewayRunCommand(`touch '${marker}'`)
    assertStringIncludes(touched, 'not run')
    assertStringIncludes(touched, 'read-only')
    assertFalse(await exists(marker), 'the command ran')
  })

  // run_command itself starts with auto-execute off
  const source = await Deno.readTextFile(
    new URL('../../src/ai/console/tools.ts', import.meta.url),
  )
  assertMatch(source, /let autoExecuteCommands = false\b/)
})

Deno.test('a gated command is refused in a gateway session whatever the config says', async () => {
  for (const autoExecute of [undefined, false, true]) {
    await withGatewayHome(autoExecute, async (home) => {
      await Deno.mkdir(`${home}/victim`)
      const results = [
        await gatewayRunCommand(`rm -rf '${home}/victim'`),
        await gatewayRunCommand(`sudo rm -rf '${home}/victim'`),
        await gatewayRunCommand(`bash -c "rm -rf '${home}/victim'"`),
        await gatewayRunCommand(`touch '${home}/m' && ssh -V`),
      ]
      for (const result of results) {
        assertStringIncludes(result, 'not run')
        assertStringIncludes(result, 'terminal')
      }
      assert(await exists(`${home}/victim`), `auto_execute=${autoExecute}`)
      assertFalse(await exists(`${home}/m`), `auto_execute=${autoExecute}`)
    })
  }
})

Deno.test('a gateway session cannot switch auto_execute on by writing the agent config', async () => {
  await withGatewayHome(undefined, async (home) => {
    const config = `${home}/.slv/agent/config.yml`
    const written = await gatewayToolCall('write_file', {
      path: config,
      content: 'auto_execute: true\n',
    })
    assert(written.startsWith('Error'), written)
    assertFalse(await exists(config), 'the config was written')

    const marker = `${home}/ran`
    const result = await gatewayRunCommand(`touch '${marker}'`)
    assertStringIncludes(result, 'not run')
    assertFalse(await exists(marker), 'the command ran')
  })
})

Deno.test('the config is read again for each turn', async () => {
  await withGatewayHome(false, async (home) => {
    const listing = `ls -a '${home}'`
    const before = await gatewayRunCommand(listing)
    assertStringIncludes(before, 'not run')

    await Deno.writeTextFile(
      `${home}/.slv/agent/config.yml`,
      'auto_execute: true\n',
    )
    const during = await gatewayRunCommand(listing)
    assertFalse(during.includes('not run'), during)
    assertStringIncludes(during, '.slv')

    await Deno.writeTextFile(
      `${home}/.slv/agent/config.yml`,
      'auto_execute: false\n',
    )
    const after = await gatewayRunCommand(listing)
    assertStringIncludes(after, 'not run')
  })
})

Deno.test('session.info applies the config as well', async () => {
  for (const autoExecute of [true, false]) {
    await withGatewayHome(autoExecute, async (home) => {
      setAutoExecute(!autoExecute)
      const state = newConnState()
      state.authenticated = true
      const res = await dispatchRequest(
        { kind: 'req', id: '1', method: 'session.info' },
        state,
        { token: 'x', emitEvent: () => {} },
      )
      assertEquals(res.ok, true)
      const result = await tools.executeTool('run_command', {
        command: `ls -a '${home}'`,
      })
      assertEquals(result.includes('not run'), !autoExecute, result)
    })
  }
})
