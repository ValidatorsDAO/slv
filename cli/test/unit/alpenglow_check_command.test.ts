import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import type { AlpenglowState } from '/lib/alpenglowState.ts'
import type { Level } from '/lib/alpenglowReadiness.ts'
import {
  type CheckAlpenglowDeps,
  runCheckAlpenglow,
} from '/src/validator/checkAlpenglow.ts'
import {
  BLS,
  type Cluster,
  cluster,
  IDENTITY,
  reading,
  VOTE,
} from '/test/unit/_alpenglowFixtures.ts'

// slv overhaul: Alpenglow. `slv v check:alpenglow`: what it reads, which hosts
// it takes, what it prints and when it fails.

// val-1 is the node that gossips from 203.0.113.10; the others are standbys.
const ADDRESSES: Record<string, string> = {
  'val-1': '203.0.113.10',
  'val-2': '203.0.113.11',
  'val-3': '203.0.113.12',
}

const entry = (name: string, extra: Record<string, string> = {}) =>
  `    ${name}:
      ansible_host: ${extra.ip ?? ADDRESSES[name] ?? '203.0.113.10'}
      identity_account: ${extra.identity ?? IDENTITY}
      vote_account: ${extra.vote ?? VOTE}
      validator_type: ${extra.type ?? 'jito'}
`

const inventoryOf = (group: string, ...entries: string[]) =>
  `${group}:\n  hosts:\n${entries.join('')}`

const INVENTORY = inventoryOf(
  'mainnet_validators',
  entry('val-1'),
  entry('val-2'),
  entry('val-3', { type: 'agave' }),
)

type Harness = {
  deps: CheckAlpenglowDeps
  printed: { line: string; level?: Level }[]
  errors: string[]
  exitCodes: number[]
  groups: string[]
  states: string[]
  urls: Set<string>
  calls: { method: string; params: unknown[] }[]
}

const harness = (
  options: {
    inventory?: string | null
    versions?: unknown
    versionsError?: boolean
    state?: AlpenglowState
    cluster?: Cluster
  } = {},
): Harness => {
  const stub = cluster(options.cluster)
  const h: Harness = {
    deps: undefined as unknown as CheckAlpenglowDeps,
    printed: [],
    errors: [],
    exitCodes: [],
    groups: [],
    states: [],
    urls: new Set(),
    calls: stub.calls,
  }
  h.deps = {
    fetch: (url, init) => {
      h.urls.add(url)
      return stub.deps.fetch(url, init)
    },
    sleep: stub.deps.sleep,
    resolveHost: stub.deps.resolveHost,
    readState: (network) => {
      h.states.push(network)
      return Promise.resolve(reading(options.state ?? 'towerbft'))
    },
    readInventory: (group) => {
      h.groups.push(group)
      return Promise.resolve(
        options.inventory === undefined ? INVENTORY : options.inventory,
      )
    },
    readVersions: () =>
      options.versionsError
        ? Promise.reject(new Error('bad yaml'))
        : Promise.resolve(
          options.versions === undefined ? null : options.versions,
        ),
    defaults: defaultVersionsObject,
    print: (line, level) => h.printed.push({ line, level }),
    error: (line) => h.errors.push(line),
    setExitCode: (code) => h.exitCodes.push(code),
  }
  return h
}

const text = (h: Harness): string =>
  h.printed.map((entry) => entry.line).join('\n')

Deno.test('check:alpenglow takes mainnet by default and reads the mainnet inventory and the mainnet RPC only', async () => {
  const h = harness()
  assertEquals(await runCheckAlpenglow({}, h.deps), true)
  assertEquals(h.groups, ['mainnet_validators'])
  assertEquals(h.states, ['mainnet'])
  assertEquals([...h.urls], ['https://api.mainnet-beta.solana.com'])
  const header = h.printed[0].line
  assertStringIncludes(header, 'Alpenglow readiness on mainnet')
  assertStringIncludes(header, 'inventory.mainnet.validators.yml')
  assertStringIncludes(header, 'versions.yml')
  assertStringIncludes(header, 'https://api.mainnet-beta.solana.com')
  assertStringIncludes(
    header,
    'No host is contacted and no transaction is made',
  )
})

