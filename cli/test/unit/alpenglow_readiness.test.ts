import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import type { AlpenglowState } from '/lib/alpenglowState.ts'
import {
  type CheckLine,
  type CheckName,
  checkReadiness,
  formatCheckLine,
  parseValidatorHosts,
  READ_ONLY_METHODS,
  type ReadinessHost,
  type ReadinessNetwork,
  type ReadinessReport,
  VAT_LAMPORTS,
} from '/lib/alpenglowReadiness.ts'
import {
  BLS,
  type Cluster,
  cluster,
  HOST,
  IDENTITY,
  OTHER_VOTER,
  reading,
  RENT_EXEMPT,
  SOL,
  VOTE,
} from '/test/unit/_alpenglowFixtures.ts'

// slv overhaul: Alpenglow. `slv v check:alpenglow` against stubbed RPC answers.

const run = async (
  options: {
    network?: ReadinessNetwork
    hosts?: ReadinessHost[]
    state?: AlpenglowState
    versions?: unknown
    cluster?: Cluster
  } = {},
): Promise<
  ReadinessReport & {
    calls: { url: string; method: string; params: unknown[] }[]
    sleeps: number[]
  }
> => {
  const stub = cluster(options.cluster)
  const report = await checkReadiness({
    network: options.network ?? 'mainnet',
    hosts: options.hosts ?? [HOST],
    versions: options.versions === undefined ? null : options.versions,
    defaults: defaultVersionsObject(),
  }, {
    ...stub.deps,
    readState: () => Promise.resolve(reading(options.state ?? 'towerbft')),
  })
  return { ...report, calls: stub.calls, sleeps: stub.sleeps }
}

const lineOf = (
  report: ReadinessReport,
  check: CheckName,
  index = 0,
): CheckLine => {
  const lines = check === 'cluster'
    ? [report.cluster]
    : report.hosts[index].lines.filter((line) => line.check === check)
  assertEquals(lines.length, 1, `one ${check} line`)
  return lines[0]
}

// --- 1. the cluster -------------------------------------------------------------

Deno.test('the cluster line says what each state means for identity changes', async () => {
  const expectations: [AlpenglowState, string, string[]][] = [
    ['towerbft', 'OK', [
      'TowerBFT',
      'go on as before',
      'epoch 1059',
      'epoch 1064',
      '5 epochs from now',
    ]],
    ['imminent', 'WARN', [
      'about to start',
      'refused until the genesis certificate',
    ]],
    ['window', 'WARN', ['migration window', 'Identity changes are refused']],
    ['alpenglow', 'OK', [
      'vote_history',
      'slv v set:identity -n mainnet -p <host> --primary-down',
      'voted only before Alpenglow, so that there is no vote history file, use slv v set:identity -n mainnet -p <host> --first-activation',
    ]],
    ['unknown', 'WARN', [
      'cannot be read',
      'getAgGenesisCert: unknown',
      'refused while it cannot be read',
    ]],
  ]
  for (const [state, level, parts] of expectations) {
    const line = lineOf(await run({ state }), 'cluster')
    assertEquals(line.level, level, state)
    for (const part of parts) assertStringIncludes(line.message, part, state)
    assertEquals(line.fix !== undefined, level === 'WARN', state)
  }
})

// --- 2. the client --------------------------------------------------------------

Deno.test('a mainnet validator of a supported type at or above the floor is OK, and the line says the pin is not the running version', async () => {
  for (const type of ['agave', 'jito', 'allnodes-jito']) {
    const report = await run({ hosts: [{ ...HOST, validatorType: type }] })
    const line = lineOf(report, 'client')
    assertEquals(line.level, 'OK', type)
    assertStringIncludes(line.message, 'the default')
    assertStringIncludes(line.message, '4.3.0')
    assertStringIncludes(line.message, 'not read')
  }
  const pinned = await run({
    versions: { mainnet_validators: { version_jito: '4.3.0-jito.1' } },
  })
  assertStringIncludes(
    lineOf(pinned, 'client').message,
    'is 4.3.0-jito.1 in ~/.slv/versions.yml',
  )
})

