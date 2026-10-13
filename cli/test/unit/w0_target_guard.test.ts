import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import {
  ALL_HOSTS_ENV,
  decideAllHostsAction,
  defaultGuardDeps,
  enforceAllHostsGuard,
  type GuardDeps,
  type InventoryHost,
  isTargetedLimit,
  isWholeGroupLimit,
  listLimitedHosts,
  parseInventoryHosts,
  parseListHostsOutput,
  READ_ONLY_PLAYBOOKS,
  type ResolveLimitRequest,
} from '/lib/targetGuard.ts'
import { runAnsibleCapture } from '/lib/runAnsible.ts'

const MUTATING =
  '/home/u/.slv/template/x/ansible/mainnet-validator/restart_node.yml'
const READ_ONLY = '/home/u/.slv/template/x/ansible/cmn/doublezero_status.yml'

const decide = (
  overrides: Partial<Parameters<typeof decideAllHostsAction>[0]> = {},
) =>
  decideAllHostsAction({
    playbook: MUTATING,
    inventoryType: 'mainnet_validators',
    limit: undefined,
    knownHosts: ['val-a', 'val-b'],
    isTty: false,
    allowAllHosts: false,
    confirmed: false,
    ...overrides,
  })

const HOSTS: InventoryHost[] = [
  host('val-a', '203.0.113.10'),
  host('val-b', '203.0.113.11'),
]

function host(name: string, ansibleHost: string): InventoryHost {
  return {
    name,
    ansibleHost,
    identityAccount: '',
    voteAccount: '',
    ansibleConnection: '',
  }
}

type Recorder = {
  deps: GuardDeps
  info: string[]
  errors: string[]
  confirms: { message: string; default: boolean }[]
  exitCodes: number[]
  readCalls: string[]
  resolveCalls: ResolveLimitRequest[]
}

const recorder = (
  options: {
    isTty?: boolean
    env?: Record<string, string>
    answer?: boolean
    hosts?: InventoryHost[]
    readFails?: boolean
    /** What resolving a limit that is not a plain host list returns. */
    matches?: string[]
    resolveFails?: string
  } = {},
): Recorder => {
  const rec: Recorder = {
    info: [],
    errors: [],
    confirms: [],
    exitCodes: [],
    readCalls: [],
    resolveCalls: [],
    deps: undefined as unknown as GuardDeps,
  }
  rec.deps = {
    isTty: () => options.isTty ?? false,
    getEnv: (name) => options.env?.[name],
    readHosts: (inventoryType) => {
      rec.readCalls.push(inventoryType)
      if (options.readFails) return Promise.reject(new Error('no inventory'))
      return Promise.resolve(options.hosts ?? HOSTS)
    },
    resolveLimit: (request) => {
      rec.resolveCalls.push(request)
      if (options.resolveFails) {
        return Promise.reject(new Error(options.resolveFails))
      }
      return Promise.resolve(options.matches ?? [])
    },
    confirm: (opts) => {
      rec.confirms.push({ message: opts.message, default: opts.default })
      return Promise.resolve(options.answer ?? false)
    },
    info: (line) => rec.info.push(line),
    error: (line) => rec.errors.push(line),
    setExitCode: (code) => rec.exitCodes.push(code),
  }
  return rec
}

Deno.test('a playbook limited to named hosts runs without asking, with or without a terminal', () => {
  for (const isTty of [true, false]) {
    assertEquals(decide({ limit: 'val-a', isTty }), {
      action: 'run',
      reason: 'limited',
    })
    assertEquals(decide({ limit: 'val-a,val-b', isTty }), {
      action: 'run',
      reason: 'limited',
    })
  }
})

Deno.test('a mutating playbook with no limit is refused without a terminal', () => {
  for (
    const limit of [
      undefined,
      '',
      '   ',
      'all',
      'ALL',
      '*',
      'mainnet_validators',
    ]
  ) {
    assertEquals(
      decide({ limit }),
      { action: 'refuse', reason: 'non-interactive' },
      `limit=${JSON.stringify(limit)}`,
    )
  }
})

