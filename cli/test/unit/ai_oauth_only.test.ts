import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import { parse } from '@std/yaml'
import {
  type AiConfig,
  DEFAULT_AI_CONFIG,
  readAiConfig,
  writeAiConfig,
} from '@/ai/config.ts'
import { AiConfigSchema } from '@/ai/agentConfig/schema.ts'
import { consoleAction } from '@/ai/console/consoleAction.ts'
import { classifyIntent } from '@/ai/console/intentClassifier.ts'
import { executeTool, resetSessionCaches } from '@/ai/console/tools.ts'
import { aiCmd } from '@/ai/index.ts'
import { authCmd } from '@/auth/index.ts'
import {
  defaultProviderBuilder,
  type ProviderConfig,
} from '@/ai/core/drivers/provider.ts'
import { dispatchRequest, newConnState } from '@/gateway/ws/router.ts'
import { resolveUserApiAuth } from '/lib/getApiKeyFromYml.ts'
import {
  ACCESS_TOKEN,
  API_KEY,
  FAR_FUTURE,
  json,
  loggedIn,
  runCaptured,
  withCommandStub,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const PERSONAL_KEY = 'synthetic-personal-provider-key-never-send'
const legacy = (provider: string) => ({
  provider,
  api_key: PERSONAL_KEY,
  model: 'legacy-provider-model',
})
const CHAT_URL = 'https://user-api.erpc.global/v3/ai/chat'
const streamResponse = () =>
  new Response(
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )

Deno.test('AI schema discards legacy credentials without reading their value', () => {
  for (const provider of ['anthropic', 'openai', 'slv']) {
    const input = {
      provider,
      model: 'old-model',
      get api_key(): never {
        throw new Error('A provider key must not be read')
      },
    }
    const config = AiConfigSchema.parse(input)
    assertEquals(config, { ...DEFAULT_AI_CONFIG, migration_required: true })
    assertFalse(Object.hasOwn(config, 'api_key'))
  }
})

Deno.test('legacy AI migration removes only the AI credential and preserves OAuth, profiles and unrelated settings', async () => {
  for (const provider of ['anthropic', 'openai', 'slv']) {
    const slv = { ...loggedIn(FAR_FUTURE), api_key: API_KEY }
    const notifications = { custom: 'keep' }
    await withHome(
      { ai: legacy(provider), slv, notifications, lang: 'en' },
      async (home) => {
        await Deno.mkdir(`${home}/.slv/agent`, { recursive: true })
        for (const file of ['USER.md', 'SOUL.md', 'MEMORY.md']) {
          await Deno.writeTextFile(
            `${home}/.slv/agent/${file}`,
            `Custom ${file}\n`,
          )
        }
        await withFetch(() => {
          throw new Error('Migration must not contact any service')
        }, async (requests) => {
          assertEquals(await readAiConfig(), {
            ...DEFAULT_AI_CONFIG,
            migratedFromLegacy: true,
          })
          assertEquals(await readAiConfig(), DEFAULT_AI_CONFIG)
          assertEquals(requests, [])
        })
        const saved = parse(
          await Deno.readTextFile(`${home}/.slv/api.yml`),
        ) as Record<string, unknown>
        assertEquals(saved.ai, DEFAULT_AI_CONFIG)
        assertEquals(saved.slv, slv)
        assertEquals(saved.notifications, notifications)
        assertEquals(saved.lang, 'en')
        assertFalse(JSON.stringify(saved).includes(PERSONAL_KEY))
        for (const file of ['USER.md', 'SOUL.md', 'MEMORY.md']) {
          assertEquals(
            await Deno.readTextFile(`${home}/.slv/agent/${file}`),
            `Custom ${file}\n`,
          )
        }
      },
    )
  }
})

Deno.test('AI config writer cannot persist a personal key or reactivate a legacy provider', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    await writeAiConfig(legacy('openai') as unknown as AiConfig)
    const saved = parse(
      await Deno.readTextFile(`${home}/.slv/api.yml`),
    ) as Record<string, unknown>
    assertEquals(saved.ai, DEFAULT_AI_CONFIG)
    assertEquals(saved.slv, loggedIn(FAR_FUTURE))
  })
})

Deno.test('legacy providers cannot bypass OAuth in slv ai, ai console or gateway-backed console startup', async () => {
  for (const provider of ['anthropic', 'openai']) {
    for (
      const start of [
        () => consoleAction(),
        () => consoleAction({ viaGateway: true }),
        () => aiCmd.parse([]),
        () => aiCmd.parse(['console']),
      ]
    ) {
      await withHome({ ai: legacy(provider), lang: 'en' }, async () => {
        await withCommandStub(() => {
          throw new Error('No dependency or gateway processes before OAuth')
        }, async (commands) => {
          await withFetch(() => {
            throw new Error('No API call without OAuth')
          }, async (requests) => {
            const result = await runCaptured(start)
            assertEquals(result.error, undefined)
            assertEquals(result.exit, 1)
            assertStringIncludes(result.output, 'ERPC OAuth only')
            assertStringIncludes(result.output, 'slv login')
            assertFalse(result.output.includes(PERSONAL_KEY))
            assertEquals(requests, [])
            assertEquals(commands, [])
          })
        })
      })
    }
  }
})

