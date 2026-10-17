import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { SLVProvider } from '@/ai/console/providers/slv.ts'
import { classifyIntent } from '@/ai/console/intentClassifier.ts'
import {
  clearAbort,
  executeTool,
  resetSessionCaches,
} from '@/ai/console/tools.ts'
import { userApiAuthFromSession } from '/lib/userApi/auth.ts'
import { readUserApiError, UserApiHttpError } from '/lib/userApi/httpError.ts'
import {
  FAR_FUTURE,
  json,
  loggedIn,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

// Synthetic error page and trace identifiers; no production request data.
const HTML =
  `<!DOCTYPE html><html><title>Attention Required! | Cloudflare</title>
<h1>Sorry, you have been blocked</h1>
<p>Cloudflare Ray ID: <strong class="font-semibold">0123456789abcdef</strong></p>
<p>Your IP: <span>192.0.2.1</span></p></html>`
const edgeResponse = () =>
  new Response(HTML, {
    status: 403,
    headers: { 'Content-Type': 'text/html', 'cf-ray': 'fedcba9876543210-AMS' },
  })

function assertEdgeMessage(message: string) {
  assertStringIncludes(message, '403')
  assertStringIncludes(message, 'Cloudflare')
  assertStringIncludes(message, 'fedcba9876543210-AMS')
  assertStringIncludes(message, 'support')
  assertFalse(message.includes('<html>'))
  assertFalse(message.includes('192.0.2.1'))
  assertFalse(message.includes('slv login'))
  assertFalse(message.includes('purchase'))
}

Deno.test('streaming AI reports a Cloudflare block without HTML or the client IP', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    clearAbort()
    await withFetch(edgeResponse, async (requests) => {
      const provider = new SLVProvider(
        userApiAuthFromSession(home),
        'SLV AI',
        'test',
        { onStream: () => {}, onToolCall: () => {}, onComplete: () => {} },
      )
      const error = await assertRejects(() => provider.chat('hello'))
      assertEdgeMessage((error as Error).message)
      assertEquals(requests.length, 1)
    })
  })
})

Deno.test('HTTP diagnostics distinguish OAuth, token exhaustion, denied access and overload', async () => {
  const cases = [
    {
      response: json({ error: 'Unauthorized' }, 401),
      kind: 'authentication',
      text: 'slv login',
    },
    {
      response: json({ error: 'ai_token_limit_reached', plan: 'free' }, 403),
      kind: 'token_limit',
      text: 'slv ai usage',
    },
    {
      response: json({
        error: 'permission_denied',
        message: 'ai_token_limit_reached',
      }, 403),
      kind: 'http',
      text: 'denied access',
    },
    {
      response: json({ error: 'overloaded_error' }, 529),
      kind: 'http',
      text: 'overloaded',
    },
    {
      response: json({ error: 'ai_token_limit_reached', plan: 'unknown' }, 403),
      kind: 'http',
      text: 'could not check',
    },
  ]
  for (const { response, kind, text } of cases) {
    const error = await readUserApiError(response)
    assertEquals(error instanceof UserApiHttpError, true)
    assertEquals(error.kind, kind)
    assertStringIncludes(error.message, text)
    assertStringIncludes(error.message, `HTTP ${response.status}`)
    if (kind !== 'token_limit') {
      assertFalse(error.message.includes('slv ai product'))
    }
    if (kind !== 'authentication') {
      assertFalse(error.message.includes('slv login'))
    }
  }
})

Deno.test('Cloudflare diagnostic uses a bounded HTML Ray ID fallback and cancels oversized bodies', async () => {
  const error = await readUserApiError(new Response(HTML, { status: 403 }))
  assertEquals(error.kind, 'edge_block')
  assertEquals(error.rayId, '0123456789abcdef')
  assertFalse(error.message.includes('192.0.2.1'))

  let cancelled = false
  const largeBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(HTML + 'x'.repeat(64 * 1024)))
    },
    cancel() {
      cancelled = true
    },
  })
  const large = await readUserApiError(new Response(largeBody, { status: 403 }))
  assertEquals(large.kind, 'edge_block')
  assertEquals(cancelled, true)
  assertEquals(large.payload, null)
  assertFalse(large.message.includes('xxxx'))
})

Deno.test('provider credential, billing and permission errors do not ask the user to sign in or buy tokens', async () => {
  for (
    const [status, type] of [[401, 'authentication_error'], [
      402,
      'billing_error',
    ], [403, 'permission_error']] as const
  ) {
    const error = await readUserApiError(json({
      type: 'error',
      error: { type, message: 'private provider diagnostic' },
    }, status))
    assertEquals(error.kind, 'provider_configuration')
    assertStringIncludes(error.message, 'AI provider')
    assertStringIncludes(error.message, 'ERPC support')
    assertFalse(error.message.includes('slv login'))
    assertFalse(error.message.includes('slv ai product'))
    assertFalse(error.message.includes('private provider diagnostic'))
  }
  // Similar text in an unrelated error cannot change the OAuth diagnosis.
  const login = await readUserApiError(
    json({ error: 'Unauthorized', message: 'authentication_error' }, 401),
  )
  assertEquals(login.kind, 'authentication')
  assertStringIncludes(login.message, 'slv login')
})

