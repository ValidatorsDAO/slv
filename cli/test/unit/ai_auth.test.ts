import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { consoleAction } from '@/ai/console/consoleAction.ts'
import { SLVProvider } from '@/ai/console/providers/slv.ts'
import { classifyIntent } from '@/ai/console/intentClassifier.ts'
import {
  clearAbort,
  executeTool,
  resetSessionCaches,
  setTuiInstance,
} from '@/ai/console/tools.ts'
import { getAuthorizationStatus } from '@/ai/authorization.ts'
import { aiUsageAction } from '@/ai/usage/usageAction.ts'
import { aiProductAction } from '@/ai/product/productAction.ts'
import { loginAction } from '@/login/index.ts'
import { userApiAuthFromSession } from '/lib/userApi/auth.ts'
import { saveSlvCredentials } from '/lib/userApi/session.ts'
import { dispatchRequest, newConnState } from '@/gateway/ws/router.ts'
import {
  ACCESS_TOKEN,
  API_KEY,
  AUTH_TOKEN_URL,
  EXPIRED,
  FAR_FUTURE,
  json,
  loggedIn,
  NEW_ACCESS_TOKEN,
  NEW_REFRESH_TOKEN,
  REFRESH_TOKEN,
  runCaptured,
  withCommandStub,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const CHAT_URL = 'https://user-api.erpc.global/v3/ai/chat'
const aiConfig = { provider: 'slv', api_key: API_KEY, model: 'SLV AI' }
const textResponse = () =>
  json({
    content: [{ type: 'text', text: 'Hello from SLV' }],
    stop_reason: 'end_turn',
  })
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
        delta: { type: 'text_delta', text: 'Hello from SLV' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )

Deno.test('AI console refuses a legacy RPC key before dependency checks or UI startup', async () => {
  await withHome(
    { slv: { api_key: API_KEY }, ai: aiConfig, lang: 'en' },
    async () => {
      await withCommandStub(() => ({ success: true }), async (commands) => {
        await withFetch(() => {
          throw new Error('no API request without OAuth')
        }, async (requests) => {
          try {
            for (const viaGateway of [false, true]) {
              const outcome = await runCaptured(() =>
                consoleAction({ viaGateway })
              )
              assertEquals(outcome.error, undefined)
              assertEquals(outcome.exit, 1)
              assertStringIncludes(outcome.output, 'OAuth')
              assertStringIncludes(outcome.output, 'slv login')
            }
            assertEquals(commands, [])
            assertEquals(requests, [])
          } finally {
            setTuiInstance(null)
          }
        })
      })
    },
  )
})

Deno.test('AI console reports a refresh outage before installing dependencies', async () => {
  await withHome(
    { slv: loggedIn(EXPIRED), ai: aiConfig, lang: 'en' },
    async () => {
      await withCommandStub(() => ({ success: true }), async (commands) => {
        await withFetch(() => {
          throw new TypeError('connection reset')
        }, async (requests) => {
          try {
            const outcome = await runCaptured(() => consoleAction())
            assertEquals(outcome.error, undefined)
            assertEquals(outcome.exit, 1)
            assertStringIncludes(outcome.output, 'Could not refresh')
            assertStringIncludes(outcome.output, 'connection reset')
            assertEquals(commands, [])
            assertEquals(requests.map((r) => r.url), [AUTH_TOKEN_URL])
          } finally {
            setTuiInstance(null)
          }
        })
      })
    },
  )
})

Deno.test('browser AI distinguishes an expired OAuth login from a refresh outage', async () => {
  for (const failure of ['expired', 'offline']) {
    await withHome({ slv: loggedIn(EXPIRED), ai: aiConfig }, async () => {
      await withFetch(
        () =>
          failure === 'expired'
            ? json({ error: 'invalid_grant' }, 400)
            : json({ error: 'unavailable' }, 503),
        async (requests) => {
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
            { token: 'test-token', emitEvent: () => {} },
          )
          assertEquals(response.ok, false)
          assertStringIncludes(
            response.error ?? '',
            failure === 'expired' ? 'expired' : 'Could not refresh',
          )
          assertEquals(requests.map((r) => r.url), [AUTH_TOKEN_URL])
        },
      )
    })
  }
})

Deno.test('AI usage and product commands return a failing exit code and login guidance on 401', async () => {
  for (const action of [aiUsageAction, aiProductAction]) {
    await withHome({ slv: loggedIn(FAR_FUTURE) }, async () => {
      await withFetch(() => json({ error: 'Unauthorized' }, 401), async () => {
        const outcome = await runCaptured(action)
        assertEquals(outcome.error, undefined)
        assertEquals(outcome.exit, 1)
        assertStringIncludes(outcome.output, 'slv login')
      })
    })
  }
})

