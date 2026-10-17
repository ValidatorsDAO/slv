import { assertEquals, assertStringIncludes } from '@std/assert'
import type { AlpenglowState } from '/lib/alpenglowState.ts'
import {
  type PrecheckDeps,
  type PrecheckInput,
  runIdentityPrecheck,
  runSetIdentity,
  type SetIdentityDeps,
  type SetIdentityOptions,
} from '/lib/identityPrecheck.ts'
import type { InventoryHost } from '/lib/targetGuard.ts'

// agave keeps the ContactInfo of a staked origin for the long CRDS timeout
// (CRDS_GOSSIP_PURGE_DURATION in gossip/src/crds_gossip_pull.rs). So a failover
// from a dead primary meets the identity in gossip at the address of the host
// that is already dead. These tests run the real precheck against a stubbed
// cluster and follow what set:identity gives the playbook.

const IDENTITY = 'Aa'.repeat(22)
const UNSTAKED = 'Bb'.repeat(22)
const OTHER_NODE = 'Ee'.repeat(22)
const VOTE = 'Cc'.repeat(22)
const SLOT = 400_000_000
// The slot of the Alpenglow genesis certificate.
const GENESIS_SLOT = SLOT - 1_000_000
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const isIp = (host: string): boolean =>
  IPV4.test(host) || (host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host))

const makeHost = (
  name: string,
  ansibleHost: string,
  voteAccount = VOTE,
): InventoryHost => ({
  name,
  ansibleHost,
  identityAccount: IDENTITY,
  voteAccount,
  ansibleConnection: '',
})

// val-standby is promoted; val-primary and val-third hold the same identity.
const PRIMARY = makeHost('val-primary', '203.0.113.10')
const STANDBY = makeHost('val-standby', '203.0.113.11')
const THIRD = makeHost('val-third', '203.0.113.12')

const STALE_AT_PRIMARY = { pubkey: IDENTITY, gossip: '203.0.113.10:8001' }
const STALE_AT_THIRD = { pubkey: IDENTITY, gossip: '203.0.113.12:8001' }
const NO_HOST_OF_THE_IDENTITY = {
  pubkey: IDENTITY,
  gossip: '198.51.100.77:8001',
}

type Scenario = {
  nodes?: { pubkey: string; gossip: string | null }[]
  /** Slots since the last vote of the vote account; absent: no vote on record. */
  votedAgo?: number
  /** The node the vote account names: the identity unless set; null names none. */
  voteNode?: string | null
  /** The vote account has no stake and has not voted since: only keepUnstakedDelinquents lists it. */
  unstaked?: boolean
  /** The slot of the genesis certificate; 'none' answers null and 'unreadable' answers HTTP 503. */
  genesisSlot?: number | 'none' | 'unreadable'
  /** The vote account calls (not the gossip call) answer with this HTTP status. */
  voteStatus?: number
  peerOutput?: string
  /** What resolveHost answers for a name; an IP stands for itself, a name not listed has no address. */
  dns?: Record<string, string[]>
}

type Call = { method: string; params: unknown }

const stub = (s: Scenario = {}, calls: Call[] = []): PrecheckDeps => ({
  fetch: (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      id: number
      method: string
      params?: { keepUnstakedDelinquents?: boolean }[]
    }
    calls.push({ method: body.method, params: body.params })
    if (s.voteStatus !== undefined && body.method !== 'getClusterNodes') {
      return Promise.resolve(new Response('', { status: s.voteStatus }))
    }
    if (body.method === 'getAgGenesisCert' && s.genesisSlot === 'unreadable') {
      return Promise.resolve(new Response('', { status: 503 }))
    }
    const node = s.voteNode === undefined ? IDENTITY : s.voteNode
    const entry = s.votedAgo === undefined ? [] : [{
      votePubkey: VOTE,
      lastVote: SLOT - s.votedAgo,
      ...(node === null ? {} : { nodePubkey: node }),
    }]
    // The cluster calls a vote account delinquent after 128 slots.
    const delinquent = (s.votedAgo ?? 0) > 128
    // A vote account with no stake that has not voted is left out, as the
    // cluster leaves it out, unless the call keeps the unstaked delinquent ones.
    const listed = !s.unstaked ||
      body.params?.[0]?.keepUnstakedDelinquents === true
    const answers: Record<string, unknown> = {
      getClusterNodes: s.nodes ?? [],
      getSlot: SLOT,
      getVoteAccounts: {
        current: delinquent || !listed ? [] : entry,
        delinquent: delinquent && listed ? entry : [],
      },
      getAgGenesisCert: s.genesisSlot === 'none' ? null : {
        block: {
          blockId: 'Hq3kJ2',
          slot: s.genesisSlot ?? GENESIS_SLOT,
        },
        signature: '3Xz9',
      },
    }
    return Promise.resolve(
      Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: answers[body.method],
      }),
    )
  },
  resolveHost: (host) =>
    Promise.resolve(s.dns?.[host] ?? (isIp(host) ? [host] : [])),
  runCapture: () =>
    Promise.resolve({ success: true, output: s.peerOutput ?? '' }),
  playbookPath: '/t/ansible/cmn/read_running_identity.yml',
})