Deno.test('the override variable lets a non-interactive run reach every host', () => {
  assertEquals(ALL_HOSTS_ENV, 'SLV_ALLOW_ALL_HOSTS')
  assertEquals(decide({ allowAllHosts: true }), {
    action: 'run',
    reason: 'env-override',
  })
  assertEquals(decide({ allowAllHosts: false }).action, 'refuse')
})

Deno.test('on a terminal the user is asked, whatever the environment says', () => {
  assertEquals(decide({ isTty: true }), { action: 'confirm' })
  assertEquals(decide({ isTty: true, allowAllHosts: true }), {
    action: 'confirm',
  })
})

Deno.test('a read-only playbook runs against every host without a prompt', () => {
  assertEquals(Array.from(READ_ONLY_PLAYBOOKS), ['doublezero_status.yml'])
  for (const isTty of [true, false]) {
    assertEquals(decide({ playbook: READ_ONLY, isTty }), {
      action: 'run',
      reason: 'read-only',
    })
  }
  assertEquals(decide({ playbook: 'doublezero_status.yml' }).action, 'run')
})

Deno.test('lookalike playbook names are not on the read-only list', () => {
  for (
    const name of [
      'doublezero_status.yml.bak',
      'doublezero_status.yaml',
      'my_doublezero_status.yml',
      'doublezero_start.yml',
      'doublezero_stop.yml',
    ]
  ) {
    assertEquals(
      decide({ playbook: `/x/ansible/cmn/${name}` }).action,
      'refuse',
      name,
    )
  }
})

Deno.test('a caller that already confirmed every host is not asked a second time', () => {
  assertEquals(decide({ confirmed: true }), {
    action: 'run',
    reason: 'confirmed',
  })
  assertEquals(decide({ confirmed: true, isTty: true }), {
    action: 'run',
    reason: 'confirmed',
  })
})

Deno.test('isWholeGroupLimit recognises a missing, blank, all, wildcard or group-name limit', () => {
  for (
    const limit of [undefined, '', ' ', 'all', 'All', '*', 'mainnet_validators']
  ) {
    assert(isWholeGroupLimit(limit, 'mainnet_validators'), String(limit))
  }
  for (
    const limit of [
      'val-a',
      'val-a,val-b',
      'testnet_validators',
      'a*',
      'all:!x',
    ]
  ) {
    assert(!isWholeGroupLimit(limit, 'mainnet_validators'), limit)
  }
})

const KNOWN = ['val-a', 'val-b', 'val.c-1_x']

Deno.test('a limit counts as targeted only when it is a comma-separated list of plain names that exist in the inventory', () => {
  for (
    const limit of [
      'val-a',
      'val-b',
      'val-a,val-b',
      ' val-a , val-b ',
      'val-a,val-a',
      'val.c-1_x',
    ]
  ) {
    assert(isTargetedLimit(limit, KNOWN), `targeted: ${JSON.stringify(limit)}`)
  }
  for (
    const limit of [
      // ansible host patterns
      'a*',
      'val-*',
      'val-?',
      'all:!x',
      '~regex',
      '~val-.*',
      'grp[0:2]',
      'val-[ab]',
      'a:&b',
      'val-a:val-b',
      '!val-a',
      '&val-a',
      '@retry_file',
      'val-a val-b',
      // the whole group, however it is spelled
      'all',
      'ALL',
      '*',
      '',
      '   ',
      undefined,
      'mainnet_validators',
      // names the inventory does not have, or an empty element
      'typo',
      'val-a,typo',
      'val-a,',
      ',val-a',
      'val-a,,val-b',
      ',',
    ]
  ) {
    assert(
      !isTargetedLimit(limit, KNOWN),
      `not targeted: ${JSON.stringify(limit)}`,
    )
  }
  // A pattern character wins even when the inventory has a host with that exact name.
  assert(!isTargetedLimit('a*', ['a*']))
  assert(!isTargetedLimit('val-a', []))
})