Deno.test('AI usage does not turn an unsuccessful response into a zero balance', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async () => {
    await withFetch(
      () => json({ success: false, message: 'Unavailable' }),
      async () => {
        const outcome = await runCaptured(aiUsageAction)
        assertEquals(outcome.exit, 1)
        assertFalse(outcome.output.includes('Remaining'))
      },
    )
  })
})

Deno.test('AI usage and products never send a saved RPC key when OAuth is absent', async () => {
  await withHome({ slv: { api_key: API_KEY }, ai: aiConfig }, async () => {
    await withFetch(() => {
      throw new Error('OAuth is required')
    }, async (requests) => {
      for (const action of [aiUsageAction, aiProductAction]) {
        const outcome = await runCaptured(action)
        assertEquals(outcome.exit, 1)
        assertStringIncludes(outcome.output, 'slv login')
      }
      assertEquals(requests, [])
    })
  })
})

Deno.test('AI account tools and sub-agents explain a rejected OAuth token', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE), ai: aiConfig }, async () => {
    resetSessionCaches()
    await withFetch(
      () => json({ error: 'Unauthorized' }, 401),
      async (requests) => {
        const account = await executeTool('call_mcp', {
          tool_name: 'get_ai_usage',
          arguments: {},
        })
        assertStringIncludes(account, 'slv login')
        const delegated = await executeTool('delegate_to_agent', {
          agent: 'Cecil',
          task: 'Say hello',
        })
        assertStringIncludes(delegated, 'slv login')
        assertEquals(requests.length, 2)
        for (const request of requests) {
          assertEquals(request.authorization, `Bearer ${ACCESS_TOKEN}`)
        }
      },
    )
  })
})

Deno.test('service activation is separate from an OAuth login or a customer id', () => {
  assertEquals(
    getAuthorizationStatus({
      data: { customerId: 'test-customer', isPaymentValid: false },
    }).state,
    'unauthorized',
  )
  assertEquals(
    getAuthorizationStatus({ data: { isPaymentValid: true } }).state,
    'authorized',
  )
  assertEquals(getAuthorizationStatus({ success: true }).state, 'unknown')
})

Deno.test('cached AI account reads require a current OAuth login and change after re-login', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    resetSessionCaches()
    let account = 'first-account'
    const read = () =>
      executeTool('call_mcp', { tool_name: 'get_user_get', arguments: {} })
    await withFetch(
      () => json({ success: true, data: { username: account } }),
      async (requests) => {
        assertStringIncludes(await read(), 'first-account')
        assertStringIncludes(await read(), 'session cache hit')
        assertEquals(requests.length, 1)
        // A login can change in another terminal between two AI tool calls.
        account = 'second-account'
        await saveSlvCredentials(home, {
          access_token: NEW_ACCESS_TOKEN,
          refresh_token: NEW_REFRESH_TOKEN,
          access_token_expires_at: FAR_FUTURE,
        })
        const second = await read()
        assertStringIncludes(second, 'second-account')
        assertFalse(second.includes('first-account'))
        assertEquals(requests.length, 2)
        assertEquals(requests[1].authorization, `Bearer ${NEW_ACCESS_TOKEN}`)
        await saveSlvCredentials(home, {
          access_token: null,
          refresh_token: null,
        })
        const loggedOut = await read()
        assertStringIncludes(loggedOut, 'slv login')
        assertFalse(loggedOut.includes('second-account'))
        assertEquals(requests.length, 2)
      },
    )
  })
})

Deno.test('a rejected fresh AI account read invalidates the previous cached answer', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async () => {
    resetSessionCaches()
    let rejected = false
    const read = (refresh = false) =>
      executeTool('call_mcp', {
        tool_name: 'get_user_get',
        arguments: {},
        refresh,
      })
    await withFetch(
      () =>
        rejected
          ? json({ error: 'Unauthorized' }, 401)
          : json({ data: { username: 'old-account' } }),
      async (requests) => {
        assertStringIncludes(await read(), 'old-account')
        rejected = true
        assertStringIncludes(await read(true), 'slv login')
        assertStringIncludes(await read(), 'slv login')
        assertEquals(requests.length, 3)
      },
    )
  })
})

Deno.test('streaming AI returns actionable login guidance when user-api rejects the access token', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    clearAbort()
    await withFetch(
      () => json({ error: 'Unauthorized' }, 401),
      async (requests) => {
        const provider = new SLVProvider(
          userApiAuthFromSession(home),
          'SLV AI',
          'test',
          { onStream: () => {}, onToolCall: () => {}, onComplete: () => {} },
        )
        await assertRejects(() => provider.chat('hello'), Error, 'slv login')
        assertEquals(requests.length, 1)
        assertEquals(requests[0].authorization, `Bearer ${ACCESS_TOKEN}`)
      },
    )
  })
})