const report = (host: string, value: string) =>
  `ok: [${host}] => {\n    "msg": "SLV_RUNNING_IDENTITY ${host} ${value}"\n}`

type Run = {
  playbook: string
  inventoryType: string
  limit: string
  extraVars?: Record<string, string | boolean>
}

/** `slv v set:identity -n testnet -p val-standby` with the real precheck. */
const failover = async (
  options: Omit<SetIdentityOptions, 'network' | 'pubkey'>,
  scenario: Scenario,
  setup: {
    state?: AlpenglowState
    typed?: string
    hosts?: InventoryHost[]
    /** Every JSON-RPC call of the precheck, in order. */
    calls?: Call[]
  } = {},
) => {
  const runs: Run[] = []
  const info: string[] = []
  const errors: string[] = []
  const exitCodes: number[] = []
  const deps: SetIdentityDeps = {
    isTty: () => true,
    readHosts: () => Promise.resolve(setup.hosts ?? [PRIMARY, STANDBY]),
    readState: () =>
      Promise.resolve({
        state: setup.state ?? 'alpenglow',
        detail: 'stubbed',
        marginSlots: 3000,
      }),
    ask: () => Promise.resolve(setup.typed ?? ''),
    precheck: (input: PrecheckInput) =>
      runIdentityPrecheck(input, stub(scenario, setup.calls)),
    confirm: () => Promise.resolve(true),
    runPlaybook: (playbook, inventoryType, limit, extraVars) => {
      runs.push({ playbook, inventoryType, limit, extraVars })
      return Promise.resolve(true)
    },
    templateRoot: () => '/t',
    info: (line) => info.push(line),
    error: (line) => errors.push(line),
    setExitCode: (code) => exitCodes.push(code),
  }
  const went = await runSetIdentity(
    { network: 'testnet', pubkey: 'val-standby', ...options },
    deps,
  )
  return {
    went,
    runs,
    info: info.join('\n'),
    errors: errors.join('\n'),
    exitCodes,
  }
}

const PLAYBOOK = '/t/ansible/testnet-validator/set_identity_key.yml'

// --- the old primary is named as down ---------------------------------------

Deno.test('set:identity --primary-down goes on when the old primary is still in gossip and nothing votes with the identity, and gives the playbook that address', async () => {
  const f = await failover(
    { primaryDown: true },
    {
      nodes: [STALE_AT_PRIMARY],
      votedAgo: 4_000,
      peerOutput: report('val-primary', 'unknown'),
    },
    { typed: 'val-primary' },
  )
  assertEquals(f.errors, '')
  assertEquals(f.went, true)
  assertEquals(f.exitCodes, [])
  assertEquals(f.runs, [{
    playbook: PLAYBOOK,
    inventoryType: 'testnet_validators',
    limit: 'val-standby',
    extraVars: {
      primary_down_confirmed: true,
      primary_down_address: '203.0.113.10',
    },
  }])
  // The operator is told what the entry is, who it belongs to and the vote age.
  assertStringIncludes(
    f.info,
    `identity ${IDENTITY} is in gossip at 203.0.113.10, the stale entry of val-primary (named as stopped with --primary-down)`,
  )
  assertStringIncludes(f.info, 'last voted 4000 slots ago')
  assertStringIncludes(
    f.info,
    'A staked node can stay in gossip for a long time after it stops',
  )
})