Deno.test('a host pattern is decided like an unlimited run: refused without a terminal, asked on one', () => {
  for (
    const limit of [
      'a*',
      'all:!x',
      '~regex',
      'grp[0:2]',
      'a:&b',
      'val-?',
      'val-a,typo',
      'typo',
    ]
  ) {
    assertEquals(
      decide({ limit }),
      { action: 'refuse', reason: 'non-interactive' },
      limit,
    )
    assertEquals(decide({ limit, isTty: true }), { action: 'confirm' }, limit)
    assertEquals(
      decide({ limit, allowAllHosts: true }),
      { action: 'run', reason: 'env-override' },
      limit,
    )
  }
  assertEquals(decide({ limit: 'val-a,val-b' }), {
    action: 'run',
    reason: 'limited',
  })
})

Deno.test('a read-only playbook is not held up by a pattern', () => {
  assertEquals(decide({ limit: 'val-*', playbook: READ_ONLY }), {
    action: 'run',
    reason: 'read-only',
  })
})

Deno.test('a caller that confirmed the whole group has not confirmed a pattern or an unknown name', () => {
  for (const limit of [undefined, '', 'all', '*', 'mainnet_validators']) {
    assertEquals(
      decide({ limit, confirmed: true }),
      { action: 'run', reason: 'confirmed' },
      String(limit),
    )
  }
  for (const limit of ['val-*', 'all:!x', '~regex', 'typo', 'val-a,typo']) {
    assertEquals(
      decide({ limit, confirmed: true }),
      { action: 'refuse', reason: 'non-interactive' },
      limit,
    )
    assertEquals(
      decide({ limit, confirmed: true, isTty: true }),
      { action: 'confirm' },
      limit,
    )
  }
})

Deno.test('parseInventoryHosts reads host names, addresses and accounts from an inventory', () => {
  const yaml = `
mainnet_validators:
  hosts:
    val-a:
      ansible_host: 203.0.113.10
      identity_account: IdA
      vote_account: VoteA
    val-b:
      ansible_host: val-b.example.net
      ansible_connection: local
`
  assertEquals(parseInventoryHosts(yaml, 'mainnet_validators'), [
    {
      name: 'val-a',
      ansibleHost: '203.0.113.10',
      identityAccount: 'IdA',
      voteAccount: 'VoteA',
      ansibleConnection: '',
    },
    {
      name: 'val-b',
      ansibleHost: 'val-b.example.net',
      identityAccount: '',
      voteAccount: '',
      ansibleConnection: 'local',
    },
  ])
  assertEquals(parseInventoryHosts(yaml, 'testnet_validators'), [])
})

Deno.test('the guard asks on a terminal with the default set to no, after listing every host', async () => {
  const declined = recorder({ isTty: true, answer: false })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: undefined,
    },
    declined.deps,
  )
  assertEquals(verdict, { proceed: false, reason: 'declined' })
  assertEquals(declined.confirms.length, 1)
  assertEquals(declined.confirms[0].default, false)
  const listing = declined.info.join('\n')
  assertStringIncludes(listing, 'val-a')
  assertStringIncludes(listing, '203.0.113.10')
  assertStringIncludes(listing, 'val-b')
  assertStringIncludes(listing, '203.0.113.11')
  assertEquals(declined.exitCodes, [])

  const accepted = recorder({ isTty: true, answer: true })
  assertEquals(
    await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit: undefined,
      },
      accepted.deps,
    ),
    { proceed: true },
  )
})

