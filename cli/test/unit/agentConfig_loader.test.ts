import { assert, assertEquals } from '@std/assert'

import {
  invalidateAgentContext,
  loadAgentContext,
} from '@/ai/agentConfig/loader.ts'

interface Fixture {
  configYml?: string
  apiYml?: string
  soulMd?: string
  userMd?: string
  memoryMd?: string
  skills?: Record<string, string>
}

const makeHome = async (fixture: Fixture): Promise<string> => {
  const home = await Deno.makeTempDir({ prefix: 'slv-agent-cfg-' })
  const agentDir = `${home}/.slv/agent`
  const skillsDir = `${home}/.slv/skills`
  await Deno.mkdir(agentDir, { recursive: true })
  await Deno.mkdir(skillsDir, { recursive: true })
  if (fixture.configYml !== undefined) {
    await Deno.writeTextFile(`${agentDir}/config.yml`, fixture.configYml)
  }
  if (fixture.apiYml !== undefined) {
    await Deno.writeTextFile(`${home}/.slv/api.yml`, fixture.apiYml)
  }
  if (fixture.soulMd !== undefined) {
    await Deno.writeTextFile(`${agentDir}/SOUL.md`, fixture.soulMd)
  }
  if (fixture.userMd !== undefined) {
    await Deno.writeTextFile(`${agentDir}/USER.md`, fixture.userMd)
  }
  if (fixture.memoryMd !== undefined) {
    await Deno.writeTextFile(`${agentDir}/MEMORY.md`, fixture.memoryMd)
  }
  for (const [skill, body] of Object.entries(fixture.skills ?? {})) {
    const dir = `${skillsDir}/${skill}`
    await Deno.mkdir(dir, { recursive: true })
    await Deno.writeTextFile(`${dir}/SKILL.md`, body)
  }
  return home
}

const reset = () => invalidateAgentContext()

Deno.test('loadAgentContext returns defaults when no files exist', async () => {
  reset()
  const home = await makeHome({})
  const ctx = await loadAgentContext({ home, force: true })
  assertEquals(ctx.enabledAgents, [])
  assertEquals(ctx.mode, 'remote')
  assertEquals(ctx.autoExecute, true)
  assertEquals(ctx.soul, null)
  assertEquals(ctx.user, null)
  assertEquals(ctx.memory, null)
  assertEquals(ctx.discordWebhookConfigured, false)
})

Deno.test('loadAgentContext parses production config and MD files', async () => {
  reset()
  const home = await makeHome({
    configYml: [
      'skills:',
      '  - name: slv-validator',
      '    enabled: true',
      '    agent: Cecil',
      '  - name: slv-rpc',
      '    enabled: true',
      '    agent: Tina',
      '  - name: slv-grpc-geyser',
      '    enabled: true',
      '    agent: Tina',
      '  - name: slv-benchmark',
      '    enabled: true',
      '    agent: Cid',
      'auto_execute: true',
      'mode: remote',
      '',
    ].join('\n'),
    soulMd: '- **Name:** EL\n',
    userMd: '- **Name:** K\n- **Call me:** K\n',
    memoryMd: 'Some notes\n',
    skills: {
      'slv-validator': '# validator skill',
      'slv-rpc': '# rpc skill',
      'slv-grpc-geyser': '# geyser skill',
      'slv-benchmark': '# benchmark skill',
    },
  })
  const ctx = await loadAgentContext({ home, force: true })
  assertEquals(ctx.enabledAgents, ['Cecil', 'Tina', 'Cid'])
  assertEquals(ctx.soul?.name, 'EL')
  assertEquals(ctx.user?.preferredName, 'K')
  assertEquals(ctx.memory?.raw, 'Some notes\n')
  // Warnings should be clean: all skills exist.
  assertEquals(ctx.warnings, [])
})

Deno.test('Figaro auto-enables when skill dir exists and config omits it', async () => {
  reset()
  const home = await makeHome({
    configYml: [
      'skills:',
      '  - name: slv-validator',
      '    enabled: true',
      '    agent: Cecil',
      'auto_execute: true',
      'mode: remote',
    ].join('\n'),
    skills: {
      'slv-validator': '# validator',
      'slv-server-procurement': '# figaro',
    },
  })
  const ctx = await loadAgentContext({ home, force: true })
  assert(ctx.enabledAgents.includes('Figaro'))
  assert(ctx.skillSourcesByAgent.Figaro.includes('slv-server-procurement'))
})

