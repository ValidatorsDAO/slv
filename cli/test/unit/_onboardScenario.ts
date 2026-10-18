// Runs in a child process with a temporary HOME and no network/run permission.
// Exercise the real onboard action, replacing only prompts and external I/O.
import { Checkbox, Confirm, Input, Select } from '@cliffy/prompt'
import {
  AUTH_TOKEN_URL,
  json,
  runCaptured,
  withCommandStub,
  withFetch,
} from '/test/unit/_credentialFixtures.ts'

const scenario = JSON.parse(Deno.args[0])
const prompts: string[] = []
Object.defineProperty(Deno, 'build', {
  value: { ...Deno.build, os: scenario.os ?? 'linux' },
})
for (const prompt of [Checkbox, Confirm, Input, Select]) {
  prompt.prompt = () => {
    throw new Error('Unexpected interactive prompt')
  }
}
if (scenario.interactive) {
  Object.defineProperty(Select, 'prompt', {
    value: async (options: { message: string }) => {
      prompts.push(options.message)
      if (options.message === 'Language / 言語') return scenario.lang ?? 'ja'
      throw new Error(`Unexpected selection: ${options.message}`)
    },
  })
  Object.defineProperty(Confirm, 'prompt', {
    value: async (options: { message: string }) => {
      prompts.push(options.message)
      return true
    },
  })
}

const { onboardAction } = await import('@/ai/onboard/onboardAction.ts')
let healthProbes = 0
await withCommandStub(({ command, args }) => {
  if (command === 'systemctl') {
    return { stdout: args.includes('is-active') ? 'active' : '' }
  }
  if (command === 'id') return { stdout: '1000' }
  if (command === 'launchctl') return { stdout: 'state = running' }
  if (command === 'hostname') return { success: false }
  throw new Error(`Unexpected process: ${command}`)
}, async (commands) => {
  await withFetch((url) => {
    if (url === AUTH_TOKEN_URL && scenario.refreshUnavailable) {
      return json({ error: 'temporarily_unavailable' }, 503)
    }
    if (url.endsWith('/v3/ai/usage')) {
      if (scenario.usageFailure) {
        return new Response('<html>blocked</html>', {
          status: 403,
          headers: {
            'content-type': 'text/html',
            'cf-ray': '0123456789abcdef-TEST',
          },
        })
      }
      return json({
        success: true,
        message: { remaining_tokens: scenario.remainingTokens ?? 1000 },
      })
    }
    if (url.endsWith('/v3/user/dashboard')) {
      if (scenario.activationUnavailable) {
        return json({ error: 'temporarily_unavailable' }, 503)
      }
      return json({
        success: true,
        data: scenario.activationUnknown
          ? {}
          : { isPaymentValid: scenario.paymentValid !== false },
      })
    }
    if (url.endsWith('/healthz')) {
      healthProbes++
      return json(
        { ok: true },
        healthProbes <= (scenario.delayedHealth ?? 0) ? 503 : 200,
      )
    }
    if (url === 'https://api.ipify.org') {
      return new Response(scenario.unknownIp ? '' : '192.0.2.20')
    }
    if (url.endsWith('/v3/dns/status')) {
      return json({
        default: {
          fqdn: 'example.erpc.global',
          slug: 'example',
          exists: true,
          ip: '192.0.2.10',
          proxied: true,
          updatedAt: null,
        },
        custom: [],
      })
    }
    if (url.startsWith('https://discord.com/api/webhooks/')) {
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }, async (requests) => {
    let setupResult
    const outcome = await runCaptured(async () => {
      setupResult = await onboardAction({
        configPath: scenario.interactive ? undefined : Deno.args[1],
        advanced: scenario.advanced,
      })
    })
    console.log(JSON.stringify({
      ...outcome,
      error: outcome.error instanceof Error
        ? outcome.error.message
        : outcome.error,
      commands,
      requests,
      healthProbes,
      setupResult,
      prompts,
    }))
  })
})