Deno.test('the guard refuses without a terminal, sets a failing exit code and names the override', async () => {
  const rec = recorder({ isTty: false })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: undefined,
    },
    rec.deps,
  )
  assertEquals(verdict, { proceed: false, reason: 'non-interactive' })
  assertEquals(rec.confirms, [])
  assertEquals(rec.exitCodes, [1])
  assertStringIncludes(rec.errors.join('\n'), 'SLV_ALLOW_ALL_HOSTS=1')
})

Deno.test('the guard lets a non-interactive run through when SLV_ALLOW_ALL_HOSTS is 1, and lists the hosts', async () => {
  const rec = recorder({ isTty: false, env: { SLV_ALLOW_ALL_HOSTS: '1' } })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: undefined,
    },
    rec.deps,
  )
  assertEquals(verdict, { proceed: true })
  assertEquals(rec.confirms, [])
  assertStringIncludes(rec.info.join('\n'), 'val-b')

  const notOne = recorder({
    isTty: false,
    env: { SLV_ALLOW_ALL_HOSTS: 'true' },
  })
  assertEquals(
    (await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit: undefined,
      },
      notOne.deps,
    )).proceed,
    false,
  )
})

Deno.test({
  name:
    'the guard treats an environment it is not permitted to read as not set',
  permissions: { env: false },
  fn: async () => {
    // Control: the permission really is denied inside this test.
    assertThrows(() => Deno.env.get(ALL_HOSTS_ENV))
    const rec = recorder({ isTty: false })
    const verdict = await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit: undefined,
      },
      { ...rec.deps, getEnv: defaultGuardDeps().getEnv },
    )
    assertEquals(verdict, { proceed: false, reason: 'non-interactive' })
  },
})

Deno.test('the guard does not run when the host list cannot be read or is empty', async () => {
  for (
    const rec of [
      recorder({ isTty: true, answer: true, readFails: true }),
      recorder({ isTty: true, answer: true, hosts: [] }),
    ]
  ) {
    const verdict = await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit: undefined,
      },
      rec.deps,
    )
    assertEquals(verdict, { proceed: false, reason: 'unresolved' })
    assertEquals(rec.confirms, [])
    assertEquals(rec.exitCodes, [1])
  }
})

Deno.test('the guard checks named hosts against the inventory and runs them without asking or resolving', async () => {
  for (const limit of ['val-a', 'val-a,val-b', ' val-b , val-a ']) {
    const rec = recorder({ isTty: false })
    const verdict = await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit,
      },
      rec.deps,
    )
    assertEquals(verdict, { proceed: true }, limit)
    assertEquals(rec.readCalls, ['mainnet_validators'])
    assertEquals(rec.resolveCalls, [])
    assertEquals(rec.confirms, [])
    assertEquals(rec.info, [])
    assertEquals(rec.exitCodes, [])
  }
})

const PATTERN_EXAMPLES = ['a*', 'all:!x', '~regex', 'grp[0:2]', 'a:&b']

Deno.test('the guard refuses a host pattern without a terminal, resolves nothing and names the override', async () => {
  for (const limit of PATTERN_EXAMPLES) {
    const rec = recorder({ isTty: false, matches: ['val-a'] })
    const verdict = await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit,
      },
      rec.deps,
    )
    assertEquals(verdict, { proceed: false, reason: 'non-interactive' }, limit)
    assertEquals(rec.resolveCalls, [])
    assertEquals(rec.confirms, [])
    assertEquals(rec.exitCodes, [1])
    const errors = rec.errors.join('\n')
    assertStringIncludes(errors, JSON.stringify(limit))
    assertStringIncludes(errors, 'SLV_ALLOW_ALL_HOSTS=1')
  }
})