Deno.test('set:identity --primary-down refuses the same gossip entry while the vote account is still voting', async () => {
  const f = await failover(
    { primaryDown: true },
    {
      nodes: [STALE_AT_PRIMARY],
      votedAgo: 12,
      peerOutput: report('val-primary', 'unknown'),
    },
    { typed: 'val-primary' },
  )
  assertEquals(f.went, false)
  assertEquals(f.runs, [])
  assertEquals(f.exitCodes, [1])
  assertStringIncludes(f.errors, 'already in gossip at 203.0.113.10')
  assertStringIncludes(f.errors, 'voted 12 slot(s) ago')
  assertStringIncludes(f.errors, 'something still votes with the identity')
})

Deno.test('set:identity refuses an entry of the identity at an address that is no inventory host of it, even with the old primary named as stopped and nothing voting', async () => {
  for (
    const nodes of [
      [NO_HOST_OF_THE_IDENTITY],
      [STALE_AT_PRIMARY, NO_HOST_OF_THE_IDENTITY],
    ]
  ) {
    const f = await failover(
      { primaryDown: true },
      {
        nodes,
        votedAgo: 4_000,
        peerOutput: report('val-primary', 'unknown'),
      },
      { typed: 'val-primary' },
    )
    const name = JSON.stringify(nodes)
    assertEquals(f.went, false, name)
    assertEquals(f.runs, [], name)
    assertEquals(f.exitCodes, [1], name)
    assertStringIncludes(
      f.errors,
      'already in gossip at 198.51.100.77, which is not an inventory host of this identity',
    )
    // It names the hosts that do hold the identity, and where they are.
    assertStringIncludes(f.errors, 'val-primary is at 203.0.113.10')
  }
})

// --- the dead peer is confirmed, or the source reads another identity -------

Deno.test('set:identity --peer-down-confirmed goes on when the dead peer is still in gossip and nothing votes, and the vote window is the one of the consensus', async () => {
  // 200 slots: past the 150 slots of TowerBFT, within the 270 of Alpenglow.
  const scenario = {
    nodes: [STALE_AT_PRIMARY],
    votedAgo: 200,
    peerOutput: report('val-primary', 'unknown'),
  }
  const tower = await failover({ peerDownConfirmed: true }, scenario, {
    state: 'towerbft',
  })
  assertEquals(tower.errors, '')
  assertEquals(tower.went, true)
  assertEquals(tower.runs.map((run) => run.extraVars), [{
    primary_down_address: '203.0.113.10',
  }])
  assertStringIncludes(
    tower.info,
    'the stale entry of val-primary (confirmed stopped with --peer-down-confirmed)',
  )
  assertStringIncludes(tower.info, 'more than the 150 slots of TowerBFT')

  const votor = await failover({ peerDownConfirmed: true }, scenario, {
    state: 'alpenglow',
  })
  assertEquals(votor.went, false)
  assertEquals(votor.runs, [])
  assertStringIncludes(votor.errors, 'within the 270 slots of Alpenglow')
})

Deno.test('set:identity without --peer-down-confirmed or --primary-down still refuses a peer it cannot read that is in gossip', async () => {
  const f = await failover({}, {
    nodes: [STALE_AT_PRIMARY],
    votedAgo: 4_000,
    peerOutput: report('val-primary', 'unknown'),
  })
  assertEquals(f.went, false)
  assertEquals(f.runs, [])
  assertEquals(f.exitCodes, [1])
  assertStringIncludes(f.errors, 'already in gossip at 203.0.113.10')
  assertStringIncludes(f.errors, 'whose running identity could not be read')
})

Deno.test('set:identity goes on when the source reads as running another identity, although its old entry is still in gossip', async () => {
  const f = await failover({}, {
    nodes: [STALE_AT_PRIMARY],
    votedAgo: 4_000,
    peerOutput: report('val-primary', UNSTAKED),
  })
  assertEquals(f.errors, '')
  assertEquals(f.went, true)
  assertEquals(f.runs.map((run) => run.extraVars), [{
    primary_down_address: '203.0.113.10',
  }])
  assertStringIncludes(
    f.info,
    'the stale entry of val-primary (running another identity)',
  )
})

