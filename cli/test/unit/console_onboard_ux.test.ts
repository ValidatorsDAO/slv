import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import {
  buildLocalGreeting,
  stopOnDefinitiveApiError,
} from '@/ai/console/consoleAction.ts'
import {
  clearFocusOverride,
  detectProfile,
  profilePromptBlock,
  writeFocusOverride,
} from '@/ai/console/profile.ts'
import { classifyIntent } from '@/ai/console/intentClassifier.ts'
import { invalidateAgentContext } from '@/ai/agentConfig/loader.ts'
import { writeLang } from '@/ai/config.ts'
import {
  BUILTIN_LANGS,
  getCurrentLang,
  reloadI18n,
  t,
} from '@/ai/i18n/index.ts'
import { userApiAuthFromAccessToken } from '/lib/userApi/auth.ts'
import { UserApiHttpError } from '/lib/userApi/httpError.ts'
import {
  ACCESS_TOKEN,
  FAR_FUTURE,
  json,
  loggedIn,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const quickConfig = `focus_source: request
skills:
  - name: slv-validator
    agent: Cecil
    enabled: true
  - name: slv-app
    agent: Setzer
    enabled: true
`

async function writeProfiles(home: string) {
  await Deno.mkdir(`${home}/.slv/agent`, { recursive: true })
  await Deno.writeTextFile(`${home}/.slv/agent/config.yml`, quickConfig)
  await Deno.writeTextFile(
    `${home}/.slv/agent/SOUL.md`,
    '---\nname: Custom Assistant\n---\n',
  )
  await Deno.writeTextFile(
    `${home}/.slv/agent/USER.md`,
    '---\nname: Example User\npreferred_name: Tester\n---\n',
  )
  await Deno.mkdir(`${home}/slv/example-trade-app`, { recursive: true })
  // Synthetic empty file; its presence is enough for the old app heuristic.
  await Deno.writeTextFile(`${home}/slv/example-trade-app/wallet.json`, '{}')
  invalidateAgentContext()
}

Deno.test('greeting preserves custom names and offers a useful first request without a crew roster', async () => {
  await withHome({ lang: 'en' }, async (home) => {
    await writeProfiles(home)
    await reloadI18n()
    const greeting = await buildLocalGreeting(home)
    assertStringIncludes(greeting, 'Tester')
    assertStringIncludes(greeting, 'Custom Assistant')
    assertStringIncludes(greeting, 'ERPC subscriptions')
    assertStringIncludes(greeting, 'testnet validator')
    for (
      const staleHint of [
        'crew',
        'Cecil',
        'Setzer',
        'Focused',
        'example-trade-app',
      ]
    ) {
      assertFalse(greeting.includes(staleHint))
    }
  })
})

Deno.test('greeting works before profile setup and uses SLV as the default name', async () => {
  await withHome({ lang: 'en' }, async (home) => {
    invalidateAgentContext()
    await reloadI18n()
    const greeting = await buildLocalGreeting(home)
    assertStringIncludes(greeting, "I'm SLV, your SLV assistant.")
    assertFalse(greeting.includes('undefined'))
  })
})

Deno.test('request-based focus ignores enabled skills and existing trade apps', async () => {
  await withHome(null, async (home) => {
    await writeProfiles(home)
    const profile = await detectProfile()
    assertEquals(profile.focusSource, 'request')
    assertEquals(profile.overridden, false)
    assertEquals(profile.apps, [])
    const prompt = profilePromptBlock(profile)
    assertStringIncludes(prompt, 'Follow the current user request')
    assertStringIncludes(prompt, 'subscription')
    assertFalse(prompt.includes('example-trade-app'))
    assertFalse(prompt.includes('Bias proactive suggestions toward'))
  })
})

Deno.test('manual focus wins over request mode and clearing restores request mode', async () => {
  await withHome(null, async (home) => {
    await writeProfiles(home)
    await writeFocusOverride('rpc')
    const overridden = await detectProfile()
    assertEquals(overridden.primary, 'rpc')
    assertEquals(overridden.overridden, true)
    assertStringIncludes(
      profilePromptBlock(overridden),
      'manual /focus override',
    )
    await clearFocusOverride()
    const cleared = await detectProfile()
    assertEquals(cleared.focusSource, 'request')
    assertEquals(cleared.overridden, false)
  })
})

Deno.test('legacy profiles retain their automatic routing preference', async () => {
  await withHome(null, async (home) => {
    await writeProfiles(home)
    await Deno.writeTextFile(
      `${home}/.slv/agent/config.yml`,
      quickConfig.replace('focus_source: request\n', ''),
    )
    const profile = await detectProfile()
    assertEquals(profile.primary, 'app')
    assertEquals(profile.focusSource, undefined)
    assertStringIncludes(profilePromptBlock(profile), 'example-trade-app')
  })
})

Deno.test('language changes take effect in the same process without API calls for built-in languages', async () => {
  await withHome({ lang: 'en' }, async () => {
    invalidateAgentContext()
    await withFetch(() => {
      throw new Error('Built-in languages must not make translation requests')
    }, async (requests) => {
      for (const lang of ['ja', 'zh', 'ru', 'vi', 'en']) {
        await writeLang(lang)
        await reloadI18n()
        assertEquals(getCurrentLang(), lang)
        const key = "I'm {agent}, your SLV assistant."
        assertEquals(t(key), BUILTIN_LANGS[lang][key])
        if (lang !== 'en') assertFalse(t(key) === key)
      }
      assertEquals(requests.length, 0)
    })
  })
})

Deno.test('language reload waits for an older translation so it cannot overwrite the new language', async () => {
  await withHome(
    { lang: 'example-test-language', slv: loggedIn(FAR_FUTURE) },
    async () => {
      invalidateAgentContext()
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<Response>()
      await withFetch(() => {
        started.resolve()
        return response.promise
      }, async () => {
        const previousInit = reloadI18n()
        await started.promise
        await writeLang('ja')
        const latestInit = reloadI18n()
        response.resolve(json({
          content: [{
            type: 'text',
            text: JSON.stringify({ 'Hey there! 👋': 'Old translation' }),
          }],
        }))
        await Promise.all([previousInit, latestInit])
        assertEquals(getCurrentLang(), 'ja')
        assertEquals(t('Hey there! 👋'), BUILTIN_LANGS.ja['Hey there! 👋'])
      })
    },
  )
})

Deno.test('console classifier stops after definitive edge, login, provider, activation or token rejection', async () => {
  const responses = [
    () =>
      new Response('<html>Cloudflare: blocked</html>', {
        status: 403,
        headers: {
          'Content-Type': 'text/html',
          'cf-ray': '0123456789abcdef-AMS',
        },
      }),
    () => json({ error: 'Unauthorized' }, 401),
    () => json({ type: 'error', error: { type: 'authentication_error' } }, 401),
    () => json({ type: 'error', error: { type: 'billing_error' } }, 402),
    () => json({ type: 'error', error: { type: 'permission_error' } }, 403),
    () =>
      json({
        success: false,
        message:
          'Complete the example-price card authentication before continuing.',
      }, 400),
    () => json({ error: 'ai_token_limit_reached', plan: 'free' }, 403),
  ]
  for (const response of responses) {
    await withFetch(response, async (requests) => {
      await assertRejects(() =>
        classifyIntent({
          provider: 'slv',
          apiKey: '',
          model: 'SLV AI',
          slvAuth: userApiAuthFromAccessToken(ACCESS_TOKEN),
          onFallback: stopOnDefinitiveApiError,
        }, {
          message: '私のサブスクわかる？',
          deploymentMode: 'remote',
          enabledSpecialists: [],
        }), UserApiHttpError)
      assertEquals(requests.length, 1)
    })
  }
})

Deno.test('console allows local intent fallback after a temporary classifier failure', async () => {
  await withFetch(
    () => json({ error: 'overloaded' }, 503),
    async (requests) => {
      const plan = await classifyIntent({
        provider: 'slv',
        apiKey: '',
        model: 'SLV AI',
        slvAuth: userApiAuthFromAccessToken(ACCESS_TOKEN),
        onFallback: stopOnDefinitiveApiError,
      }, {
        message: 'Show my ERPC subscriptions',
        deploymentMode: 'remote',
        enabledSpecialists: [],
      })
      assertEquals(plan.intent, 'account_billing')
      assertEquals(requests.length, 1)
    },
  )
})