Deno.test('a Firedancer or Frankendancer type FAILs on mainnet with the way out, and WARNs on testnet', async () => {
  for (const type of ['firedancer-agave', 'firedancer-jito', 'frankendancer']) {
    const mainnet = lineOf(
      await run({ hosts: [{ ...HOST, validatorType: type }] }),
      'client',
    )
    assertEquals(mainnet.level, 'FAIL', type)
    assertStringIncludes(mainnet.message, 'not supported during the migration')
    assertStringIncludes(mainnet.message, 'epoch 1064')
    assertStringIncludes(mainnet.fix ?? '', 'agave, jito or allnodes-jito')
    assertStringIncludes(mainnet.fix ?? '', 'slv v switch')
    const testnet = lineOf(
      await run({
        network: 'testnet',
        hosts: [{ ...HOST, validatorType: type }],
      }),
      'client',
    )
    assertEquals(testnet.level, 'WARN', type)
    assertStringIncludes(testnet.message, 'vote history file')
  }
})

Deno.test('a missing or unknown validator_type FAILs', async () => {
  const missing = lineOf(
    await run({ hosts: [{ ...HOST, validatorType: '' }] }),
    'client',
  )
  assertEquals(missing.level, 'FAIL')
  assertStringIncludes(missing.message, 'no validator_type')
  const unknown = lineOf(
    await run({ hosts: [{ ...HOST, validatorType: 'solana' }] }),
    'client',
  )
  assertEquals(unknown.level, 'FAIL')
  assertStringIncludes(
    unknown.message,
    'validator_type solana is not one slv supports',
  )
  assertStringIncludes(unknown.fix ?? '', 'agave, jito, allnodes-jito')
})

Deno.test('a pin below the floor FAILs with the default to set and the commands that put it on the host', async () => {
  const cases: [string, unknown][] = [
    ['jito', '4.2.2-jito'],
    ['agave', 4.2],
    ['agave', '4.2.1.1'],
    ['jito', '3.1.10-bam'],
  ]
  for (const [type, pin] of cases) {
    const key = type === 'agave' ? 'version_agave' : 'version_jito'
    const report = await run({
      hosts: [{ ...HOST, validatorType: type }],
      versions: { mainnet_validators: { [key]: pin } },
    })
    const line = lineOf(report, 'client')
    assertEquals(line.level, 'FAIL', `${type} ${pin}`)
    assertStringIncludes(line.message, `mainnet_validators.${key} is ${pin}`)
    assertStringIncludes(line.message, 'below 4.3.0')
    const fix = line.fix ?? ''
    assertStringIncludes(
      fix,
      `set mainnet_validators.${key} to ${
        type === 'agave' ? '4.3.2' : '4.3.2-jito'
      }`,
    )
    assertStringIncludes(fix, 'slv v build:solana -n mainnet -p val-1')
    assertStringIncludes(fix, 'slv v update:script -n mainnet -p val-1')
    assertStringIncludes(fix, 'slv v restart -n mainnet -p val-1')
  }
  // The floor of testnet is 4.4.0-beta.0.
  const testnet = lineOf(
    await run({
      network: 'testnet',
      versions: { testnet_validators: { version_jito: '4.3.2-jito' } },
    }),
    'client',
  )
  assertEquals(testnet.level, 'FAIL')
  assertStringIncludes(testnet.message, 'below 4.4.0-beta.0')
})

Deno.test('a pin with no X.Y FAILs on mainnet and only WARNs on testnet', async () => {
  for (const pin of ['latest', 'main', 'a1b2c3d']) {
    const mainnet = lineOf(
      await run({ versions: { mainnet_validators: { version_jito: pin } } }),
      'client',
    )
    assertEquals(mainnet.level, 'FAIL', pin)
    assertStringIncludes(mainnet.message, 'not a version (X.Y.Z)')
    const testnet = lineOf(
      await run({
        network: 'testnet',
        versions: { testnet_validators: { version_jito: pin } },
      }),
      'client',
    )
    assertEquals(testnet.level, 'WARN', pin)
  }
})

// --- 2b. the version the node runs, from gossip -----------------------------------

const gossipAt = (version: string | null, gossip = '203.0.113.10:8001') => ({
  pubkey: IDENTITY,
  gossip,
  version,
})