Deno.test('check:alpenglow -n testnet reads the testnet inventory and the testnet RPC', async () => {
  const h = harness({
    inventory: inventoryOf('testnet_validators', entry('val-t')),
    state: 'alpenglow',
  })
  assertEquals(await runCheckAlpenglow({ network: 'testnet' }, h.deps), true)
  assertEquals(h.groups, ['testnet_validators'])
  assertEquals(h.states, ['testnet'])
  assertEquals([...h.urls], ['https://api.testnet.solana.com'])
  assertStringIncludes(text(h), 'val-t (validator_type jito')
})

Deno.test('check:alpenglow refuses any other network before it reads anything', async () => {
  for (const network of ['devnet', 'Mainnet', 'localnet', '']) {
    const h = harness()
    assertEquals(await runCheckAlpenglow({ network }, h.deps), false, network)
    assertEquals([h.groups, h.states, h.calls], [[], [], []], network)
    assertEquals(h.exitCodes, [1], network)
    assertStringIncludes(
      h.errors.join('\n'),
      'supports -n mainnet or -n testnet',
    )
  }
})

Deno.test('check:alpenglow refuses a missing, empty or unreadable inventory and says what to do', async () => {
  const missing = harness({ inventory: null })
  assertEquals(await runCheckAlpenglow({}, missing.deps), false)
  assertStringIncludes(missing.errors.join('\n'), 'slv v init')
  assertEquals(missing.exitCodes, [1])

  const empty = harness({ inventory: 'mainnet_validators:\n  hosts: {}\n' })
  assertEquals(await runCheckAlpenglow({}, empty.deps), false)
  assertStringIncludes(empty.errors.join('\n'), 'has no validators')

  const broken = harness({ inventory: 'mainnet_validators: [unclosed' })
  assertEquals(await runCheckAlpenglow({}, broken.deps), false)
  assertStringIncludes(
    broken.errors.join('\n'),
    'cannot read the mainnet_validators inventory',
  )
  for (const h of [missing, empty, broken]) assertEquals(h.calls, [])
})