Deno.test('set:identity still refuses an entry at the address of a peer that reads the identity, however old the last vote', async () => {
  const f = await failover({}, {
    nodes: [STALE_AT_PRIMARY],
    votedAgo: 4_000,
    peerOutput: report('val-primary', IDENTITY),
  })
  assertEquals(f.went, false)
  assertEquals(f.runs, [])
  assertStringIncludes(
    f.errors,
    'the address of val-primary, which is running it',
  )
})

// --- the vote window --------------------------------------------------------

Deno.test('a gossip entry is stale from 151 slots since the last vote under TowerBFT and from 271 under Alpenglow', async () => {
  for (
    const [state, voting, quiet] of [
      ['towerbft', 150, 151],
      ['alpenglow', 270, 271],
    ] as const
  ) {
    const scenario = (votedAgo: number) => ({
      nodes: [STALE_AT_PRIMARY],
      votedAgo,
      peerOutput: report('val-primary', UNSTAKED),
    })
    const still = await failover({}, scenario(voting), { state })
    assertEquals(still.went, false, `${state} ${voting}`)
    assertStringIncludes(
      still.errors,
      'something still votes with the identity',
    )
    const stale = await failover({}, scenario(quiet), { state })
    assertEquals(stale.went, true, `${state} ${quiet}`)
    assertEquals(stale.errors, '', `${state} ${quiet}`)
  }
})

Deno.test('a gossip entry is not taken for a stale one when nothing shows the vote account to be quiet', async () => {
  const noVoteAccount = makeHost('val-standby', '203.0.113.11', '')
  const peerOutput = report('val-primary', UNSTAKED)
  const cases: [string, Scenario, InventoryHost[], string][] = [
    [
      'no vote on record',
      { nodes: [STALE_AT_PRIMARY], peerOutput },
      [PRIMARY, STANDBY],
      'has no vote on record, so nothing shows that the entry is stale',
    ],
    [
      'the vote account cannot be read',
      {
        nodes: [STALE_AT_PRIMARY],
        votedAgo: 4_000,
        peerOutput,
        voteStatus: 503,
      },
      [PRIMARY, STANDBY],
      'the vote account could not be read',
    ],
    [
      'the target has no vote_account',
      { nodes: [STALE_AT_PRIMARY], votedAgo: 4_000, peerOutput },
      [PRIMARY, noVoteAccount],
      'val-standby has no vote_account in the inventory, so nothing shows that the entry is stale',
    ],
  ]
  for (const [name, scenario, hosts, message] of cases) {
    const f = await failover({}, scenario, { hosts })
    assertEquals(f.went, false, name)
    assertEquals(f.runs, [], name)
    assertStringIncludes(f.errors, 'already in gossip at 203.0.113.10')
    assertStringIncludes(f.errors, message)
  }
})

Deno.test('a gossip entry is not taken for a stale one when the vote account belongs to another identity or names no node, on TowerBFT and on Alpenglow, with --primary-down and with --peer-down-confirmed', async () => {
  // Its votes, quiet or not, say nothing about whether this identity votes.
  const base = {
    nodes: [STALE_AT_PRIMARY],
    votedAgo: 4_000,
    peerOutput: report('val-primary', 'unknown'),
  }
  for (const state of ['towerbft', 'alpenglow'] as const) {
    for (
      const [flag, options, typed] of [
        ['--primary-down', { primaryDown: true }, 'val-primary'],
        ['--peer-down-confirmed', { peerDownConfirmed: true }, undefined],
      ] as const
    ) {
      for (
        const [voteNode, message] of [
          [OTHER_NODE, `belongs to ${OTHER_NODE}, not to identity ${IDENTITY}`],
          [null, 'does not name a node'],
        ] as const
      ) {
        const name = `${state} ${flag} ${voteNode}`
        const f = await failover(options, { ...base, voteNode }, {
          state,
          typed,
        })
        assertEquals(f.went, false, name)
        assertEquals(f.runs, [], name)
        assertEquals(f.exitCodes, [1], name)
        assertStringIncludes(
          f.errors,
          'already in gossip at 203.0.113.10',
          name,
        )
        assertStringIncludes(f.errors, message, name)
      }
    }
  }
})