Deno.test('a node that gossips from the address of its host at the pinned version, at or above the floor, is OK and the line says what runs', async () => {
  // The jito tag of the pin is not part of the version the node advertises.
  const report = await run({ cluster: { nodes: [gossipAt('4.3.2')] } })
  const line = lineOf(report, 'running')
  assertEquals(line.level, 'OK')
  assertStringIncludes(
    line.message,
    'the node advertises 4.3.2, the pinned 4.3.2-jito',
  )
  assertStringIncludes(line.message, 'at or above 4.3.0')
  assertEquals(line.fix, undefined)
  const getClusterNodes = report.calls.find((call) =>
    call.method === 'getClusterNodes'
  )
  assertEquals(getClusterNodes?.params, [])
})

Deno.test('a running version below the floor FAILs on mainnet and WARNs on testnet, with the commands that upgrade the node', async () => {
  const mainnet = lineOf(
    await run({ cluster: { nodes: [gossipAt('4.2.2')] } }),
    'running',
  )
  assertEquals(mainnet.level, 'FAIL')
  assertStringIncludes(mainnet.message, 'advertises 4.2.2, below 4.3.0')
  assertStringIncludes(
    mainnet.fix ?? '',
    'slv v build:solana -n mainnet -p val-1',
  )
  assertStringIncludes(mainnet.fix ?? '', 'slv v restart -n mainnet -p val-1')
  assertEquals((mainnet.fix ?? '').includes('set the pin first'), false)

  const testnet = lineOf(
    await run({ network: 'testnet', cluster: { nodes: [gossipAt('4.3.2')] } }),
    'running',
  )
  assertEquals(testnet.level, 'WARN')
  assertStringIncludes(testnet.message, 'below 4.4.0-beta.0')

  // With the pin below the floor too, the pin comes first.
  const stale = lineOf(
    await run({
      versions: { mainnet_validators: { version_jito: '4.2.2-jito' } },
      cluster: { nodes: [gossipAt('4.2.2')] },
    }),
    'running',
  )
  assertEquals(stale.level, 'FAIL')
  assertStringIncludes(
    stale.fix ?? '',
    'set the pin first (see client), then slv v build:solana',
  )
})

Deno.test('a running version that differs from the pin WARNs with pinned and running, whichever is newer', async () => {
  for (const running of ['4.3.1', '4.3.3']) {
    const line = lineOf(
      await run({ cluster: { nodes: [gossipAt(running)] } }),
      'running',
    )
    assertEquals(line.level, 'WARN', running)
    assertStringIncludes(
      line.message,
      `pinned 4.3.2-jito (the default), running ${running}`,
    )
    assertStringIncludes(
      line.fix ?? '',
      'to run the pin: slv v build:solana -n mainnet -p val-1',
    )
    assertStringIncludes(
      line.fix ?? '',
      `set mainnet_validators.version_jito to ${running}`,
    )
  }
  const pinned = lineOf(
    await run({
      versions: { mainnet_validators: { version_jito: '4.3.2-jito' } },
      cluster: { nodes: [gossipAt('4.3.3')] },
    }),
    'running',
  )
  assertStringIncludes(pinned.message, 'pinned 4.3.2-jito, running 4.3.3')
  assertEquals(pinned.message.includes('(the default)'), false)
})

Deno.test('an identity that gossips from another address than the host is a standby: said plainly, not compared and not a failure', async () => {
  const standby = { ...HOST, name: 'val-2', ansibleHost: '203.0.113.11' }
  const report = await run({
    hosts: [HOST, standby],
    cluster: { nodes: [gossipAt('4.2.2')] },
  })
  // The primary is the node that gossips: its version is the one that is judged.
  assertEquals(lineOf(report, 'running', 0).level, 'FAIL')
  const line = lineOf(report, 'running', 1)
  assertEquals(line.level, 'OK')
  assertStringIncludes(
    line.message,
    'in gossip at 203.0.113.10, not at this host (203.0.113.11)',
  )
  assertStringIncludes(
    line.message,
    'a standby on its unstaked key is not visible',
  )
  assertEquals(line.message.includes('4.2.2'), false)
})

