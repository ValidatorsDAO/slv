import { assertEquals, assertStringIncludes } from '@std/assert'
import {
  ALPENGLOW_VOTE_WINDOW_SLOTS,
  type Consensus,
  type PrecheckDeps,
  type PrecheckInput,
  RECENT_VOTE_WINDOW_SLOTS,
  runIdentityPrecheck,
  TOWERBFT_VOTE_WINDOW_SLOTS,
  voteWindowSlots,
} from '/lib/identityPrecheck.ts'
import type { InventoryHost } from '/lib/targetGuard.ts'

const IDENTITY = 'Aa'.repeat(22)
const VOTE = 'Cc'.repeat(22)
const SLOT = 400_000_000

const makeHost = (name: string, ansibleHost: string): InventoryHost => ({
  name,
  ansibleHost,
  identityAccount: IDENTITY,
  voteAccount: VOTE,
  ansibleConnection: '',
})

// val-standby is promoted; val-primary and val-third hold the same identity.
const PRIMARY = makeHost('val-primary', '203.0.113.10')
const STANDBY = makeHost('val-standby', '203.0.113.11')
const THIRD = makeHost('val-third', '203.0.113.12')

type Scenario = {
  nodes?: { pubkey: string; gossip: string | null }[]
  votes?: { votePubkey: string; lastVote: number; rootSlot?: number }[]
  peerOutput?: string
}

const stub = (s: Scenario = {}): PrecheckDeps => ({
  fetch: (_url, init) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string }
    const answers: Record<string, unknown> = {
      getClusterNodes: s.nodes ?? [],
      getSlot: SLOT,
      getVoteAccounts: { current: s.votes ?? [], delinquent: [] },
    }
    return Promise.resolve(
      Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: answers[body.method],
      }),
    )
  },
  resolveHost: (host) => Promise.resolve([host]),
  runCapture: () =>
    Promise.resolve({ success: true, output: s.peerOutput ?? '' }),
  playbookPath: '/t/ansible/cmn/read_running_identity.yml',
})

const input = (overrides: Partial<PrecheckInput> = {}): PrecheckInput => ({
  network: 'testnet',
  inventoryType: 'testnet_validators',
  target: STANDBY,
  hosts: [PRIMARY, STANDBY],
  peerDownConfirmed: false,
  ...overrides,
})

const report = (host: string, value: string) =>
  `ok: [${host}] => {\n    "msg": "SLV_RUNNING_IDENTITY ${host} ${value}"\n}`

// --- the old primary named as down ---------------------------------------------

Deno.test('precheck lets the old primary named as down stay unread, and any other unread peer still stops it', async () => {
  const both = report('val-primary', 'unknown') + '\n' +
    report('val-third', 'unknown')
  const hosts = [PRIMARY, STANDBY, THIRD]

  const onlyDown = await runIdentityPrecheck(
    input({ hosts: [PRIMARY, STANDBY], downPeer: 'val-primary' }),
    stub({ peerOutput: report('val-primary', 'unknown') }),
  )
  assertEquals(onlyDown.failures, [])
  assertStringIncludes(
    onlyDown.notes.join('\n'),
    'you confirmed it is stopped',
  )

  const another = await runIdentityPrecheck(
    input({ hosts, downPeer: 'val-primary' }),
    stub({ peerOutput: both }),
  )
  assertEquals(another.ok, false)
  assertStringIncludes(another.failures.join('\n'), 'val-third')
  assertEquals(another.failures.join('\n').includes('val-primary'), false)

  const unnamed = await runIdentityPrecheck(
    input({ hosts: [PRIMARY, STANDBY] }),
    stub({ peerOutput: report('val-primary', 'unknown') }),
  )
  assertEquals(unnamed.ok, false)
})

Deno.test('precheck still stops when the peer named as down answers and runs the identity', async () => {
  const result = await runIdentityPrecheck(
    input({ downPeer: 'val-primary' }),
    stub({ peerOutput: report('val-primary', IDENTITY) }),
  )
  assertEquals(result.ok, false)
  assertStringIncludes(result.failures.join('\n'), 'is running identity')
})

Deno.test('precheck stops the dead-primary failover when the identity is in gossip at the old primary address and the vote account has no vote on record to show it quiet', async () => {
  const result = await runIdentityPrecheck(
    input({ downPeer: 'val-primary' }),
    stub({
      nodes: [{ pubkey: IDENTITY, gossip: '203.0.113.10:8001' }],
      peerOutput: report('val-primary', 'unknown'),
    }),
  )
  assertEquals(result.ok, false)
  assertStringIncludes(
    result.failures.join('\n'),
    'already in gossip at 203.0.113.10',
  )
  assertStringIncludes(result.failures.join('\n'), 'has no vote on record')
  assertEquals('staleAddress' in result, false)
})

// --- the vote window, by consensus ---------------------------------------------

const votedAgo = async (
  age: number,
  consensus: Consensus | undefined,
  extra: { rootSlot?: number } = {},
) =>
  await runIdentityPrecheck(
    input({ hosts: [STANDBY], consensus }),
    stub({
      votes: [{ votePubkey: VOTE, lastVote: SLOT - age, ...extra }],
    }),
  )

Deno.test('the vote window is 150 slots under TowerBFT and 270 under Alpenglow', () => {
  assertEquals(voteWindowSlots('towerbft'), 150)
  assertEquals(voteWindowSlots('alpenglow'), 270)
  assertEquals(TOWERBFT_VOTE_WINDOW_SLOTS, 150)
  assertEquals(ALPENGLOW_VOTE_WINDOW_SLOTS, 270)
  assertEquals(RECENT_VOTE_WINDOW_SLOTS, 150)
})

Deno.test('a vote 150 slots old counts as voting under TowerBFT and a vote 151 slots old does not, which is also the default', async () => {
  for (const consensus of ['towerbft', undefined] as const) {
    const recent = await votedAgo(150, consensus)
    assertEquals(recent.ok, false, String(consensus))
    assertStringIncludes(recent.failures.join('\n'), 'voted 150 slot(s) ago')
    for (const age of [151, 200, 270, 271]) {
      assertEquals(
        (await votedAgo(age, consensus)).failures,
        [],
        `${consensus} age=${age}`,
      )
    }
  }
})

Deno.test('a vote 270 slots old counts as voting under Alpenglow and a vote 271 slots old does not', async () => {
  for (const age of [0, 9, 151, 200, 270]) {
    const result = await votedAgo(age, 'alpenglow')
    assertEquals(result.ok, false, `age=${age}`)
    assertStringIncludes(result.failures.join('\n'), `voted ${age} slot(s) ago`)
  }
  for (const age of [271, 1_000, 47_207, 5_000_000]) {
    assertEquals((await votedAgo(age, 'alpenglow')).failures, [], `age=${age}`)
  }
})

Deno.test('under Alpenglow the vote check reads lastVote and not rootSlot: a vote account that votes with a frozen root counts as voting', async () => {
  const result = await votedAgo(5, 'alpenglow', { rootSlot: SLOT - 8_087 })
  assertEquals(result.ok, false)
  assertStringIncludes(result.failures.join('\n'), 'voted 5 slot(s) ago')
})
