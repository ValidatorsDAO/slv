import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { parse, stringify } from '@std/yaml'
import { loadOnboardConfig } from '@/ai/onboard/config.ts'
import {
  AUTH_TOKEN_URL,
  EXPIRED,
  FAR_FUTURE,
  loggedIn,
} from '/test/unit/_credentialFixtures.ts'

const answers = {
  lang: 'en',
  security_warning_accepted: true,
  user_name: 'Operator',
  call_me_name: 'Operator',
  agent_name: 'SLV Agent',
  deploy_mode: 'remote',
  discord_webhook: '',
  sudoers_install: false,
  enable_https: false,
  enable_lan_mode: false,
}

const runOnboard = async (
  overrides: Record<string, unknown>,
  scenario: Record<string, unknown>,
  check: (home: string, result: {
    error?: string
    output: string
    healthProbes: number
    requests: { url: string; body: string | null }[]
    commands: { command: string }[]
    prompts: string[]
    setupResult: { ready: boolean; cancelled?: boolean }
  }) => Promise<void>,
) => {
  const taskHome = await Deno.makeTempDir({ prefix: 'slv-onboard-test-' })
  try {
    await Deno.mkdir(`${taskHome}/.slv/agent`, { recursive: true })
    await Deno.mkdir(`${taskHome}/.slv/gateway`, { recursive: true })
    await Deno.writeTextFile(
      `${taskHome}/.slv/api.yml`,
      stringify({
        ...(scenario.signedIn ? { slv: loggedIn(FAR_FUTURE) } : {}),
        ...(scenario.apiExtra as Record<string, unknown> ?? {}),
      }),
    )
    if (scenario.memory) {
      await Deno.writeTextFile(
        `${taskHome}/.slv/agent/MEMORY.md`,
        String(scenario.memory),
      )
    }
    if (scenario.userProfile) {
      await Deno.writeTextFile(
        `${taskHome}/.slv/agent/USER.md`,
        String(scenario.userProfile),
      )
    }
    if (scenario.agentProfile) {
      await Deno.writeTextFile(
        `${taskHome}/.slv/agent/SOUL.md`,
        String(scenario.agentProfile),
      )
    }
    if (scenario.agentConfig) {
      await Deno.writeTextFile(
        `${taskHome}/.slv/agent/config.yml`,
        stringify(scenario.agentConfig),
      )
    }
    await Deno.writeTextFile(
      `${taskHome}/.slv/gateway/gateway.json`,
      JSON.stringify({
        port: 23456,
        mode: 'local',
        token: 'test-only-'.repeat(8),
      }),
    )
    // Model an installed service without touching the host service manager.
    await Deno.mkdir(`${taskHome}/Library/LaunchAgents`, { recursive: true })
    await Deno.writeTextFile(
      `${taskHome}/Library/LaunchAgents/global.slv.gateway.plist`,
      '',
    )
    await Deno.mkdir(`${taskHome}/.config/systemd/user`, { recursive: true })
    await Deno.writeTextFile(
      `${taskHome}/.config/systemd/user/slv-gateway.service`,
      '',
    )
    const configPath = `${taskHome}/answers.yml`
    await Deno.writeTextFile(
      configPath,
      stringify(
        Object.fromEntries(
          Object.entries({ ...(scenario.minimal ? {} : answers), ...overrides })
            .filter(([, value]) => value !== undefined),
        ),
      ),
    )
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--frozen',
        '--allow-read',
        `--allow-write=${taskHome}`,
        '--allow-env',
        new URL('./_onboardScenario.ts', import.meta.url).pathname,
        JSON.stringify(scenario),
        configPath,
      ],
      env: {
        HOME: taskHome,
        SUDO_USER: '',
        XDG_CONFIG_HOME: `${taskHome}/.config`,
        SLV_GATEWAY_PORT: '',
        NO_COLOR: '1',
      },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
    await check(taskHome, JSON.parse(new TextDecoder().decode(result.stdout)))
  } finally {
    await Deno.remove(taskHome, { recursive: true })
  }
}