Deno.test('an identity that is not in the gossip table at all WARNs and says why, and is not a failure', async () => {
  const report = await run({ cluster: { nodes: [] } })
  const line = lineOf(report, 'running')
  assertEquals(line.level, 'WARN')
  assertStringIncludes(line.message, 'not in the gossip table of mainnet')
  assertStringIncludes(
    line.message,
    'a standby on its unstaked key is not visible',
  )
  assertEquals(report.counts.FAIL, 0)
})

Deno.test('the gossip table is read once for all hosts, and when it cannot be read each host WARNs and nothing fails', async () => {
  const report = await run({
    hosts: [HOST, { ...HOST, name: 'val-2', ansibleHost: '203.0.113.11' }],
    cluster: { fail: { getClusterNodes: 500 } },
  })
  assertEquals(
    report.calls.filter((call) => call.method === 'getClusterNodes').length,
    3,
  )
  for (const index of [0, 1]) {
    const line = lineOf(report, 'running', index)
    assertEquals(line.level, 'WARN', `host ${index}`)
    assertStringIncludes(
      line.message,
      'cannot be read (getClusterNodes: HTTP 500)',
    )
  }
  assertEquals(report.counts.FAIL, 0)
})

Deno.test('a host whose address cannot be compared with gossip takes the node of the identity as its own, and says so', async () => {
  for (
    const ansibleHost of ['', '127.0.0.1', 'localhost', 'gone.example.net']
  ) {
    const report = await run({
      hosts: [{ ...HOST, ansibleHost }],
      cluster: { nodes: [gossipAt('4.2.2', '198.51.100.7:8001')] },
    })
    const line = lineOf(report, 'running')
    assertEquals(line.level, 'FAIL', ansibleHost)
    assertStringIncludes(line.message, 'advertises 4.2.2, below 4.3.0')
    assertStringIncludes(line.message, 'cannot be compared with gossip')
  }
})

Deno.test('the version of a Firedancer or Frankendancer node is shown and not compared with the floor', async () => {
  for (const type of ['firedancer-jito', 'frankendancer']) {
    const line = lineOf(
      await run({
        network: 'testnet',
        hosts: [{ ...HOST, validatorType: type }],
        cluster: { nodes: [gossipAt('26.10.2')] },
      }),
      'running',
    )
    assertEquals(line.level, 'OK', type)
    assertStringIncludes(line.message, 'advertises 26.10.2')
    assertStringIncludes(line.message, 'on their own scheme')
  }
})

Deno.test('a node that advertises no version, or none that reads as X.Y.Z, WARNs', async () => {
  for (const version of [null, 'main', '']) {
    const line = lineOf(
      await run({ cluster: { nodes: [gossipAt(version)] } }),
      'running',
    )
    assertEquals(line.level, 'WARN', String(version))
    assertStringIncludes(line.message, 'which is not a version (X.Y.Z)')
  }
})

Deno.test('a pin set to nothing is a pin that cannot be read: FAIL on mainnet and WARN on testnet', async () => {
  const mainnet = lineOf(
    await run({ versions: { mainnet_validators: { version_jito: null } } }),
    'client',
  )
  assertEquals(mainnet.level, 'FAIL')
  assertStringIncludes(
    mainnet.message,
    'mainnet_validators.version_jito is (empty) in ~/.slv/versions.yml',
  )
  const testnet = lineOf(
    await run({
      network: 'testnet',
      versions: { testnet_validators: { version_jito: null } },
    }),
    'client',
  )
  assertEquals(testnet.level, 'WARN')
})

// --- 3. the BLS public key ------------------------------------------------------

Deno.test('a vote account with a BLS public key is OK, and one without FAILs with slv v register:bls', async () => {
  const ok = lineOf(await run(), 'bls')
  assertEquals(ok.level, 'OK')
  assertStringIncludes(ok.message, BLS.slice(0, 8))

  for (const bls of [null, '']) {
    const report = await run({
      network: 'testnet',
      cluster: { votes: { [VOTE]: { bls } } },
    })
    const line = lineOf(report, 'bls')
    assertEquals(line.level, 'FAIL', JSON.stringify(bls))
    assertStringIncludes(
      line.message,
      'excluded from the Validator Admission Ticket set',
    )
    assertStringIncludes(
      line.fix ?? '',
      'slv v register:bls -n testnet -p val-1',
    )
    assertStringIncludes(line.fix ?? '', 'solana CLI 4.1.0')
  }
})

