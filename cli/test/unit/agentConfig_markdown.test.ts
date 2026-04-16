import { assertEquals } from '@std/assert'

import {
  parseAgentProfile,
  parseUserProfile,
} from '@/ai/agentConfig/markdown.ts'

Deno.test('parseAgentProfile strips markdown emphasis from bullet lists', () => {
  const raw = [
    '# SOUL.md — Main Agent',
    '- **Name:** EL',
    '- **Role:** Commander — routes tasks to specialists',
    '',
  ].join('\n')
  const parsed = parseAgentProfile(raw)
  // Previous buggy regex returned "** EL" — the new parser must return "EL".
  assertEquals(parsed.name, 'EL')
  assertEquals(parsed.role, 'Commander — routes tasks to specialists')
})

Deno.test('parseUserProfile accepts "Call me:" phrasing', () => {
  const raw = [
    '# USER.md',
    '- **Name:** K',
    '- **Call me:** K',
    '',
  ].join('\n')
  const parsed = parseUserProfile(raw)
  assertEquals(parsed.name, 'K')
  // Previous regex only matched "preferred_name:" and returned empty string
  // for the real production format shown above.
  assertEquals(parsed.preferredName, 'K')
})

Deno.test('parseUserProfile still accepts legacy preferred_name key', () => {
  const raw = 'preferred_name: bob\n'
  const parsed = parseUserProfile(raw)
  assertEquals(parsed.preferredName, 'bob')
})

Deno.test('parseAgentProfile handles YAML frontmatter', () => {
  const raw = [
    '---',
    'name: EL',
    'role: Commander',
    '---',
    '',
    '# Rest is free-form markdown.',
    '',
  ].join('\n')
  const parsed = parseAgentProfile(raw)
  assertEquals(parsed.name, 'EL')
  assertEquals(parsed.role, 'Commander')
})

Deno.test('parseUserProfile handles frontmatter with call_me', () => {
  const raw = [
    '---',
    'name: Kenji',
    'call_me: K',
    '---',
    '',
  ].join('\n')
  const parsed = parseUserProfile(raw)
  assertEquals(parsed.name, 'Kenji')
  assertEquals(parsed.preferredName, 'K')
})

Deno.test('parseAgentProfile returns empty fields for empty input', () => {
  const parsed = parseAgentProfile('')
  assertEquals(parsed.name, undefined)
  assertEquals(parsed.role, undefined)
  assertEquals(parsed.raw, '')
})

Deno.test('parseAgentProfile preserves raw content', () => {
  const raw = '- **Name:** EL\n'
  const parsed = parseAgentProfile(raw)
  assertEquals(parsed.raw, raw)
})
