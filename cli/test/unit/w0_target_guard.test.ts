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
  isAllHostsLimit,
  parseInventoryHosts,
  READ_ONLY_PLAYBOOKS,
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
}

const recorder = (
  options: {
    isTty?: boolean
    env?: Record<string, string>
    answer?: boolean
    hosts?: InventoryHost[]
    readFails?: boolean
  } = {},
): Recorder => {
  const rec: Recorder = {
    info: [],
    errors: [],
    confirms: [],
    exitCodes: [],
    readCalls: [],
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

Deno.test('isAllHostsLimit treats a missing, blank, all, wildcard or group-name limit as every host', () => {
  for (
    const limit of [undefined, '', ' ', 'all', 'All', '*', 'mainnet_validators']
  ) {
    assert(isAllHostsLimit(limit, 'mainnet_validators'), String(limit))
  }
  for (const limit of ['val-a', 'val-a,val-b', 'testnet_validators']) {
    assert(!isAllHostsLimit(limit, 'mainnet_validators'), limit)
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

Deno.test('the guard does not read the inventory when a host is named', async () => {
  const rec = recorder({ isTty: false })
  const verdict = await enforceAllHostsGuard(
    {
      playbook: MUTATING,
      inventoryType: 'mainnet_validators',
      limit: 'val-a',
    },
    rec.deps,
  )
  assertEquals(verdict, { proceed: true })
  assertEquals(rec.readCalls, [])
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
  assertEquals(rec.readCalls, [])
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