Deno.test('on a terminal a host pattern is resolved, the matching hosts are listed and the answer defaults to no', async () => {
  const declined = recorder({
    isTty: true,
    answer: false,
    matches: ['val-b', 'localhost'],
  })
  const request = {
    playbook: MUTATING,
    inventoryType: 'mainnet_validators' as const,
    limit: 'val-*',
    extraVars: { first_activation: true },
  }
  assertEquals(await enforceAllHostsGuard(request, declined.deps), {
    proceed: false,
    reason: 'declined',
  })
  assertEquals(declined.resolveCalls, [request])
  assertEquals(declined.confirms.length, 1)
  assertEquals(declined.confirms[0].default, false)
  const listing = declined.info.join('\n')
  assertStringIncludes(listing, 'val-b')
  assertStringIncludes(listing, '203.0.113.11')
  assertStringIncludes(listing, 'localhost')
  assertEquals(listing.includes('val-a'), false)
  assertEquals(declined.exitCodes, [])

  const accepted = recorder({ isTty: true, answer: true, matches: ['val-b'] })
  assertEquals(await enforceAllHostsGuard(request, accepted.deps), {
    proceed: true,
  })
})

Deno.test('a pattern is listed and asked about even when the caller confirmed the whole group', async () => {
  const rec = recorder({ isTty: true, answer: false, matches: ['val-a'] })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'val-*',
      allHostsConfirmed: true,
    },
    rec.deps,
  )
  assertEquals(verdict, { proceed: false, reason: 'declined' })
  assertEquals(rec.resolveCalls.length, 1)
  assertEquals(rec.confirms.length, 1)
})

Deno.test('with SLV_ALLOW_ALL_HOSTS=1 a host pattern is resolved and listed, then run without a prompt', async () => {
  const rec = recorder({
    isTty: false,
    env: { SLV_ALLOW_ALL_HOSTS: '1' },
    matches: ['val-a', 'val-b'],
  })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'all:!x',
    },
    rec.deps,
  )
  assertEquals(verdict, { proceed: true })
  assertEquals(rec.resolveCalls.length, 1)
  assertEquals(rec.confirms, [])
  assertStringIncludes(rec.info.join('\n'), 'val-a')
})

Deno.test('a limit whose hosts cannot be resolved does not run', async () => {
  const cases = [
    recorder({ isTty: true, answer: true, matches: [] }),
    recorder({ isTty: true, answer: true, resolveFails: 'ansible is missing' }),
    recorder({
      isTty: false,
      env: { SLV_ALLOW_ALL_HOSTS: '1' },
      resolveFails: 'ansible is missing',
    }),
  ]
  for (const rec of cases) {
    const verdict = await enforceAllHostsGuard(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit: 'val-*',
      },
      rec.deps,
    )
    assertEquals(verdict, { proceed: false, reason: 'unresolved' })
    assertEquals(rec.confirms, [])
    assertEquals(rec.exitCodes, [1])
  }
  const reason = cases[1].errors.join('\n')
  assertStringIncludes(reason, 'ansible is missing')
})

Deno.test('a name the inventory does not have goes through the pattern path and is named in the output', async () => {
  const asked = recorder({ isTty: true, answer: false, matches: ['val-a'] })
  await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'val-a,typo',
    },
    asked.deps,
  )
  assertEquals(asked.resolveCalls.length, 1)
  assertEquals(asked.confirms.length, 1)
  assertStringIncludes(asked.info.join('\n'), 'not in mainnet_validators: typo')

  const refused = recorder({ isTty: false })
  await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'typo',
    },
    refused.deps,
  )
  assertStringIncludes(
    refused.errors.join('\n'),
    'typo is not in mainnet_validators',
  )
  assertEquals(refused.resolveCalls, [])
})

Deno.test('when the inventory cannot be read a named host is not taken to exist', async () => {
  const rec = recorder({ isTty: false, readFails: true })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'val-a',
    },
    rec.deps,
  )
  assertEquals(verdict, { proceed: false, reason: 'non-interactive' })
  assertStringIncludes(rec.errors.join('\n'), 'cannot be read')
  assertEquals(rec.exitCodes, [1])
})