Deno.test('legacy providers cannot bypass OAuth in browser chat or specialist delegation', async () => {
  for (const provider of ['anthropic', 'openai']) {
    await withHome({ ai: legacy(provider), lang: 'en' }, async () => {
      resetSessionCaches()
      await withFetch(() => {
        throw new Error('No API call without OAuth')
      }, async (requests) => {
        const state = newConnState()
        state.authenticated = true
        const response = await dispatchRequest(
          {
            kind: 'req',
            id: '1',
            method: 'session.send',
            params: { text: 'hello' },
          },
          state,
          { token: 'synthetic-gateway-token', emitEvent: () => {} },
        )
        assertEquals(response.ok, false)
        assertStringIncludes(response.error ?? '', 'OAuth')
        assertStringIncludes(response.error ?? '', 'slv login')
        const delegated = await executeTool('delegate_to_agent', {
          agent: 'Cecil',
          task: 'Say hello',
        })
        assertStringIncludes(delegated, 'slv login')
        assertFalse(delegated.includes(PERSONAL_KEY))
        assertEquals(requests, [])
      })
    })
  }
})

Deno.test('authenticated legacy users use only SLV OAuth for browser chat, classifier and specialists', async () => {
  for (const provider of ['anthropic', 'openai']) {
    await withHome({
      ai: legacy(provider),
      slv: loggedIn(FAR_FUTURE),
      lang: 'en',
    }, async () => {
      await withFetch((url, init) => {
        assertEquals(url, CHAT_URL)
        const body = JSON.parse(String(init?.body))
        assertEquals(body.model, 'slv-ai-default')
        if (body.stream) return streamResponse()
        return json({
          content: [{
            type: 'text',
            text: body.max_tokens === 1024
              ? '{"intent":"account_billing"}'
              : 'Hello',
          }],
          stop_reason: 'end_turn',
        })
      }, async (requests) => {
        const finished = Promise.withResolvers<void>()
        const errors: string[] = []
        const state = newConnState()
        state.authenticated = true
        const response = await dispatchRequest(
          {
            kind: 'req',
            id: '1',
            method: 'session.send',
            params: { text: 'hello' },
          },
          state,
          {
            token: crypto.randomUUID(),
            emitEvent: (event) => {
              if (event.type === 'error') errors.push(event.message)
              if (
                ['complete', 'error', 'aborted'].includes(event.type)
              ) finished.resolve()
            },
          },
        )
        assertEquals(response.ok, true)
        await finished.promise
        assertEquals(errors, [])
        const config = await readAiConfig()
        const login = await resolveUserApiAuth()
        assertEquals(login.ok, true)
        if (!login.ok || !config) {
          throw new Error('Synthetic login was not available')
        }
        const plan = await classifyIntent({
          model: config.model,
          slvAuth: login.auth,
        }, {
          message: 'My subscriptions',
          deploymentMode: 'remote',
          enabledSpecialists: [],
        })
        assertEquals(plan.intent, 'account_billing')
        assertEquals(
          await executeTool('delegate_to_agent', {
            agent: 'Cecil',
            task: 'Say hello',
          }),
          'Hello',
        )
        assertEquals(requests.length, 3)
        for (const request of requests) {
          assertEquals(request.url, CHAT_URL)
          assertEquals(request.authorization, `Bearer ${ACCESS_TOKEN}`)
          assertFalse(JSON.stringify(request).includes(PERSONAL_KEY))
          assertFalse(JSON.stringify(request).includes('legacy-provider-model'))
        }
      })
    })
  }
})

Deno.test('provider factory refuses a legacy provider even from an untyped caller', () => {
  for (const kind of ['openai', 'anthropic']) {
    assertThrows(
      () =>
        defaultProviderBuilder(
          {
            kind,
            apiKey: PERSONAL_KEY,
            model: 'old',
            systemPrompt: 'test',
          } as unknown as ProviderConfig,
        )({ onStream: () => {}, onToolCall: () => {}, onComplete: () => {} }),
      Error,
      'ERPC OAuth',
    )
  }
})

Deno.test('removed auth flags are rejected without displaying, saving or validating the supplied key', async () => {
  for (const flag of ['--openai', '--anthropic']) {
    for (const args of [[flag, PERSONAL_KEY], [`${flag}=${PERSONAL_KEY}`]]) {
      await withHome(null, async (home) => {
        await withFetch(() => {
          throw new Error('No provider-key validation is allowed')
        }, async (requests) => {
          const result = await runCaptured(() =>
            authCmd.throwErrors().parse(args)
          )
          assertStringIncludes(String(result.error), flag)
          assertFalse(String(result.error).includes(PERSONAL_KEY))
          assertFalse(result.output.includes(PERSONAL_KEY))
          assertEquals(requests, [])
          await assertRejects(
            () => Deno.stat(`${home}/.slv/api.yml`),
            Deno.errors.NotFound,
          )
        })
      })
    }
  }
})