Deno.test('onboard config rejects wrong field types and unknown operations before setup', async () => {
  const path = await Deno.makeTempFile()
  try {
    for (
      const invalid of [
        { sudoers_install: 'false' },
        { enable_https: 'false' },
        { enable_lan_mode: 'false' },
        { security_warning_accepted: 'true' },
        { user_name: 42 },
        { user_name: ' ' },
        { lang: [] },
        { selected_ops: 'Solana Validator Operations' },
        { selected_ops: ['typo'] },
        { deploy_mode: 'typo' },
        { slv_api_key: 123 },
      ]
    ) {
      await Deno.writeTextFile(path, stringify(invalid))
      await assertRejects(
        () => loadOnboardConfig(path),
        Error,
        'onboard config',
      )
    }
    await Deno.writeTextFile(path, 'future_field: true\nenable_https: false\n')
    assertEquals((await loadOnboardConfig(path)).enable_https, false)
  } finally {
    await Deno.remove(path)
  }
})

Deno.test('onboard completes a Japanese config in one run without login or prompts', async () => {
  await runOnboard({ lang: 'ja' }, {}, async (home, result) => {
    assertEquals(result.error, undefined)
    const api = parse(
      await Deno.readTextFile(`${home}/.slv/api.yml`),
    ) as Record<string, unknown>
    assertEquals(api.lang, 'ja')
    assertEquals(api.ai, { provider: 'slv', model: 'SLV AI' })
    assertStringIncludes(
      await Deno.readTextFile(`${home}/.slv/agent/USER.md`),
      'Operator',
    )
    assertEquals(result.requests.some((r) => r.url.includes('oauth/')), false)
  })
})

Deno.test('onboard respects an explicit security decline without prompting or setup', async () => {
  await runOnboard(
    { security_warning_accepted: false },
    {},
    async (home, result) => {
      assertEquals(result.error, undefined)
      await assertRejects(
        () => Deno.stat(`${home}/.slv/agent/USER.md`),
        Deno.errors.NotFound,
      )
      assertEquals(result.requests, [])
    },
  )
})

Deno.test('onboard reruns preserve memory and do not call DNS when HTTPS is disabled', async () => {
  const memory = '# MEMORY.md\nKeep these operator notes.\n'
  await runOnboard({}, { memory, signedIn: true }, async (home, result) => {
    assertEquals(result.error, undefined)
    assertEquals(
      await Deno.readTextFile(`${home}/.slv/agent/MEMORY.md`),
      memory,
    )
    assertEquals(result.requests.some((r) => r.url.includes('/v3/dns/')), false)
  })
})

Deno.test('onboard config leaves a conflicting DNS record alone without prompting', async () => {
  await runOnboard(
    { enable_https: true },
    { signedIn: true },
    async (_, result) => {
      assertEquals(result.error, undefined)
      assertEquals(
        result.requests.filter((r) => r.url.endsWith('/v3/dns/status')).length,
        1,
      )
      assertEquals(
        result.requests.some((r) => r.url.endsWith('/v3/dns/set')),
        false,
      )
    },
  )
})

Deno.test('onboard does not retry IP detection past the DNS conflict guard', async () => {
  await runOnboard(
    { enable_https: true },
    { signedIn: true, unknownIp: true },
    async (_, result) => {
      assertEquals(result.error, undefined)
      assertEquals(
        result.requests.filter((r) => r.url.endsWith('/v3/dns/status')).length,
        1,
      )
      assertEquals(
        result.requests.filter((r) => r.url === 'https://api.ipify.org').length,
        1,
      )
    },
  )
})

Deno.test('onboard waits for the gateway and notifies using its configured port', async () => {
  await runOnboard(
    {
      discord_webhook: 'https://discord.com/api/webhooks/test-only',
      install_gateway: true,
    },
    { os: 'darwin', delayedHealth: 2 },
    async (_, result) => {
      assertEquals(result.error, undefined)
      assertEquals(result.healthProbes >= 3, true)
      assertStringIncludes(result.output, 'http://127.0.0.1:23456/ui/')
      const messages = result.requests.filter((r) =>
        r.url.includes('discord.com')
      )
      assertEquals(messages.length, 2)
      assertStringIncludes(messages[0].body!, 'http://127.0.0.1:23456/ui/')
      assertStringIncludes(messages[1].body!, '23456:127.0.0.1:23456')
      assertStringIncludes(messages[1].body!, 'slv c')
      assertFalse(
        messages.some((message) =>
          message.body?.includes('test-only-test-only-')
        ),
      )
    },
  )
})