// --- comparing addresses ----------------------------------------------------

Deno.test('a peer whose ansible_host is a name is matched by what the name resolves to, and a name that does not resolve is never matched', async () => {
  const named = makeHost('val-primary', 'primary.example.net')
  const base = {
    nodes: [STALE_AT_PRIMARY],
    votedAgo: 4_000,
    peerOutput: report('val-primary', 'unknown'),
  }
  const resolved = await failover(
    { primaryDown: true },
    { ...base, dns: { 'primary.example.net': ['203.0.113.10'] } },
    { hosts: [named, STANDBY], typed: 'val-primary' },
  )
  assertEquals(resolved.errors, '')
  assertEquals(resolved.went, true)
  assertEquals(resolved.runs.map((run) => run.extraVars), [{
    primary_down_confirmed: true,
    primary_down_address: '203.0.113.10',
  }])

  const unresolved = await failover(
    { primaryDown: true },
    base,
    { hosts: [named, STANDBY], typed: 'val-primary' },
  )
  assertEquals(unresolved.went, false)
  assertEquals(unresolved.runs, [])
  assertStringIncludes(
    unresolved.errors,
    'already in gossip at 203.0.113.10, which is not an inventory host of this identity',
  )
  assertStringIncludes(
    unresolved.errors,
    'val-primary: ansible_host primary.example.net does not resolve',
  )

  // An IPv6 address is compared in lower case, as the gossip table gives it.
  const v6 = await failover(
    { primaryDown: true },
    {
      ...base,
      nodes: [{ pubkey: IDENTITY, gossip: '[2001:db8::10]:8001' }],
    },
    {
      hosts: [makeHost('val-primary', '2001:DB8::10'), STANDBY],
      typed: 'val-primary',
    },
  )
  assertEquals(v6.errors, '')
  assertEquals(v6.runs.map((run) => run.extraVars), [{
    primary_down_confirmed: true,
    primary_down_address: '2001:db8::10',
  }])
})

Deno.test('two stale entries at two stopped hosts are refused, because the playbook takes one address', async () => {
  const f = await failover(
    { peerDownConfirmed: true },
    {
      nodes: [STALE_AT_PRIMARY, STALE_AT_THIRD],
      votedAgo: 4_000,
      peerOutput: report('val-primary', 'unknown') + '\n' +
        report('val-third', 'unknown'),
    },
    { hosts: [PRIMARY, STANDBY, THIRD] },
  )
  assertEquals(f.went, false)
  assertEquals(f.runs, [])
  assertEquals(f.exitCodes, [1])
  assertStringIncludes(f.errors, '203.0.113.10 and 203.0.113.12')
  assertStringIncludes(f.errors, 'primary_down_address')
})

// --- what the precheck returns ----------------------------------------------

Deno.test('the precheck reports an allowed stale address only when it is ok, and no primary_down_address goes to the playbook when the identity is not in gossip', async () => {
  const input = (target: InventoryHost, hosts: InventoryHost[]) => ({
    network: 'testnet' as const,
    inventoryType: 'testnet_validators' as const,
    target,
    hosts,
    peerDownConfirmed: false,
    consensus: 'alpenglow' as const,
    downPeer: 'val-primary',
  })
  const stale = await runIdentityPrecheck(
    input(STANDBY, [PRIMARY, STANDBY]),
    stub({
      nodes: [STALE_AT_PRIMARY],
      votedAgo: 4_000,
      peerOutput: report('val-primary', 'unknown'),
    }),
  )
  assertEquals(stale.ok, true)
  assertEquals(stale.staleAddress, '203.0.113.10')

  const voting = await runIdentityPrecheck(
    input(STANDBY, [PRIMARY, STANDBY]),
    stub({
      nodes: [STALE_AT_PRIMARY],
      votedAgo: 3,
      peerOutput: report('val-primary', 'unknown'),
    }),
  )
  assertEquals(voting.ok, false)
  assertEquals('staleAddress' in voting, false)

  // One entry allowed and another refused: the run stops, and no address is offered.
  const mixed = await runIdentityPrecheck(
    input(STANDBY, [PRIMARY, STANDBY]),
    stub({
      nodes: [STALE_AT_PRIMARY, NO_HOST_OF_THE_IDENTITY],
      votedAgo: 4_000,
      peerOutput: report('val-primary', 'unknown'),
    }),
  )
  assertEquals(mixed.ok, false)
  assertEquals('staleAddress' in mixed, false)

  const absent = await runIdentityPrecheck(
    input(STANDBY, [PRIMARY, STANDBY]),
    stub({
      nodes: [],
      votedAgo: 4_000,
      peerOutput: report('val-primary', 'unknown'),
    }),
  )
  assertEquals(absent.ok, true)
  assertEquals('staleAddress' in absent, false)

  const f = await failover(
    { primaryDown: true },
    {
      nodes: [],
      votedAgo: 4_000,
      peerOutput: report('val-primary', 'unknown'),
    },
    { typed: 'val-primary' },
  )
  assertEquals(f.went, true)
  assertEquals(f.runs.map((run) => run.extraVars), [{
    primary_down_confirmed: true,
  }])
})