Deno.test('OAuth login feeds chat, refreshed chat, usage, products, classifier and sub-agents without sending the RPC key', async () => {
  await withHome(
    { slv: { api_key: API_KEY }, ai: aiConfig, lang: 'en' },
    async (home) => {
      let tokenCalls = 0
      const streamed: string[] = []
      clearAbort()
      resetSessionCaches()
      await withFetch((url, init) => {
        if (url.endsWith('/oauth/device/authorization')) {
          return json({
            device_code: 'test-device',
            user_code: 'TEST-CODE',
            verification_uri: 'https://auth-api.erpc.global/oauth/device',
            expires_in: 900,
            interval: 5,
          })
        }
        if (url === AUTH_TOKEN_URL) {
          tokenCalls++
          return json({
            access_token: tokenCalls === 1 ? ACCESS_TOKEN : NEW_ACCESS_TOKEN,
            refresh_token: tokenCalls === 1 ? REFRESH_TOKEN : NEW_REFRESH_TOKEN,
            expires_in: 3600,
          })
        }
        if (url.endsWith('/v3/user/get')) {
          return json({ success: true, data: { username: 'test-operator' } })
        }
        if (url === CHAT_URL) {
          const body = JSON.parse(String(init?.body))
          if (body.stream) {
            return streamResponse()
          }
          if (body.max_tokens === 250) {
            return json({
              content: [{
                type: 'text',
                text:
                  '{"intent":"general_chat","confidence":1,"language":"en"}',
              }],
            })
          }
          return textResponse()
        }
        if (url.endsWith('/v3/ai/usage')) {
          return json({
            success: true,
            message: {
              ai_plan: 'test',
              max_tokens: 1000,
              consumed_tokens: 100,
              remaining_tokens: 900,
            },
          })
        }
        if (url.endsWith('/v3/ai/product-list')) {
          return json({ success: true, message: [] })
        }
        if (url.endsWith('/v3/user/dashboard')) {
          return json({ success: true, data: { isPaymentValid: true } })
        }
        throw new Error(`unexpected request: ${url}`)
      }, async (requests) => {
        const login = await runCaptured(() =>
          loginAction({ sleep: async () => {}, openBrowser: () => {} })
        )
        assertEquals(login.error, undefined)
        assertEquals(login.exit, null)
        const auth = userApiAuthFromSession(home)
        const provider = new SLVProvider(auth, 'SLV AI', 'test', {
          onStream: (s) => streamed.push(s),
          onToolCall: () => {},
          onComplete: () => {},
        })
        await provider.chat('hello')
        await saveSlvCredentials(home, { access_token_expires_at: EXPIRED })
        await provider.chat('again')
        assertEquals(streamed, ['Hello from SLV', 'Hello from SLV'])
        for (const action of [aiUsageAction, aiProductAction]) {
          const outcome = await runCaptured(action)
          assertEquals(outcome.error, undefined)
          assertEquals(outcome.exit, null)
        }
        await classifyIntent({
          provider: 'slv',
          apiKey: API_KEY,
          model: 'SLV AI',
          slvAuth: auth,
        }, {
          message: 'hello',
          deploymentMode: 'remote',
          enabledSpecialists: [],
        })
        assertEquals(
          await executeTool('delegate_to_agent', {
            agent: 'Cecil',
            task: 'Say hello',
          }),
          'Hello from SLV',
        )
        const state = newConnState()
        state.authenticated = true
        let finish: () => void = () => {}
        const finished = new Promise<void>((resolve) => {
          finish = resolve
        })
        const events: string[] = []
        const accepted = await dispatchRequest(
          {
            kind: 'req',
            id: 'chat',
            method: 'session.send',
            params: { text: 'hello in browser' },
          },
          state,
          {
            token: crypto.randomUUID(),
            emitEvent: (event) => {
              events.push(event.type)
              if (event.type === 'complete' || event.type === 'error') finish()
            },
          },
        )
        assertEquals(accepted.ok, true)
        await finished
        assertEquals(events.includes('complete'), true)
        assertEquals(events.includes('error'), false)
        const userRequests = requests.filter((r) =>
          r.url.startsWith('https://user-api.erpc.global/')
        )
        assertEquals(userRequests[0].authorization, `Bearer ${ACCESS_TOKEN}`)
        const chats = userRequests.filter((r) => r.url === CHAT_URL)
        assertEquals(chats.length, 5)
        assertEquals(chats[0].authorization, `Bearer ${ACCESS_TOKEN}`)
        for (const request of userRequests.slice(2)) {
          assertEquals(request.authorization, `Bearer ${NEW_ACCESS_TOKEN}`)
        }
        for (const request of userRequests) {
          assertFalse(
            `${request.authorization} ${request.body ?? ''} ${request.url}`
              .includes(API_KEY),
          )
        }
        assertEquals(tokenCalls, 2)
      })
    },
  )
})
