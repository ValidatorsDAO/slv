import { assert, assertEquals } from '@std/assert'

import {
  AgentConfigSchema,
  ApiConfigSchema,
  SkillEntrySchema,
} from '@/ai/agentConfig/schema.ts'

Deno.test('AgentConfigSchema applies defaults for an empty object', () => {
  const parsed = AgentConfigSchema.parse({})
  assertEquals(parsed.skills, [])
  assertEquals(parsed.auto_execute, true)
  assertEquals(parsed.mode, 'remote')
  assertEquals(parsed.notifications, undefined)
})

Deno.test('AgentConfigSchema accepts the current production shape', () => {
  const parsed = AgentConfigSchema.parse({
    skills: [
      { name: 'slv-validator', enabled: true, agent: 'Cecil' },
      { name: 'slv-rpc', enabled: true, agent: 'Tina' },
      { name: 'slv-grpc-geyser', enabled: false, agent: 'Tina' },
    ],
    auto_execute: false,
    mode: 'local',
  })
  assertEquals(parsed.skills.length, 3)
  assertEquals(parsed.auto_execute, false)
  assertEquals(parsed.mode, 'local')
})

Deno.test('AgentConfigSchema preserves unknown keys via passthrough', () => {
  const parsed = AgentConfigSchema.parse({
    skills: [],
    auto_execute: true,
    mode: 'remote',
    future_field: 'future_value',
  }) as unknown as Record<string, unknown>
  assertEquals(parsed.future_field, 'future_value')
})

Deno.test('SkillEntrySchema defaults enabled to true when omitted', () => {
  const parsed = SkillEntrySchema.parse({ name: 'slv-app', agent: 'Setzer' })
  assertEquals(parsed.enabled, true)
})

Deno.test('ApiConfigSchema defaults slv.api_key to null', () => {
  const parsed = ApiConfigSchema.parse({})
  assertEquals(parsed.slv.api_key, null)
  assertEquals(parsed.ai, undefined)
})

Deno.test('ApiConfigSchema parses an AI config block', () => {
  const parsed = ApiConfigSchema.parse({
    slv: { api_key: '00000000-0000-4000-8000-000000000000' },
    ai: {
      provider: 'anthropic',
      api_key: 'sk-ant-xxx',
      model: 'claude-opus-4-6',
    },
    lang: 'en',
  })
  assert(parsed.ai)
  assertEquals(parsed.ai.provider, 'anthropic')
  assertEquals(parsed.ai.model, 'claude-opus-4-6')
  assertEquals(parsed.lang, 'en')
})

Deno.test('AgentConfigSchema rejects invalid mode via safeParse', () => {
  const result = AgentConfigSchema.safeParse({ mode: 'hybrid' })
  assertEquals(result.success, false)
})