Deno.test('check:alpenglow -p takes one host, several or all, each once, and refuses a name the inventory does not have', async () => {
  const hostsOf = (h: Harness) =>
    h.printed.map((entry) => /^(val-\d) \(validator_type/.exec(entry.line)?.[1])
      .filter(Boolean)

  const one = harness()
  await runCheckAlpenglow({ pubkey: 'val-2' }, one.deps)
  assertEquals(hostsOf(one), ['val-2'])

  const several = harness()
  await runCheckAlpenglow({ pubkey: ' val-3, val-1,val-3 ' }, several.deps)
  assertEquals(hostsOf(several), ['val-3', 'val-1'])

  for (const pubkey of [undefined, '', 'all', 'ALL']) {
    const all = harness()
    await runCheckAlpenglow({ pubkey }, all.deps)
    assertEquals(hostsOf(all), ['val-1', 'val-2', 'val-3'], String(pubkey))
  }

  const unknown = harness()
  assertEquals(
    await runCheckAlpenglow({ pubkey: 'val-1,val-9' }, unknown.deps),
    false,
  )
  assertEquals(unknown.exitCodes, [1])
  assertStringIncludes(unknown.errors.join('\n'), 'no host named val-9')
  assertStringIncludes(unknown.errors.join('\n'), 'val-1, val-2, val-3')
  assertEquals(unknown.calls, [])
})

Deno.test('check:alpenglow prints the cluster line, then for each host a header and one line per check with its level, and a summary', async () => {
  const h = harness({ cluster: { votes: { [VOTE]: { bls: null } } } })
  await runCheckAlpenglow({ pubkey: 'val-1' }, h.deps)
  const lines = h.printed
  const cluster = lines.find((entry) => entry.line.startsWith('OK    cluster'))
  assert(cluster, 'the cluster line')
  assertEquals(cluster.level, 'OK')
  const header = lines.find((entry) => entry.line.startsWith('val-1 ('))
  assertEquals(
    header?.line,
    `val-1 (validator_type jito, identity ${IDENTITY}, vote account ${VOTE})`,
  )
  const checks = lines.filter((entry) => entry.line.startsWith('  '))
  assertEquals(
    checks.map((entry) => entry.line.slice(2, 16).trim().split(/\s+/)),
    [
      ['OK', 'client'],
      ['OK', 'running'],
      ['FAIL', 'bls'],
      ['OK', 'vat'],
      ['OK', 'identity'],
      ['OK', 'voter'],
    ],
  )
  assertEquals(checks.map((entry) => entry.level), [
    'OK',
    'OK',
    'FAIL',
    'OK',
    'OK',
    'OK',
  ])
  const bls = checks[2].line
  assertStringIncludes(bls, 'Fix: run slv v register:bls -n mainnet -p val-1')
  const summary = lines[lines.length - 1]
  assertEquals(summary.line, '1 FAIL, 0 WARN, 6 OK. Not ready: fix every FAIL.')
  assertEquals(summary.level, 'FAIL')
})

Deno.test('check:alpenglow exits 1 when a check FAILs, and leaves the exit code alone with only OK and WARN', async () => {
  const failing = harness({ cluster: { votes: { [VOTE]: { bls: null } } } })
  assertEquals(await runCheckAlpenglow({}, failing.deps), false)
  assertEquals(failing.exitCodes, [1])

  // A low identity balance and a migration window are WARNs, not failures.
  const warned = harness({
    state: 'window',
    cluster: { balances: { [IDENTITY]: 1 } },
  })
  assertEquals(await runCheckAlpenglow({ pubkey: 'val-1' }, warned.deps), true)
  assertEquals(warned.exitCodes, [])
  assertStringIncludes(text(warned), '0 FAIL, 2 WARN, 5 OK.')
  assertEquals(warned.printed[warned.printed.length - 1].level, 'WARN')

  const clean = harness()
  assertEquals(await runCheckAlpenglow({ pubkey: 'val-1' }, clean.deps), true)
  assertEquals(clean.exitCodes, [])
  assertEquals(
    clean.printed[clean.printed.length - 1].line,
    '0 FAIL, 0 WARN, 7 OK.',
  )
})

Deno.test('check:alpenglow uses the pins of versions.yml, and refuses a versions.yml it cannot read', async () => {
  const pinned = harness({
    versions: { mainnet_validators: { version_jito: '4.2.2-jito' } },
  })
  assertEquals(await runCheckAlpenglow({ pubkey: 'val-1' }, pinned.deps), false)
  assertStringIncludes(
    text(pinned),
    'mainnet_validators.version_jito is 4.2.2-jito',
  )
  assertEquals(pinned.exitCodes, [1])

  const broken = harness({ versionsError: true })
  assertEquals(await runCheckAlpenglow({}, broken.deps), false)
  assertStringIncludes(
    broken.errors.join('\n'),
    'cannot read ~/.slv/versions.yml: bad yaml',
  )
  assertEquals(broken.calls, [])
})

Deno.test('check:alpenglow sends nothing but reads to the RPC', async () => {
  const h = harness({ state: 'alpenglow' })
  await runCheckAlpenglow({}, h.deps)
  assert(h.calls.length > 0)
  for (const call of h.calls) {
    assert(
      [
        'getAccountInfo',
        'getBalance',
        'getClusterNodes',
        'getEpochInfo',
        'getMinimumBalanceForRentExemption',
      ].includes(call.method),
      call.method,
    )
  }
  assertStringIncludes(text(h), BLS.slice(0, 8))
})

Deno.test('slv v check:alpenglow is registered with -n (default mainnet) and -p and runs runCheckAlpenglow', async () => {
  const index = await Deno.readTextFile(
    new URL('../../src/validator/index.ts', import.meta.url),
  )
  const start = index.indexOf("validatorCmd.command('check:alpenglow')")
  assert(start > 0, 'no check:alpenglow command')
  const end = index.indexOf('validatorCmd.command(', start + 1)
  const block = index.slice(start, end)
  assertStringIncludes(block, "'-n, --network <network>'")
  assertStringIncludes(block, "default: 'mainnet'")
  assertStringIncludes(block, "'-p, --pubkey <pubkey>'")
  assertStringIncludes(block, 'await runCheckAlpenglow({')
  assertStringIncludes(block, 'network: options.network')
  assertStringIncludes(block, 'pubkey: options.pubkey')
  for (
    const part of [
      'Read-only',
      'advertises in gossip',
      'BLS public key',
      'Validator Admission Ticket',
      'authorized voter',
    ]
  ) {
    assertStringIncludes(block, part)
  }
})