Deno.test('a vote account that cannot be read FAILs once, after two more tries, and the checks that need it say they were not made', async () => {
  const report = await run({
    cluster: { fail: { getAccountInfo: 429 } },
  })
  const bls = lineOf(report, 'bls')
  assertEquals(bls.level, 'FAIL')
  assertStringIncludes(bls.message, 'cannot be read (getAccountInfo: HTTP 429)')
  assertEquals(report.sleeps, [2000, 2000])
  for (const check of ['vat', 'voter'] as const) {
    const line = lineOf(report, check)
    assertEquals(line.level, 'WARN', check)
    assertStringIncludes(line.message, 'not checked')
  }
  assertEquals(report.counts.FAIL, 1)
})

Deno.test('a vote account that does not exist, or none in the inventory, FAILs', async () => {
  const gone = await run({ cluster: { votes: { [VOTE]: null } } })
  assertEquals(lineOf(gone, 'bls').level, 'FAIL')
  assertStringIncludes(lineOf(gone, 'bls').message, 'does not exist on mainnet')

  const none = await run({ hosts: [{ ...HOST, voteAccount: '' }] })
  assertEquals(lineOf(none, 'bls').level, 'FAIL')
  assertStringIncludes(lineOf(none, 'bls').message, 'no vote_account')
  assertEquals(
    none.calls.filter((call) => call.method === 'getAccountInfo').length,
    0,
  )

  const notVote = await run({
    cluster: {
      votes: { [VOTE]: { owner: '11111111111111111111111111111111' } },
    },
  })
  assertStringIncludes(
    lineOf(notVote, 'bls').message,
    'not owned by the vote program',
  )
})

// --- 4. the VAT -----------------------------------------------------------------

Deno.test('the VAT line counts the epochs of 0.8 SOL the vote account holds above its rent-exempt minimum', async () => {
  const cases: [number, string, string][] = [
    [0, 'FAIL', '0 epochs'],
    [VAT_LAMPORTS - 1, 'FAIL', '0 epochs'],
    [VAT_LAMPORTS, 'WARN', '1 epoch '],
    [2 * VAT_LAMPORTS + 5, 'WARN', '2 epochs'],
    [3 * VAT_LAMPORTS, 'OK', '3 epochs'],
    [10 * SOL, 'OK', '12 epochs'],
  ]
  for (const [surplus, level, epochs] of cases) {
    const report = await run({
      cluster: { votes: { [VOTE]: { lamports: RENT_EXEMPT + surplus } } },
    })
    const line = lineOf(report, 'vat')
    assertEquals(line.level, level, `surplus ${surplus}`)
    assertStringIncludes(line.message, `covers ${epochs}`)
    assertStringIncludes(line.message, '0.8 SOL per epoch')
    assertEquals(line.fix !== undefined, level !== 'OK', `surplus ${surplus}`)
  }
  // A balance under the rent-exempt minimum has no surplus at all.
  const under = await run({
    cluster: { votes: { [VOTE]: { lamports: RENT_EXEMPT - 1 } } },
  })
  assertEquals(lineOf(under, 'vat').level, 'FAIL')
})

Deno.test('the VAT fix names the SOL to send to the vote account and not to the identity, and the rent-exempt minimum is read for the size of the account', async () => {
  const report = await run({
    cluster: {
      votes: { [VOTE]: { lamports: 20_000_000, space: 3731 } },
      rentExempt: 19_000_000,
    },
  })
  const line = lineOf(report, 'vat')
  assertEquals(line.level, 'FAIL')
  assertStringIncludes(
    line.message,
    '0.001 SOL above its rent-exempt minimum (0.019 SOL)',
  )
  assertStringIncludes(
    line.fix ?? '',
    'send at least 0.799 SOL to the vote account',
  )
  assertStringIncludes(line.fix ?? '', 'not to the identity')
  assertStringIncludes(line.fix ?? '', '2.399 SOL keeps 3 epochs covered')
  const rent = report.calls.find((call) =>
    call.method === 'getMinimumBalanceForRentExemption'
  )
  assertEquals(rent?.params, [3731])
})

