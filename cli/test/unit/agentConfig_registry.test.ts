import { assertEquals } from '@std/assert'

import {
  AGENT_REGISTRY,
  ALL_AGENT_IDS,
  collectSkillNamesForAgent,
  isKnownAgentId,
  listAgentsByOrder,
} from '@/ai/agentConfig/registry.ts'

Deno.test('AGENT_REGISTRY covers all five specialists', () => {
  assertEquals(ALL_AGENT_IDS.sort(), ['Cecil', 'Cid', 'Figaro', 'Setzer', 'Tina'])
})

Deno.test('listAgentsByOrder returns registry-ordered metadata', () => {
  const ordered = listAgentsByOrder(['Cid', 'Cecil', 'Tina', 'Figaro'])
  assertEquals(ordered.map((m) => m.id), ['Cecil', 'Tina', 'Figaro', 'Cid'])
})

Deno.test('listAgentsByOrder silently drops unknown ids', () => {
  const ordered = listAgentsByOrder(['Nobody', 'Cecil'])
  assertEquals(ordered.map((m) => m.id), ['Cecil'])
})

Deno.test('listAgentsByOrder deduplicates repeated ids', () => {
  const ordered = listAgentsByOrder(['Tina', 'Tina', 'Tina'])
  assertEquals(ordered.length, 1)
  assertEquals(ordered[0].id, 'Tina')
})

Deno.test('isKnownAgentId narrows strings to AgentId', () => {
  assertEquals(isKnownAgentId('Cecil'), true)
  assertEquals(isKnownAgentId('Nobody'), false)
})

Deno.test('collectSkillNamesForAgent merges extraSkills into configured skills', () => {
  const skills = collectSkillNamesForAgent('Tina', ['slv-rpc'])
  // Tina registers slv-grpc-geyser as an extra skill.
  assertEquals(skills.sort(), ['slv-grpc-geyser', 'slv-rpc'])
})

Deno.test('collectSkillNamesForAgent deduplicates overlapping entries', () => {
  const skills = collectSkillNamesForAgent('Cid', ['slv-grpc-geyser'])
  assertEquals(skills, ['slv-grpc-geyser'])
})

Deno.test('Figaro registry metadata enables auto-detect via skill presence', () => {
  assertEquals(
    AGENT_REGISTRY.Figaro.autoEnableIfSkillPresent,
    'slv-server-procurement',
  )
})

Deno.test('Setzer registry metadata bundles slv-bot-trade-app as an extra skill', () => {
  // Template-specific trade-app playbook ships as a dedicated skill and is
  // always loaded alongside slv-app for the Setzer sub-agent.
  assertEquals(
    AGENT_REGISTRY.Setzer.extraSkills,
    ['slv-bot-trade-app'],
  )
})

Deno.test('collectSkillNamesForAgent(Setzer) merges slv-app + slv-bot-trade-app', () => {
  const skills = collectSkillNamesForAgent('Setzer', ['slv-app'])
  assertEquals(skills.sort(), ['slv-app', 'slv-bot-trade-app'])
})