Deno.test('account activation failures provide a next step without repeating server pricing', async () => {
  for (
    const body of [
      { error: 'payment_auth_required' },
      {
        success: false,
        message:
          'Complete the test-price card authentication before using EURC payments.',
      },
    ]
  ) {
    const error = await readUserApiError(json(body, 400))
    assertEquals(error.kind, 'activation_required')
    assertStringIncludes(error.message, 'Complete account activation')
    assertStringIncludes(error.message, 'slv ai product')
    assertFalse(error.message.includes('test-price'))
    assertFalse(error.message.includes('slv login'))
  }
  const other = await readUserApiError(
    json({ success: false, message: 'Invalid input' }, 400),
  )
  assertEquals(other.kind, 'http')
})

Deno.test('unknown HTML failure is concise and does not become a login or purchase error', async () => {
  const error = await readUserApiError(
    new Response('<html>private diagnostic</html>', {
      status: 403,
      headers: { 'cf-ray': 'invalid trace with markup' },
    }),
  )
  assertEquals(error.kind, 'http')
  assertEquals(error.rayId, null)
  assertStringIncludes(error.message, 'HTML error page')
  assertFalse(error.message.includes('private diagnostic'))
  assertFalse(error.message.includes('slv login'))
  assertFalse(error.message.includes('slv ai product'))
})

Deno.test('streaming AI does not mistake upstream overload for exhausted tokens or fetch billing', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    clearAbort()
    await withFetch(
      () => json({ error: 'overloaded_error' }, 529),
      async (requests) => {
        const provider = new SLVProvider(
          userApiAuthFromSession(home),
          'SLV AI',
          'test',
          { onStream: () => {}, onToolCall: () => {}, onComplete: () => {} },
        )
        const error = await assertRejects(
          () => provider.chat('hello'),
          UserApiHttpError,
        )
        assertEquals(error.kind, 'http')
        assertStringIncludes(error.message, 'overloaded')
        assertFalse(error.message.includes('purchase'))
        assertEquals(requests.length, 1)
      },
    )
  })
})

Deno.test('failed classifier retains its diagnostic and lets the caller stop the blocked turn', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    await withFetch(edgeResponse, async (requests) => {
      const config = {
        provider: 'slv' as const,
        model: 'SLV AI',
        slvAuth: userApiAuthFromSession(home),
      }
      const input = {
        message: '私のサブスクわかる？',
        deploymentMode: 'local' as const,
        enabledSpecialists: [],
      }
      const diagnostics: Error[] = []
      const plan = await classifyIntent({
        ...config,
        onFallback: (error) => diagnostics.push(error),
      }, input)
      assertEquals(plan.intent, 'account_billing')
      assertEquals(diagnostics.length, 1)
      assertEdgeMessage(diagnostics[0].message)
      await assertRejects(
        () =>
          classifyIntent({
            ...config,
            onFallback: (error) => {
              throw error
            },
          }, input),
        UserApiHttpError,
        'Cloudflare',
      )
      assertEquals(requests.length, 2)
    })
  })
})

Deno.test('account read tools keep proxy HTML out of model context and do not cache the failure', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async () => {
    resetSessionCaches()
    await withFetch(edgeResponse, async (requests) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await executeTool('call_mcp', {
          tool_name: 'get_user_subscription',
          arguments: {},
        })
        assertStringIncludes(result, 'Request failed (403).')
        assertEdgeMessage(result)
        assertFalse(result.includes('cache hit'))
      }
      assertEquals(requests.length, 2)
    })
  })
})

Deno.test('specialist AI reports the same Cloudflare diagnostic without retrying', async () => {
  await withHome({
    slv: loggedIn(FAR_FUTURE),
    ai: { provider: 'slv', model: 'SLV AI' },
  }, async () => {
    await withFetch(edgeResponse, async (requests) => {
      const result = await executeTool('delegate_to_agent', {
        agent: 'Cecil',
        task: 'Say hello',
      })
      assertEdgeMessage(result)
      assertEquals(requests.length, 1)
    })
  })
})

Deno.test('failed classifier still identifies Japanese subscription questions as account reads', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    await withFetch(edgeResponse, async () => {
      for (
        const message of [
          '私のサブスクわかる？',
          '現在のRPC契約を教えて',
          '請求書を確認したい',
        ]
      ) {
        const plan = await classifyIntent({
          provider: 'slv',
          model: 'SLV AI',
          slvAuth: userApiAuthFromSession(home),
        }, {
          message,
          deploymentMode: 'local',
          enabledSpecialists: ['Cecil', 'Tina', 'Cid', 'Setzer', 'Figaro'],
          currentIntent: 'rpc_ops',
          currentSpecialist: 'Tina',
        })
        assertEquals(plan.intent, 'account_billing')
        assertEquals(plan.language, 'ja')
        assertEquals(plan.toolsToEnable, ['call_mcp'])
        assertEquals(plan.userContextKindsToHydrate, ['mcp_user_account'])
        assertEquals(plan.delegateAgent, null)
        assertEquals(plan.askClarify, null)
      }
    })
  })
})

Deno.test('local account fallback does not turn subscription feature development into an account read', async () => {
  for (
    const message of [
      'サブスクリプション機能をアプリに実装して',
      'Build a billing application',
      'Implement WebSocket subscription handling',
    ]
  ) {
    const plan = await classifyIntent({
      provider: 'slv',
      model: 'SLV AI',
    }, {
      message,
      deploymentMode: 'local',
      enabledSpecialists: ['Setzer'],
      currentIntent: 'app_builder',
      currentSpecialist: 'Setzer',
    })
    assertEquals(plan.intent, 'app_builder')
    assertEquals(plan.userContextKindsToHydrate, [])
    assertEquals(plan.delegateAgent, 'Setzer')
  }
})