Deno.test('the VAT line dates the first charge to epoch 1064 on mainnet before the activation, and to every epoch after it', async () => {
  const before = lineOf(await run({ state: 'towerbft' }), 'vat').message
  assertStringIncludes(
    before,
    'the first VAT is charged at the start of epoch 1064 for admission in 1065',
  )
  const imminent =
    lineOf(await run({ state: 'imminent', cluster: { epoch: 1063 } }), 'vat')
      .message
  assertStringIncludes(imminent, 'epoch 1064')
  for (const state of ['alpenglow', 'window'] as const) {
    const after = lineOf(await run({ state }), 'vat').message
    assertStringIncludes(after, 'a VAT is charged at the start of every epoch')
  }
  const testnet =
    lineOf(await run({ network: 'testnet', state: 'alpenglow' }), 'vat').message
  assertEquals(testnet.includes('1064'), false)
})

// --- 5. the identity ------------------------------------------------------------

Deno.test('the identity is WARNed about below three epochs of TowerBFT vote fees, and the line says what it pays for', async () => {
  const cases: [number, string][] = [
    [0, 'WARN'],
    [3 * SOL - 1, 'WARN'],
    [3 * SOL, 'OK'],
    [40 * SOL, 'OK'],
  ]
  for (const state of ['towerbft', 'imminent', 'window', 'unknown'] as const) {
    for (const [lamports, level] of cases) {
      const report = await run({
        state,
        cluster: { balances: { [IDENTITY]: lamports } },
      })
      const line = lineOf(report, 'identity')
      assertEquals(line.level, level, `${state} ${lamports}`)
      assertStringIncludes(
        line.message,
        'vote transaction fees, about 1 SOL per epoch',
      )
      assertStringIncludes(line.message, 'those fees go away')
      if (level === 'WARN') {
        assertStringIncludes(line.fix ?? '', `to the identity ${IDENTITY}`)
      }
    }
  }
})

Deno.test('under Alpenglow the identity needs no vote fees, so an empty one is OK', async () => {
  const report = await run({
    state: 'alpenglow',
    cluster: { balances: { [IDENTITY]: 0 } },
  })
  const line = lineOf(report, 'identity')
  assertEquals(line.level, 'OK')
  assertStringIncludes(line.message, 'votes are not transactions')
  assertStringIncludes(line.message, 'the VAT comes from the vote account')
})

Deno.test('an identity balance that cannot be read is a WARN, and a host with no identity_account FAILs', async () => {
  const unreadable = await run({ cluster: { fail: { getBalance: 500 } } })
  assertEquals(lineOf(unreadable, 'identity').level, 'WARN')
  assertStringIncludes(
    lineOf(unreadable, 'identity').message,
    'cannot be read (getBalance: HTTP 500)',
  )
  const none = await run({ hosts: [{ ...HOST, identityAccount: '' }] })
  assertEquals(lineOf(none, 'identity').level, 'FAIL')
  assertStringIncludes(lineOf(none, 'identity').message, 'no identity_account')
  assertEquals(lineOf(none, 'running').level, 'WARN')
  assertEquals(
    none.calls.filter((call) => call.method === 'getClusterNodes').length,
    0,
  )
})

// --- 6. the authorized voter ----------------------------------------------------

Deno.test('an authorized voter that is the identity is OK, and another one FAILs with the fix that comes before slv v register:bls', async () => {
  assertEquals(lineOf(await run(), 'voter').level, 'OK')

  const report = await run({
    cluster: {
      votes: {
        [VOTE]: {
          voters: [[1058, OTHER_VOTER], [1059, OTHER_VOTER]],
          bls: null,
        },
      },
    },
  })
  const voter = lineOf(report, 'voter')
  assertEquals(voter.level, 'FAIL')
  assertStringIncludes(
    voter.message,
    `is ${OTHER_VOTER}, not the identity ${IDENTITY}`,
  )
  assertStringIncludes(voter.message, 'adds only the identity keypair')
  assertStringIncludes(voter.fix ?? '', 'solana vote-authorize-voter-checked')
  assertStringIncludes(voter.fix ?? '', `~/.slv/keys/${IDENTITY}.json`)
  assertStringIncludes(
    voter.fix ?? '',
    'then slv v register:bls -n mainnet -p val-1',
  )
  // With the voter wrong, the BLS fix says to start there.
  assertStringIncludes(
    lineOf(report, 'bls').fix ?? '',
    'make the identity the authorized voter first',
  )
})

