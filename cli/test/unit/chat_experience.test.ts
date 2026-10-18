import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { classifyIntent } from '@/ai/console/intentClassifier.ts'
import { isSmallTalk, turnPolicy } from '@/ai/console/turnPolicy.ts'
import {
  buildSmallTalkPrompt,
  buildSystemPrompt,
  getModuleContent,
  resetContextModules,
} from '@/ai/console/systemPrompt.ts'
import { getCommandHelp, helpArguments } from '@/ai/console/commandHelp.ts'
import { SLVProvider } from '@/ai/console/providers/slv.ts'
import {
  clearAbort,
  executeTool,
  resetActiveTools,
} from '@/ai/console/tools.ts'
import { userApiAuthFromAccessToken } from '/lib/userApi/auth.ts'
import {
  ACCESS_TOKEN,
  FAR_FUTURE,
  json,
  loggedIn,
  withCommandStub,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'
import { invalidateAgentContext } from '@/ai/agentConfig/loader.ts'

const auth = userApiAuthFromAccessToken(ACCESS_TOKEN)
const stream = (tool = false) =>
  new Response(
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? {
            type: 'tool_use',
            id: 'unexpected',
            name: 'write_file',
            input: { path: '/tmp/must-not-write', content: 'bad' },
          }
          : { type: 'text', text: 'Hello.' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ].map((x) => `data: ${JSON.stringify(x)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )

Deno.test('pure small talk skips remote classification; mixed requests and approvals do not', async () => {
  for (
    const message of [
      'hi',
      'Hello! 👋',
      'こんにちは',
      'ありがとう',
      '你好',
      'спасибо',
      'xin chào',
    ]
  ) {
    assert(isSmallTalk(message))
    await withFetch(() => {
      throw new Error('Small talk must not call the classifier')
    }, async (requests) => {
      const plan = await classifyIntent({ model: 'SLV AI', slvAuth: auth }, {
        message,
        deploymentMode: 'remote',
        enabledSpecialists: [],
      })
      assertEquals(plan.intent, 'general_chat')
      assertEquals(plan.toolsToEnable, [])
      assertEquals(plan.userContextKindsToHydrate, [])
      assertEquals(requests.length, 0)
    })
  }
  for (
    const message of [
      'hi, deploy my validator',
      'hello; slv v restart',
      'ありがとう。鍵を切り替えて',
      'はい',
      'yes',
      '2',
      'continue',
    ]
  ) assertFalse(isSmallTalk(message))
})

Deno.test('operational effort and follow-up confirmations stay above small-talk effort', () => {
  assertEquals(turnPolicy('hi').effort, 'low')
  assertEquals(
    turnPolicy('Show my subscription', 'account_billing').effort,
    'low',
  )
  assertEquals(turnPolicy('Please deploy', 'validator_deploy').effort, 'high')
  assertEquals(turnPolicy('firewall を設定したい').effort, 'high')
  assertEquals(turnPolicy('slv v check:alpenglow').effort, 'high')
  assertEquals(turnPolicy('--primary-down の確認を進めたい').effort, 'high')
  assertEquals(turnPolicy('yes', undefined, 'high').effort, 'high')
  for (
    const reply of [
      '2',
      'the second one',
      'それでお願いします',
      'はい、お願いします',
    ]
  ) {
    assertEquals(turnPolicy(reply, undefined, 'high').effort, 'high')
    assertEquals(turnPolicy(reply, 'general_chat', 'high').effort, 'high')
  }
  assertFalse(
    turnPolicy({ text: 'hi', images: [{ mime: 'image/png', base64: 'AA==' }] })
      .smallTalk,
  )
})

Deno.test('Alpenglow readiness and primary-down keep validator guidance when routing falls back', async () => {
  for (const message of ['Alpenglow readiness', '--primary-down の確認']) {
    await withFetch(
      () =>
        json({
          content: [{ type: 'text', text: 'unstructured routing reply' }],
        }),
      async () => {
        const plan = await classifyIntent({ model: 'SLV AI', slvAuth: auth }, {
          message,
          deploymentMode: 'remote',
          enabledSpecialists: [],
        })
        assertEquals(plan.intent, 'validator_ops')
        assert(plan.contextModulesToLoad.includes('validator'))
      },
    )
  }
})

Deno.test('RPC deployment context does not require a validator voting identity', async () => {
  await withFetch(
    () =>
      json({
        content: [{
          type: 'text',
          text: JSON.stringify({
            intent: 'rpc_deploy',
            contextModulesToLoad: ['validator'],
          }),
        }],
      }),
    async () => {
      const plan = await classifyIntent({ model: 'SLV AI', slvAuth: auth }, {
        message: 'deploy a devnet RPC',
        deploymentMode: 'remote',
        enabledSpecialists: [],
      })
      assert(plan.contextModulesToLoad.includes('deploy'))
      assertFalse(plan.contextModulesToLoad.includes('validator'))
    },
  )
})

Deno.test('classifier receives bounded dialogue context and explicit low effort', async () => {
  await withFetch(
    () =>
      json({
        content: [{
          type: 'text',
          text: JSON.stringify({ intent: 'validator_ops', confidence: 0.9 }),
        }],
      }),
    async (requests) => {
      await classifyIntent({ model: 'SLV AI', slvAuth: auth }, {
        message: 'the second one',
        deploymentMode: 'remote',
        enabledSpecialists: [],
        conversation: Array.from(
          { length: 8 },
          (_, i) => ({
            role: i % 2 ? 'assistant' as const : 'user' as const,
            content: String(i) + 'x'.repeat(2000),
          }),
        ),
      })
      assertEquals(requests.length, 1)
      const body = JSON.parse(requests[0].body!)
      assertEquals(body.output_config.effort, 'low')
      const dialogue = JSON.parse(body.messages[0].content).recentConversation
      assertEquals(dialogue.length, 4)
      assertEquals(dialogue[0].content[0], '4')
      assert(
        dialogue.every((t: { content: string }) => t.content.length <= 1500),
      )
    },
  )
})

Deno.test('small-talk request is one streamed call without projects, old operational history or tools', async () => {
  clearAbort()
  resetActiveTools()
  resetContextModules()
  const base =
    'Assistant name: "Example"\nPreferred response language: "ja"\nSecret project: old-project. Remind about backups.'
  const provider = new SLVProvider(auth, 'SLV AI', base, {
    onStream: () => {},
    onToolCall: () => {
      throw new Error('No tools')
    },
    onComplete: () => {},
  })
  await withFetch(() => stream(), async (requests) => {
    await provider.chat('inspect the project')
    await provider.chat('hi')
    assertEquals(requests.length, 2)
    const body = JSON.parse(requests[1].body!)
    assertEquals(body.output_config, { effort: 'low' })
    assertEquals(body.thinking, { type: 'adaptive', display: 'omitted' })
    assertEquals(body.cache_control, { type: 'ephemeral' })
    assertEquals(body.tools, [])
    assertEquals(body.messages, [{ role: 'user', content: 'hi' }])
    assertEquals(body.max_tokens, 512)
    assert(body.system.length < 1000)
    assertFalse(body.system.includes('old-project'))
    assertStringIncludes(body.system, '"ja"')
    await provider.chat('restart the validator', { intent: 'validator_ops' })
    await provider.chat('yes')
    assertEquals(JSON.parse(requests[2].body!).output_config.effort, 'high')
    assertEquals(JSON.parse(requests[3].body!).output_config.effort, 'high')
    assert(
      JSON.parse(requests[2].body!).messages.some((m: { content: unknown }) =>
        m.content === 'inspect the project'
      ),
    )
  })
})

Deno.test('unexpected small-talk tool use cannot execute or poison the next tool history', async () => {
  clearAbort()
  resetActiveTools()
  resetContextModules()
  const provider = new SLVProvider(auth, 'SLV AI', '', {
    onStream: () => {},
    onToolCall: () => {
      throw new Error('No tool must execute')
    },
    onComplete: () => {},
  })
  let count = 0
  await withFetch(() => stream(++count === 1), async (requests) => {
    await assertRejects(
      () => provider.chat('hi'),
      Error,
      'unexpected tool request',
    )
    await provider.chat('explain validator status')
    assertEquals(JSON.parse(requests[1].body!).messages.length, 1)
  })
})

Deno.test('startup prompt does not preload operational skill bodies or infer a project task', async () => {
  await withHome({ lang: 'ja' }, async (home) => {
    for (const name of ['slv-backup', 'slv-firewall', 'slv-wireguard']) {
      await Deno.mkdir(`${home}/.slv/skills/${name}`, { recursive: true })
      await Deno.writeTextFile(
        `${home}/.slv/skills/${name}/SKILL.md`,
        'SHOULD_LOAD_ONLY_ON_DEMAND'.repeat(1000),
      )
    }
    invalidateAgentContext()
    const prompt = await buildSystemPrompt()
    assertFalse(prompt.includes('SHOULD_LOAD_ONLY_ON_DEMAND'))
    assertFalse(prompt.includes('Proactive backup reminders'))
    assert(prompt.length < 14000)
    assert(buildSmallTalkPrompt(prompt).length < 1000)
  })
})

Deno.test('help tool permits only fixed help argv and never accepts operational arguments', async () => {
  assertEquals(helpArguments('install firewall'), [
    'install',
    'firewall',
    '--help',
  ])
  assertEquals(helpArguments('validator set:identity'), [
    'validator',
    'set:identity',
    '--help',
  ])
  assertEquals(helpArguments('validator check:alpenglow'), [
    'validator',
    'check:alpenglow',
    '--help',
  ])
  for (
    const input of [
      'install firewall -y',
      'validator; whoami',
      '../bin/slv',
      'validator set:identity -p host',
      'gateway config set-mode lan',
      '--help',
    ]
  ) {
    assertEquals(helpArguments(input), null)
    await withCommandStub(() => {
      throw new Error('Unknown help cannot spawn')
    }, async (commands) => {
      assertStringIncludes(await getCommandHelp(input), 'Unknown help topic')
      assertEquals(commands.length, 0)
    })
  }
})

Deno.test('truncated tool arguments or an output-limit response never execute a tool', async () => {
  for (const truncated of [true, false]) {
    clearAbort()
    resetActiveTools()
    resetContextModules()
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'partial',
          name: 'write_file',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: truncated ? '{"path":' : '{}',
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
    ]
    let toolCalls = 0
    const provider = new SLVProvider(auth, 'SLV AI', '', {
      onStream: () => {},
      onToolCall: () => {
        toolCalls++
      },
      onComplete: () => {},
    })
    await withFetch(
      () =>
        new Response(
          events.map((x) => `data: ${JSON.stringify(x)}\n\n`).join(''),
        ),
      async () => {
        await assertRejects(
          () => provider.chat('configure the firewall'),
          Error,
          truncated ? 'incomplete tool arguments' : 'output limit',
        )
        assertEquals(toolCalls, 0)
      },
    )
  }
})

Deno.test('message_stop finishes promptly and cancels a transport that remains open', async () => {
  clearAbort()
  resetActiveTools()
  resetContextModules()
  let cancelled = false
  let completed = 0
  const rendered: string[] = []
  const provider = new SLVProvider(auth, 'SLV AI', '', {
    onStream: (text) => rendered.push(text),
    onToolCall: () => {},
    onComplete: () => {
      completed++
    },
  })
  await withFetch(() =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            [
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'Complete.' },
              },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
              { type: 'message_stop' },
            ].map((x) => `data: ${JSON.stringify(x)}\n\n`).join(''),
          ))
        },
        cancel() {
          cancelled = true
        },
      }),
    ), async () => {
    await provider.chat('hello')
    assertEquals(rendered, ['Complete.'])
    assertEquals(completed, 1)
    assert(cancelled)
  })
})

Deno.test('specialist knowledge is loaded once for its task with explicit effort and caching', async () => {
  await withHome({ lang: 'en', slv: loggedIn(FAR_FUTURE) }, async (home) => {
    await Deno.mkdir(`${home}/.slv/agent`, { recursive: true })
    await Deno.writeTextFile(
      `${home}/.slv/agent/config.yml`,
      'skills:\n  - name: slv-validator\n    agent: Cecil\n    enabled: true\n',
    )
    await Deno.mkdir(`${home}/.slv/skills/slv-validator`, { recursive: true })
    await Deno.writeTextFile(
      `${home}/.slv/skills/slv-validator/SKILL.md`,
      'SYNTHETIC_SPECIALIST_KNOWLEDGE',
    )
    invalidateAgentContext()
    resetContextModules()
    await buildSystemPrompt()
    await withFetch((_url, init) => {
      const body = JSON.parse(String(init?.body))
      assertEquals(body.output_config.effort, 'high')
      assertEquals(body.cache_control, { type: 'ephemeral' })
      assertStringIncludes(body.system, 'SYNTHETIC_SPECIALIST_KNOWLEDGE')
      return json({
        content: [{ type: 'text', text: 'Ready.' }],
        stop_reason: 'end_turn',
      })
    }, async (requests) => {
      assertEquals(
        await executeTool('delegate_to_agent', {
          agent: 'Cecil',
          task: 'Explain keyless startup',
        }),
        'Ready.',
      )
      assertEquals(requests.length, 1)
      assertFalse(getModuleContent().includes('SYNTHETIC_SPECIALIST_KNOWLEDGE'))
    })
  })
})

Deno.test('a truncated specialist response cannot write memory or execute tools', async () => {
  await withHome({ lang: 'en', slv: loggedIn(FAR_FUTURE) }, async (home) => {
    const memory = `${home}/.slv/agent/MEMORY.md`
    await Deno.mkdir(`${home}/.slv/agent`, { recursive: true })
    await Deno.writeTextFile(memory, 'Existing notes.')
    invalidateAgentContext()
    resetContextModules()
    await withFetch(
      () =>
        json({
          content: [{
            type: 'tool_use',
            id: 'truncated',
            name: 'write_file',
            input: { path: memory, content: 'MUST NOT WRITE' },
          }],
          stop_reason: 'max_tokens',
        }),
      async (requests) => {
        assertStringIncludes(
          await executeTool('delegate_to_agent', {
            agent: 'Cecil',
            task: 'Explain startup',
          }),
          'output limit',
        )
        assertEquals(requests.length, 1)
        assertEquals(await Deno.readTextFile(memory), 'Existing notes.')
      },
    )
  })
})