Deno.test('Figaro stays disabled when config explicitly sets enabled: false', async () => {
  reset()
  const home = await makeHome({
    configYml: [
      'skills:',
      '  - name: slv-server-procurement',
      '    enabled: false',
      '    agent: Figaro',
    ].join('\n'),
    skills: {
      'slv-server-procurement': '# figaro',
    },
  })
  const ctx = await loadAgentContext({ home, force: true })
  assertEquals(ctx.enabledAgents.includes('Figaro'), false)
})

Deno.test('Figaro enabled but skill missing emits a warning', async () => {
  reset()
  const home = await makeHome({
    configYml: [
      'skills:',
      '  - name: slv-server-procurement',
      '    enabled: true',
      '    agent: Figaro',
    ].join('\n'),
    // No slv-server-procurement directory created.
  })
  const ctx = await loadAgentContext({ home, force: true })
  assert(ctx.enabledAgents.includes('Figaro'))
  const hasWarning = ctx.warnings.some((w) =>
    w.source === 'skills' &&
    w.message.includes('slv-server-procurement')
  )
  assert(hasWarning, `expected skill-missing warning, got ${JSON.stringify(ctx.warnings)}`)
})

Deno.test('Broken YAML surfaces a warning and falls back to defaults', async () => {
  reset()
  const home = await makeHome({
    configYml: 'skills: [invalid yaml',
  })
  const ctx = await loadAgentContext({ home, force: true })
  assertEquals(ctx.enabledAgents, [])
  assertEquals(ctx.mode, 'remote')
  const hasWarning = ctx.warnings.some((w) => w.source === 'config.yml')
  assert(hasWarning)
})

Deno.test('Unknown agent ids in config.yml are skipped with a warning', async () => {
  reset()
  const home = await makeHome({
    configYml: [
      'skills:',
      '  - name: slv-custom',
      '    enabled: true',
      '    agent: Mystery',
      '  - name: slv-validator',
      '    enabled: true',
      '    agent: Cecil',
    ].join('\n'),
    skills: { 'slv-validator': '# v' },
  })
  const ctx = await loadAgentContext({ home, force: true })
  assertEquals(ctx.enabledAgents, ['Cecil'])
  const hasWarning = ctx.warnings.some((w) =>
    w.source === 'config.yml' && w.message.includes('Mystery')
  )
  assert(hasWarning)
})

Deno.test('Discord webhook in api.yml is surfaced as configured', async () => {
  reset()
  const home = await makeHome({
    apiYml: [
      'slv:',
      '  api_key: 00000000-0000-4000-8000-000000000000',
      'notifications:',
      '  discord_webhook: https://discord.com/api/webhooks/abc/xyz',
    ].join('\n'),
  })
  const ctx = await loadAgentContext({ home, force: true })
  assertEquals(ctx.discordWebhookConfigured, true)
})

Deno.test('loadAgentContext memoizes until invalidated', async () => {
  reset()
  const home = await makeHome({
    configYml: 'auto_execute: true\nmode: remote\n',
  })
  const first = await loadAgentContext({ home })
  const second = await loadAgentContext({ home })
  // Same reference thanks to memoization.
  assertEquals(first === second, true)

  invalidateAgentContext()
  const third = await loadAgentContext({ home })
  assertEquals(first === third, false)
})

Deno.test('Tina and Cid always register the geyser extra skill', async () => {
  reset()
  const home = await makeHome({
    configYml: [
      'skills:',
      '  - name: slv-rpc',
      '    enabled: true',
      '    agent: Tina',
      '  - name: slv-benchmark',
      '    enabled: true',
      '    agent: Cid',
    ].join('\n'),
    skills: { 'slv-rpc': '# rpc', 'slv-benchmark': '# bench' },
  })
  const ctx = await loadAgentContext({ home, force: true })
  assert(ctx.skillSourcesByAgent.Tina.includes('slv-grpc-geyser'))
  assert(ctx.skillSourcesByAgent.Cid.includes('slv-grpc-geyser'))
})