Deno.test('parseListHostsOutput reads the hosts under every "hosts (N):" heading', () => {
  const output = [
    '',
    'playbook: /x/restart_node.yml',
    '',
    '  play #1 (all): Restart the node\tTAGS: []',
    "    pattern: ['all']",
    '    hosts (2):',
    '      val-a',
    '      val-b',
    '',
    '  play #2 (all): Check\tTAGS: []',
    "    pattern: ['all']",
    '    hosts (2):',
    '      val-b',
    '      val-c',
    '',
    '  play #3 (localhost): Local\tTAGS: []',
    "    pattern: ['localhost']",
    '    hosts (0):',
    '',
  ].join('\n')
  assertEquals(parseListHostsOutput(output), ['val-a', 'val-b', 'val-c'])
  assertEquals(parseListHostsOutput(''), [])
  assertEquals(
    parseListHostsOutput(
      "  play #1 (all): x\n    pattern: ['x']\n    hosts (0):\n",
    ),
    [],
  )
})

Deno.test('listLimitedHosts asks ansible to list the hosts of the limit without running the play', async () => {
  const seen: string[][] = []
  const hosts = await listLimitedHosts(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'val-*',
      extraVars: { first_activation: true },
    },
    (args) => {
      seen.push(args)
      return Promise.resolve({
        success: true,
        code: 0,
        stdout:
          "  play #1 (all): x\n    pattern: ['all']\n    hosts (1):\n      val-b\n",
        stderr: '',
      })
    },
  )
  assertEquals(hosts, ['val-b'])
  assertEquals(seen.length, 1)
  const args = seen[0]
  assertEquals(args[0], '-i')
  assertEquals(args[2], MUTATING)
  assertEquals(args[args.indexOf('--limit') + 1], 'val-*')
  assert(args.includes('--list-hosts'))
  assertEquals(
    args[args.indexOf('--extra-vars') + 1],
    '{"first_activation":true}',
  )

  await listLimitedHosts(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'val-*',
    },
    (args) => {
      assertEquals(args.includes('--extra-vars'), false)
      return Promise.resolve({ success: true, code: 0, stdout: '', stderr: '' })
    },
  )
})

Deno.test('listLimitedHosts fails with the first line of what ansible said', async () => {
  let message = ''
  try {
    await listLimitedHosts(
      {
        playbook: MUTATING,
        inventoryType: 'mainnet_validators',
        limit: 'val-*',
      },
      () =>
        Promise.resolve({
          success: false,
          code: 1,
          stdout: '',
          stderr:
            '\nERROR! Specified inventory leaves us without hosts\nmore\n',
        }),
    )
  } catch (error) {
    message = (error as Error).message
  }
  assertStringIncludes(message, 'Specified inventory leaves us without hosts')
})

// --- the guard as wired into the ansible runner ---------------------------

type Spawned = { args: string[] }

const spawnStub = () => {
  const calls: Spawned[] = []
  const spawn = (args: string[]) => {
    calls.push({ args })
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: new TextEncoder().encode('ok'),
      stderr: new Uint8Array(),
    })
  }
  return { calls, spawn }
}

Deno.test('runAnsibleCapture does not start ansible for an unlimited mutating run without a terminal', async () => {
  const rec = recorder({ isTty: false })
  const { calls, spawn } = spawnStub()
  const result = await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    undefined,
    undefined,
    { guard: rec.deps, spawn },
  )
  assertEquals(calls.length, 0)
  assertEquals(result.success, false)
  assertEquals(result.refused, 'non-interactive')
})

Deno.test('runAnsibleCapture starts ansible for every host only after the override is set', async () => {
  const rec = recorder({ isTty: false, env: { SLV_ALLOW_ALL_HOSTS: '1' } })
  const { calls, spawn } = spawnStub()
  const result = await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    undefined,
    undefined,
    { guard: rec.deps, spawn },
  )
  assertEquals(result.success, true)
  assertEquals(calls.length, 1)
  const args = calls[0].args
  assertEquals(args[args.indexOf('--limit') + 1], 'mainnet_validators')
})