Deno.test('onboard does not send a completion link when the gateway never becomes healthy', async () => {
  await runOnboard(
    {
      discord_webhook: 'https://discord.com/api/webhooks/test-only',
      install_gateway: true,
    },
    { delayedHealth: 1000000 },
    async (_, result) => {
      assertEquals(result.error, undefined)
      assertEquals(
        result.requests.some((r) => r.url.includes('discord.com')),
        false,
      )
      assertEquals(result.output.includes('Gateway running at'), false)
      assertStringIncludes(result.output, "isn't responding on port 23456")
    },
  )
})

Deno.test('quick onboard enables every specialist without personal or server setup prompts', async () => {
  await runOnboard({ lang: 'en', security_warning_accepted: true }, {
    minimal: true,
    signedIn: true,
  }, async (home, result) => {
    assertEquals(result.error, undefined)
    assertEquals(result.setupResult.ready, true)
    assertEquals(result.commands, [])
    assertEquals(result.prompts, [])
    assertEquals(result.requests.map((r) => r.url), [
      'https://user-api.erpc.global/v3/ai/usage',
      'https://user-api.erpc.global/v3/user/dashboard',
    ])
    const config = parse(
      await Deno.readTextFile(`${home}/.slv/agent/config.yml`),
    ) as {
      skills: { name: string; enabled: boolean; agent: string }[]
      auto_execute: boolean
      mode: string
      focus_source: string
    }
    assertEquals(config.skills.length, 6)
    assertEquals(config.skills.every((skill) => skill.enabled), true)
    assertEquals(
      [...new Set(config.skills.map((skill) => skill.agent))].sort(),
      ['Cecil', 'Cid', 'Figaro', 'Setzer', 'Tina'],
    )
    assertEquals(config.auto_execute, false)
    assertEquals(config.mode, 'remote')
    assertEquals(config.focus_source, 'request')
  })
})

Deno.test('interactive Japanese onboard continues in the same invocation and only asks language and confirmation', async () => {
  await runOnboard(
    {},
    { interactive: true, signedIn: true },
    async (home, result) => {
      assertEquals(result.error, undefined)
      assertEquals(result.setupResult.ready, true)
      assertEquals(result.prompts.length, 2)
      assertEquals(result.prompts[0], 'Language / 言語')
      assertFalse(result.output.includes('もう一度 `slv onboard`'))
      assertEquals(result.commands, [])
      await Deno.stat(`${home}/.slv/agent/config.yml`)
    },
  )
})

Deno.test('quick reruns retain customized profiles, custom skills, mode and notification settings', async () => {
  const userProfile =
    '---\nname: Operator\npreferred_name: Keeper\n---\nCustom user notes.\n'
  const agentProfile =
    '# Custom assistant\n- **Name:** Helper\nDo not delete these instructions.\n'
  await runOnboard({ lang: 'en', security_warning_accepted: true }, {
    minimal: true,
    signedIn: true,
    userProfile,
    agentProfile,
    agentConfig: {
      mode: 'local',
      custom_option: 'kept',
      skills: [{ name: 'custom-skill', agent: 'Cecil', enabled: true }],
    },
    apiExtra: {
      notifications: {
        discord_webhook: 'https://discord.com/api/webhooks/test-only',
        custom_setting: 'kept',
      },
    },
  }, async (home, result) => {
    assertEquals(result.error, undefined)
    assertEquals(
      await Deno.readTextFile(`${home}/.slv/agent/USER.md`),
      userProfile,
    )
    assertEquals(
      await Deno.readTextFile(`${home}/.slv/agent/SOUL.md`),
      agentProfile,
    )
    const config = parse(
      await Deno.readTextFile(`${home}/.slv/agent/config.yml`),
    ) as Record<string, unknown>
    assertEquals(config.mode, 'local')
    assertEquals(config.custom_option, 'kept')
    assertEquals(
      (config.skills as { name: string }[]).some((skill) =>
        skill.name === 'custom-skill'
      ),
      true,
    )
    const api = parse(
      await Deno.readTextFile(`${home}/.slv/api.yml`),
    ) as Record<string, unknown>
    assertEquals(api.notifications, {
      discord_webhook: 'https://discord.com/api/webhooks/test-only',
      custom_setting: 'kept',
    })
    assertEquals(result.commands, [])
    assertEquals(result.requests.length, 2)
  })
})

