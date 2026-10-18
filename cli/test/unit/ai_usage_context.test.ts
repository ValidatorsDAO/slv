import { assertEquals, assertFalse, assertStringIncludes } from '@std/assert'
import { loadAiUsageContext } from '@/ai/console/aiUsageContext.ts'
import { classifyIntent } from '@/ai/console/intentClassifier.ts'
import { userApiAuthFromAccessToken } from '/lib/userApi/auth.ts'
import { callReadTool } from '/lib/userApi/readTools.ts'
import {
  ACCESS_TOKEN,
  json,
  withFetch,
} from '/test/unit/_credentialFixtures.ts'

const auth = userApiAuthFromAccessToken(ACCESS_TOKEN)

Deno.test('account intent supplies AI entitlement even when paid contracts are empty', async () => {
  await withFetch((requestUrl, init) => {
    const url = new URL(requestUrl)
    if (url.pathname === '/v3/ai/chat') {
      return json({
        content: [{
          type: 'text',
          text: JSON.stringify({ intent: 'account_billing' }),
        }],
      })
    }
    assertEquals(init?.method, 'GET')
    assertEquals(
      new Headers(init?.headers).get('authorization'),
      `Bearer ${ACCESS_TOKEN}`,
    )
    if (url.pathname === '/v3/billing/my-subscriptions') {
      return json({ success: true, message: [] })
    }
    assertEquals(url.pathname, '/v3/ai/usage')
    assertEquals(url.searchParams.get('boost'), '1')
    return json({
      success: true,
      message: { ai_plan: 'developer', remaining_tokens: 3200 },
    })
  }, async () => {
    const plan = await classifyIntent({ model: 'SLV AI', slvAuth: auth }, {
      message: 'Show my subscriptions, AI plan and remaining tokens',
      deploymentMode: 'remote',
      enabledSpecialists: [],
    })
    assertEquals(plan.userContextKindsToHydrate, [
      'mcp_user_account',
      'mcp_ai_usage',
    ])
    const contracts = await callReadTool(auth, 'get_billing_my_subscriptions')
    assertEquals(JSON.parse(contracts).message, [])
    const context = await loadAiUsageContext(auth)
    assertStringIncludes(context, '"ai_plan":"developer"')
    assertStringIncludes(context, '"remaining_tokens":3200')
    assertStringIncludes(
      context,
      'AI entitlement and paid billing contracts are separate',
    )
  })
})

Deno.test('AI usage context refreshes later balances instead of retaining a session snapshot', async () => {
  let remaining = 3200
  await withFetch(
    () =>
      json({
        success: true,
        message: { ai_plan: 'developer', remaining_tokens: remaining },
      }),
    async (requests) => {
      assertStringIncludes(
        await loadAiUsageContext(auth),
        '"remaining_tokens":3200',
      )
      remaining = 3100
      assertStringIncludes(
        await loadAiUsageContext(auth),
        '"remaining_tokens":3100',
      )
      assertEquals(requests.length, 2)
      assertEquals(
        requests.every((r) => new URL(r.url).searchParams.get('boost') === '1'),
        true,
      )
    },
  )
})

Deno.test('unavailable or malformed AI usage never becomes an invented plan or zero balance', async () => {
  for (
    const response of [
      () => json({ success: false, message: 'temporarily unavailable' }, 503),
      () => new Response('<html>upstream diagnostic</html>', { status: 200 }),
      () => json({ success: true, message: { ai_plan: 'developer' } }),
      () =>
        json({
          success: false,
          message: { ai_plan: 'free', remaining_tokens: 0 },
        }),
    ]
  ) {
    await withFetch(response, async () => {
      const context = await loadAiUsageContext(auth)
      assertStringIncludes(
        context,
        'Current SLV AI usage could not be verified',
      )
      assertFalse(context.includes('"ai_plan"'))
      assertFalse(context.includes('"remaining_tokens"'))
      assertFalse(context.includes('<html>'))
    })
  }
})