Deno.test('a vote account that names another node than the identity FAILs with the fix, and one that names the identity is as before', async () => {
  const other = lineOf(
    await run({ cluster: { votes: { [VOTE]: { node: OTHER_VOTER } } } }),
    'voter',
  )
  assertEquals(other.level, 'FAIL')
  assertStringIncludes(
    other.message,
    `names ${OTHER_VOTER} as its node, not the identity ${IDENTITY}`,
  )
  assertStringIncludes(
    other.message,
    'say nothing about whether the identity is running',
  )
  assertStringIncludes(other.fix ?? '', 'vote_account or identity_account')
  assertEquals(lineOf(await run(), 'voter').level, 'OK')
})

Deno.test('the authorized voter is the one in force in the current epoch, and a change that has not begun is a WARN', async () => {
  // An entry for an epoch to come is not the voter yet.
  const later = await run({
    cluster: {
      epoch: 1059,
      votes: { [VOTE]: { voters: [[1058, IDENTITY], [1060, OTHER_VOTER]] } },
    },
  })
  const leaving = lineOf(later, 'voter')
  assertEquals(leaving.level, 'WARN')
  assertStringIncludes(
    leaving.message,
    `is the identity now, but it changes to ${OTHER_VOTER} at epoch 1060`,
  )

  const arriving = await run({
    cluster: {
      epoch: 1059,
      votes: { [VOTE]: { voters: [[1058, OTHER_VOTER], [1060, IDENTITY]] } },
    },
  })
  const joining = lineOf(arriving, 'voter')
  assertEquals(joining.level, 'WARN')
  assertStringIncludes(
    joining.message,
    `is ${OTHER_VOTER} now and becomes the identity at epoch 1060`,
  )

  // Once the epoch is reached the same entries are the voter.
  const reached = await run({
    cluster: {
      epoch: 1060,
      votes: { [VOTE]: { voters: [[1058, OTHER_VOTER], [1060, IDENTITY]] } },
    },
  })
  assertEquals(lineOf(reached, 'voter').level, 'OK')
})

// --- the whole report -----------------------------------------------------------

Deno.test('hosts that share a vote account, an identity and a vote account size are read once', async () => {
  const standby = { ...HOST, name: 'val-2' }
  const report = await run({ hosts: [HOST, standby] })
  assertEquals(report.hosts.length, 2)
  const count = (method: string) =>
    report.calls.filter((call) => call.method === method).length
  assertEquals(count('getAccountInfo'), 1)
  assertEquals(count('getBalance'), 1)
  assertEquals(count('getMinimumBalanceForRentExemption'), 1)
  assertEquals(count('getClusterNodes'), 1)
  assertEquals(
    report.hosts[1].lines.map((line) => line.level),
    report.hosts[0].lines.map((line) => line.level),
  )
})

Deno.test('every check gives exactly one line per host, in the order of the checks, and the counts add up', async () => {
  const report = await run({
    hosts: [HOST, { ...HOST, name: 'val-2', validatorType: 'frankendancer' }],
  })
  for (const entry of report.hosts) {
    assertEquals(entry.lines.map((line) => line.check), [
      'client',
      'running',
      'bls',
      'vat',
      'identity',
      'voter',
    ])
  }
  const all = [report.cluster, ...report.hosts.flatMap((entry) => entry.lines)]
  assertEquals(
    report.counts.OK + report.counts.WARN + report.counts.FAIL,
    all.length,
  )
  assertEquals(
    report.counts.FAIL,
    all.filter((line) => line.level === 'FAIL').length,
  )
  assert(report.counts.FAIL >= 1, 'the Frankendancer host fails')
  // A line reads: level, check, what was found, and the fix.
  const failing = report.hosts[1].lines[0]
  assertEquals(
    formatCheckLine(failing).startsWith(
      'FAIL  client    validator_type frankendancer',
    ),
    true,
  )
  assertStringIncludes(
    formatCheckLine(failing),
    ' Fix: set validator_type to agave, jito or allnodes-jito',
  )
})