Deno.test('quick onboard saves settings but does not claim chat readiness when balance is empty or unavailable', async () => {
  for (const scenario of [{ remainingTokens: 0 }, { usageFailure: true }]) {
    await runOnboard(
      {},
      { signedIn: true, ...scenario },
      async (home, result) => {
        assertEquals(result.error, undefined)
        assertEquals(result.setupResult.ready, false)
        assertFalse(result.output.includes('Ready to chat'))
        assertFalse(result.output.includes('<html>'))
        await Deno.stat(`${home}/.slv/agent/config.yml`)
        assertEquals(result.requests.length, 1)
      },
    )
  }
})

Deno.test('onboard keeps an explicitly configured alternative AI provider', async () => {
  const ai = {
    provider: 'openai',
    api_key: 'test-only-provider-key',
    model: 'test-model',
  }
  await runOnboard({}, { apiExtra: { ai } }, async (home, result) => {
    assertEquals(result.error, undefined)
    assertEquals(result.setupResult.ready, true)
    const api = parse(
      await Deno.readTextFile(`${home}/.slv/api.yml`),
    ) as Record<string, unknown>
    assertEquals(api.ai, ai)
    assertEquals(result.requests, [])
  })
})

Deno.test('onboard requires account activation even when the AI token balance is positive', async () => {
  await runOnboard(
    {},
    { signedIn: true, paymentValid: false },
    async (home, result) => {
      assertEquals(result.error, undefined)
      assertEquals(result.setupResult.ready, false)
      assertFalse(result.output.includes('Ready to chat'))
      assertStringIncludes(result.output, 'Complete account activation')
      assertStringIncludes(result.output, 'https://dashboard.erpc.global')
      assertEquals(result.requests.map((request) => request.url), [
        'https://user-api.erpc.global/v3/ai/usage',
        'https://user-api.erpc.global/v3/user/dashboard',
      ])
      await Deno.stat(`${home}/.slv/agent/config.yml`)
    },
  )
})

Deno.test('onboard does not claim chat readiness when account activation cannot be verified', async () => {
  for (
    const scenario of [{ activationUnavailable: true }, {
      activationUnknown: true,
    }]
  ) {
    await runOnboard(
      {},
      { signedIn: true, ...scenario },
      async (home, result) => {
        assertEquals(result.error, undefined)
        assertEquals(result.setupResult.ready, false)
        assertFalse(result.output.includes('Ready to chat'))
        assertStringIncludes(
          result.output,
          'Could not verify ERPC account activation',
        )
        assertEquals(result.requests.map((request) => request.url), [
          'https://user-api.erpc.global/v3/ai/usage',
          'https://user-api.erpc.global/v3/user/dashboard',
        ])
        await Deno.stat(`${home}/.slv/agent/config.yml`)
      },
    )
  }
})

Deno.test('interactive onboard preserves a saved session and reports refresh outages without starting another login', async () => {
  const session = loggedIn(EXPIRED)
  await runOnboard({}, {
    interactive: true,
    refreshUnavailable: true,
    agentConfig: { onboard_version: 2 },
    apiExtra: {
      lang: 'en',
      slv: session,
      ai: { provider: 'slv', model: 'SLV AI' },
    },
  }, async (home, result) => {
    assertEquals(result.error, undefined)
    assertEquals(result.setupResult.ready, false)
    assertEquals(result.prompts, [])
    assertEquals(result.commands, [])
    assertEquals(result.requests.map((request) => request.url), [
      AUTH_TOKEN_URL,
    ])
    assertStringIncludes(result.output, 'Could not refresh the ERPC login')
    assertStringIncludes(result.output, 'HTTP 503')
    assertFalse(result.output.includes('Sign in to ERPC now?'))
    assertFalse(result.output.includes('Ready to chat'))
    const api = parse(await Deno.readTextFile(`${home}/.slv/api.yml`)) as {
      slv: unknown
    }
    assertEquals(api.slv, session)
    await Deno.stat(`${home}/.slv/agent/config.yml`)
  })
})