// --- a first activation on Alpenglow -----------------------------------------
//
// agave asks for the vote history file only when the vote account has voted
// after the slot of the genesis certificate, and the playbook mirrors it. The
// precheck shows the same before the playbook runs.

const ALONE: { hosts: InventoryHost[]; state: AlpenglowState } = {
  hosts: [STANDBY],
  state: 'alpenglow',
}
const TOO_LATE = SLOT - GENESIS_SLOT

Deno.test('set:identity --first-activation on Alpenglow goes on for a vote account that has not voted since the genesis certificate: it voted only before it, at its slot, or never', async () => {
  const cases: [string, Scenario][] = [
    ['voted only before the certificate', { votedAgo: TOO_LATE + 5_000_000 }],
    ['voted at the slot of the certificate', { votedAgo: TOO_LATE }],
    ['a new vote account that has no stake and has not voted', {
      votedAgo: SLOT,
      unstaked: true,
    }],
  ]
  for (const [name, scenario] of cases) {
    const f = await failover(
      { firstActivation: true },
      { nodes: [], ...scenario },
      ALONE,
    )
    assertEquals(f.errors, '', name)
    assertEquals(f.went, true, name)
    assertEquals(f.runs.map((run) => run.extraVars), [{
      first_activation: true,
    }], name)
    assertStringIncludes(f.info, '--first-activation: vote account', name)
  }
})

Deno.test('set:identity --first-activation on Alpenglow is refused when the vote account has voted after the genesis certificate or this cannot be shown, and says what applies', async () => {
  const noVoteAccount = makeHost('val-standby', '203.0.113.11', '')
  const copyIt = [
    'is at slot',
    'after the genesis certificate at slot',
    'so this is not a first activation',
    `copy /mnt/ledger/vote_history-${IDENTITY}.bin to val-standby`,
    'slv v set:identity -n testnet -p val-standby, or',
    'slv v set:identity -n testnet -p val-standby --primary-down',
  ]
  const cases: [string, Scenario, readonly InventoryHost[], string[]][] = [
    [
      'it voted after the certificate, long before the window',
      { votedAgo: TOO_LATE - 500_000 },
      ALONE.hosts,
      copyIt,
    ],
    [
      'it voted one slot after the certificate',
      { votedAgo: TOO_LATE - 1 },
      ALONE.hosts,
      copyIt,
    ],
    [
      'the slot of the certificate cannot be read',
      { votedAgo: TOO_LATE + 5_000_000, genesisSlot: 'unreadable' },
      ALONE.hosts,
      ['could not read the slot of the Alpenglow genesis certificate'],
    ],
    [
      'neither the vote account nor the certificate can be read',
      { votedAgo: TOO_LATE + 5_000_000, voteStatus: 503 },
      ALONE.hosts,
      [
        'could not read the vote account from',
        'could not read the slot of the Alpenglow genesis certificate',
      ],
    ],
    [
      'the cluster returns no certificate',
      { votedAgo: TOO_LATE + 5_000_000, genesisSlot: 'none' },
      ALONE.hosts,
      ['getAgGenesisCert returned no certificate'],
    ],
    [
      'the vote account is not listed, not even with keepUnstakedDelinquents',
      {},
      ALONE.hosts,
      ['is not listed by the cluster'],
    ],
    [
      'the inventory has no vote_account',
      { votedAgo: TOO_LATE + 5_000_000 },
      [noVoteAccount],
      ['has no vote_account in the inventory, so --first-activation'],
    ],
    [
      'an unstaked vote account that names another node',
      { votedAgo: SLOT, unstaked: true, voteNode: OTHER_NODE },
      ALONE.hosts,
      [`belongs to ${OTHER_NODE}, not to identity ${IDENTITY}`],
    ],
  ]
  for (const [name, scenario, hosts, messages] of cases) {
    const f = await failover(
      { firstActivation: true },
      { nodes: [], ...scenario },
      { ...ALONE, hosts: [...hosts] },
    )
    assertEquals(f.went, false, name)
    assertEquals(f.runs, [], name)
    assertEquals(f.exitCodes, [1], name)
    for (const message of messages) {
      assertStringIncludes(f.errors, message, name)
    }
  }
})