Deno.test('runAnsibleCapture passes a named host straight through', async () => {
  const rec = recorder({ isTty: false })
  const { calls, spawn } = spawnStub()
  await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    'val-a',
    { k: 'v' },
    { guard: rec.deps, spawn },
  )
  assertEquals(calls.length, 1)
  const args = calls[0].args
  assertEquals(args[args.indexOf('--limit') + 1], 'val-a')
  assertEquals(args[args.indexOf('--extra-vars') + 1], '{"k":"v"}')
  assertEquals(rec.resolveCalls, [])
})

Deno.test('runAnsibleCapture does not start ansible for a host pattern or an unknown name without a terminal', async () => {
  for (const limit of [...PATTERN_EXAMPLES, 'val-a,typo']) {
    const rec = recorder({ isTty: false, matches: ['val-a'] })
    const { calls, spawn } = spawnStub()
    const result = await runAnsibleCapture(
      MUTATING,
      'mainnet_validators',
      limit,
      undefined,
      { guard: rec.deps, spawn },
    )
    assertEquals(calls.length, 0, limit)
    assertEquals(result.refused, 'non-interactive', limit)
  }
})

Deno.test('runAnsibleCapture starts a host-pattern run only after it is resolved and the user says yes', async () => {
  const rec = recorder({ isTty: true, answer: true, matches: ['val-a'] })
  const { calls, spawn } = spawnStub()
  const result = await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    'val-*',
    { k: 'v' },
    { guard: rec.deps, spawn },
  )
  assertEquals(result.success, true)
  assertEquals(rec.resolveCalls.length, 1)
  assertEquals(rec.resolveCalls[0].extraVars, { k: 'v' })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].args[calls[0].args.indexOf('--limit') + 1], 'val-*')

  const declined = recorder({ isTty: true, answer: false, matches: ['val-a'] })
  const none = spawnStub()
  const refused = await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    'val-*',
    undefined,
    { guard: declined.deps, spawn: none.spawn },
  )
  assertEquals(none.calls.length, 0)
  assertEquals(refused.refused, 'declined')
})

Deno.test('runAnsibleCapture sends a boolean extra var as a JSON boolean', async () => {
  const rec = recorder({ isTty: false })
  const { calls, spawn } = spawnStub()
  await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    'val-a',
    { first_activation: true },
    { guard: rec.deps, spawn },
  )
  const args = calls[0].args
  assertEquals(
    args[args.indexOf('--extra-vars') + 1],
    '{"first_activation":true}',
  )
})

Deno.test('runAnsibleCapture lets a read-only playbook and a pre-confirmed caller through without a prompt', async () => {
  const readOnly = recorder({ isTty: false })
  const first = spawnStub()
  await runAnsibleCapture(
    READ_ONLY,
    'mainnet_validators',
    undefined,
    undefined,
    { guard: readOnly.deps, spawn: first.spawn },
  )
  assertEquals(first.calls.length, 1)

  const confirmed = recorder({ isTty: true })
  const second = spawnStub()
  await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    undefined,
    undefined,
    { guard: confirmed.deps, spawn: second.spawn, allHostsConfirmed: true },
  )
  assertEquals(second.calls.length, 1)
  assertEquals(confirmed.confirms, [])
})

Deno.test('runAnsibleCapture does not start ansible when the user declines on a terminal', async () => {
  const rec = recorder({ isTty: true, answer: false })
  const { calls, spawn } = spawnStub()
  const result = await runAnsibleCapture(
    MUTATING,
    'mainnet_validators',
    undefined,
    undefined,
    { guard: rec.deps, spawn },
  )
  assertEquals(calls.length, 0)
  assertEquals(result.refused, 'declined')
  assertEquals(rec.confirms[0].default, false)
})