Deno.test('the check only calls RPC methods that read, and starts no process', async () => {
  const report = await run({
    state: 'alpenglow',
    hosts: [HOST, {
      ...HOST,
      name: 'val-2',
      identityAccount: OTHER_VOTER,
      voteAccount: OTHER_VOTER,
    }],
  })
  assert(report.calls.length > 0)
  const methods = new Set(report.calls.map((call) => call.method))
  for (const method of methods) {
    assert((READ_ONLY_METHODS as readonly string[]).includes(method), method)
  }
  for (
    const file of [
      'lib/alpenglowReadiness.ts',
      'src/validator/checkAlpenglow.ts',
    ]
  ) {
    const text = await Deno.readTextFile(
      new URL(`../../${file}`, import.meta.url),
    )
    for (
      const forbidden of [
        'Deno.Command',
        'spawnSync',
        'runAnsilbe',
        'sendTransaction',
        'requestAirdrop',
      ]
    ) {
      assertEquals(
        text.includes(forbidden),
        false,
        `${file} mentions ${forbidden}`,
      )
    }
  }
})

Deno.test('the hosts of an inventory file are read with their identity, vote account and validator_type', () => {
  const hosts = parseValidatorHosts(
    `mainnet_validators:
  hosts:
    val-1:
      ansible_host: 203.0.113.10
      identity_account: ${IDENTITY}
      vote_account: ${VOTE}
      validator_type: jito
    val-2:
      identity_account: ${IDENTITY}
`,
    'mainnet_validators',
  )
  assertEquals(hosts, [
    HOST,
    {
      name: 'val-2',
      ansibleHost: '',
      identityAccount: IDENTITY,
      voteAccount: '',
      validatorType: '',
    },
  ])
  assertEquals(
    parseValidatorHosts(
      'testnet_validators:\n  hosts: {}\n',
      'mainnet_validators',
    ),
    [],
  )
})

// --- the advice names the network of the run ----------------------------------

type RunOptions = NonNullable<Parameters<typeof run>[0]>

Deno.test('every slv command the report advises names the network of the run, because a bare command takes the default network of that command', async () => {
  // check:alpenglow reads mainnet, and set:identity and gen:vote-account read
  // testnet, unless -n says otherwise.
  const advised =
    /slv v (set:identity|check:alpenglow|switch|gen:vote-account|register:bls)(?:(?!slv v )[^.;)])*/g
  const scenarios: [string, RunOptions][] = [
    ['Alpenglow', { state: 'alpenglow' }],
    ['migration window', { state: 'window' }],
    ['state unreadable', { state: 'unknown' }],
    ['Frankendancer', { hosts: [{ ...HOST, validatorType: 'frankendancer' }] }],
    ['gossip unreadable', { cluster: { fail: { getClusterNodes: 503 } } }],
    ['no vote_account', { hosts: [{ ...HOST, voteAccount: '' }] }],
    ['vote account missing', { cluster: { votes: { [VOTE]: null } } }],
    ['vote account unreadable', { cluster: { fail: { getAccountInfo: 503 } } }],
    ['rent-exempt unreadable', {
      cluster: { fail: { getMinimumBalanceForRentExemption: 503 } },
    }],
    ['balance unreadable', { cluster: { fail: { getBalance: 503 } } }],
  ]
  const bare: string[] = []
  const seen = new Set<string>()
  for (const network of ['mainnet', 'testnet'] as const) {
    for (const [name, options] of scenarios) {
      const report = await run({ ...options, network })
      const texts = [
        report.cluster.fix,
        // The other states only name the commands, they do not advise one.
        ...(options.state === 'alpenglow' ? [report.cluster.message] : []),
        ...report.hosts.flatMap((entry) => entry.lines.map((line) => line.fix)),
      ]
      for (const text of texts) {
        for (const match of (text ?? '').matchAll(advised)) {
          seen.add(match[1])
          if (!match[0].includes(`-n ${network}`)) {
            bare.push(`${network}, ${name}: ${match[0]}`)
          }
        }
      }
    }
  }
  assertEquals(bare, [])
  // The scenarios do reach the commands that were advised without -n.
  for (
    const command of [
      'check:alpenglow',
      'gen:vote-account',
      'set:identity',
      'switch',
    ]
  ) {
    assert(seen.has(command), `no scenario advises ${command}`)
  }
})