Deno.test('set:identity --first-activation skips no check of the precheck: with and without it, on TowerBFT and on Alpenglow, the same entry, peer and vote refuse', async () => {
  const before = TOO_LATE + 5_000_000
  const cases: [
    string,
    Scenario,
    readonly InventoryHost[],
    string,
  ][] = [
    [
      'the identity is in gossip at an address that is no inventory host',
      { nodes: [NO_HOST_OF_THE_IDENTITY], votedAgo: before },
      [STANDBY],
      'which is not an inventory host of this identity',
    ],
    [
      'a peer runs the identity',
      {
        nodes: [],
        votedAgo: before,
        peerOutput: report('val-primary', IDENTITY),
      },
      [PRIMARY, STANDBY],
      'peer val-primary (203.0.113.10) is running identity',
    ],
    [
      'the vote account voted a moment ago and the identity is not at the target',
      { nodes: [], votedAgo: 12 },
      [STANDBY],
      'voted 12 slot(s) ago',
    ],
  ]
  for (const state of ['towerbft', 'alpenglow'] as const) {
    for (const firstActivation of [false, true]) {
      for (const [name, scenario, hosts, message] of cases) {
        const label = `${state} firstActivation=${firstActivation}: ${name}`
        const f = await failover({ firstActivation }, scenario, {
          state,
          hosts: [...hosts],
        })
        assertEquals(f.went, false, label)
        assertEquals(f.runs, [], label)
        assertStringIncludes(f.errors, message, label)
      }
    }
  }
})

Deno.test('the first-activation rule reads the genesis certificate and the unstaked vote accounts on Alpenglow only: TowerBFT reads what it read', async () => {
  const scenario = { nodes: [], votedAgo: TOO_LATE + 5_000_000 }
  const tower: Call[] = []
  await failover({ firstActivation: true }, scenario, {
    hosts: [STANDBY],
    state: 'towerbft',
    calls: tower,
  })
  assertEquals(tower.map((call) => call.method).sort(), [
    'getClusterNodes',
    'getSlot',
    'getVoteAccounts',
  ])
  assertEquals(
    tower.find((call) => call.method === 'getVoteAccounts')?.params,
    [
      { votePubkey: VOTE, commitment: 'confirmed' },
    ],
  )

  const votor: Call[] = []
  await failover({ firstActivation: true }, scenario, {
    hosts: [STANDBY],
    state: 'alpenglow',
    calls: votor,
  })
  assertEquals(votor.map((call) => call.method).sort(), [
    'getAgGenesisCert',
    'getClusterNodes',
    'getSlot',
    'getVoteAccounts',
  ])
  // getAgGenesisCert takes no params, as the playbook sends it.
  assertEquals(
    votor.find((call) => call.method === 'getAgGenesisCert')?.params,
    undefined,
  )
  assertEquals(
    votor.find((call) => call.method === 'getVoteAccounts')?.params,
    [
      {
        votePubkey: VOTE,
        commitment: 'confirmed',
        keepUnstakedDelinquents: true,
      },
    ],
  )

  // Without the flag nothing about the certificate is read, on either.
  const plain: Call[] = []
  await failover({}, scenario, {
    hosts: [STANDBY],
    state: 'alpenglow',
    calls: plain,
  })
  assertEquals(
    plain.some((call) => call.method === 'getAgGenesisCert'),
    false,
  )
})
