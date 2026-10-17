import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import type { InventoryHost } from '/lib/targetGuard.ts'
import {
  parseGossipIp,
  parseRunningIdentityLines,
  type PrecheckDeps,
  type PrecheckInput,
  RECENT_VOTE_WINDOW_SLOTS,
  resolveHostAddresses,
  runIdentityPrecheck,
} from '/lib/identityPrecheck.ts'

const IDENTITY = 'Aa'.repeat(22)
const OTHER_IDENTITY = 'Bb'.repeat(22)
const VOTE = 'Cc'.repeat(22)
const SLOT = 400_000_000

const makeHost = (
  name: string,
  ansibleHost: string,
  identityAccount: string,
  extra: Partial<InventoryHost> = {},
): InventoryHost => ({
  name,
  ansibleHost,
  identityAccount,
  voteAccount: VOTE,
  ansibleConnection: '',
  ...extra,
})

const TARGET = makeHost('val-a', '203.0.113.10', IDENTITY)
const PEER = makeHost('val-b', '203.0.113.11', IDENTITY)
const UNRELATED = makeHost('val-c', '203.0.113.12', OTHER_IDENTITY)

type Node = { pubkey: string; gossip: string | null }
type Vote = { votePubkey: string; lastVote: number; nodePubkey?: string }

type Scenario = {
  nodes?: Node[]
  current?: Vote[]
  delinquent?: Vote[]
  slot?: number
  failMethods?: string[]
  httpStatus?: number
  peerOutput?: string
  peerSuccess?: boolean
  peerThrows?: boolean
  resolve?: Record<string, string[]>
}

type Recorded = {
  deps: PrecheckDeps
  rpc: { url: string; method: string; params: unknown[] }[]
  runs: { playbook: string; inventoryType: string; limit: string }[]
  resolved: string[]
}

const scenario = (s: Scenario = {}): Recorded => {
  const rec: Recorded = {
    deps: undefined as unknown as PrecheckDeps,
    rpc: [],
    runs: [],
    resolved: [],
  }
  rec.deps = {
    fetch: (url, init) => {
      const body = JSON.parse(String(init.body)) as {
        id: number
        method: string
        params: unknown[]
      }
      rec.rpc.push({ url, method: body.method, params: body.params })
      if (s.httpStatus) {
        return Promise.resolve(
          new Response('rate limited', { status: s.httpStatus }),
        )
      }
      if (s.failMethods?.includes(body.method)) {
        return Promise.resolve(
          Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32005, message: 'node is unhealthy' },
          }),
        )
      }
      let result: unknown
      if (body.method === 'getClusterNodes') result = s.nodes ?? []
      else if (body.method === 'getSlot') result = s.slot ?? SLOT
      else if (body.method === 'getVoteAccounts') {
        // A vote account names the node it belongs to: the identity, unless a row says otherwise.
        const named = (vote: Vote) => ({ nodePubkey: IDENTITY, ...vote })
        result = {
          current: (s.current ?? []).map(named),
          delinquent: (s.delinquent ?? []).map(named),
        }
      } else {
        return Promise.resolve(
          Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        )
      }
      return Promise.resolve(
        Response.json({ jsonrpc: '2.0', id: body.id, result }),
      )
    },
    resolveHost: (host) => {
      rec.resolved.push(host)
      return Promise.resolve(s.resolve?.[host] ?? [host])
    },
    runCapture: (playbook, inventoryType, limit) => {
      rec.runs.push({ playbook, inventoryType, limit })
      if (s.peerThrows) return Promise.reject(new Error('ansible exploded'))
      return Promise.resolve({
        success: s.peerSuccess ?? true,
        output: s.peerOutput ?? '',
      })
    },
    playbookPath: '/t/ansible/cmn/read_running_identity.yml',
  }
  return rec
}

const input = (
  overrides: Partial<PrecheckInput> = {},
): PrecheckInput => ({
  network: 'testnet',
  inventoryType: 'testnet_validators',
  target: TARGET,
  hosts: [TARGET, UNRELATED],
  peerDownConfirmed: false,
  ...overrides,
})

const peerLine = (host: string, value: string) =>
  `ok: [${host}] => {\n    "msg": "SLV_RUNNING_IDENTITY ${host} ${value}"\n}`

// --- cluster view -----------------------------------------------------------

Deno.test('precheck passes when the identity is absent from gossip, the vote account is quiet and no peer exists', async () => {
  const rec = scenario({
    nodes: [{ pubkey: OTHER_IDENTITY, gossip: '198.51.100.1:8001' }],
    current: [{ votePubkey: VOTE, lastVote: SLOT - 5_000 }],
  })
  const result = await runIdentityPrecheck(input(), rec.deps)
  assertEquals(result.failures, [])
  assertEquals(result.ok, true)
  assertEquals(rec.runs, [])
  assertEquals(
    rec.rpc.map((c) => c.method).sort(),
    ['getClusterNodes', 'getSlot', 'getVoteAccounts'],
  )
  assert(rec.rpc.every((c) => c.url === 'https://api.testnet.solana.com'))
})

Deno.test('precheck reads the mainnet public RPC for a mainnet promotion', async () => {
  const rec = scenario()
  await runIdentityPrecheck(
    input({ network: 'mainnet', inventoryType: 'mainnet_validators' }),
    rec.deps,
  )
  assert(rec.rpc.length > 0)
  assert(
    rec.rpc.every((c) => c.url === 'https://api.mainnet-beta.solana.com'),
  )
})

Deno.test('precheck asks only for the target vote account', async () => {
  const rec = scenario()
  await runIdentityPrecheck(input(), rec.deps)
  const votes = rec.rpc.find((c) => c.method === 'getVoteAccounts')
  assertEquals((votes?.params[0] as { votePubkey: string }).votePubkey, VOTE)
})

Deno.test('precheck passes when the identity is already in gossip at the target and the vote account is live', async () => {
  const rec = scenario({
    nodes: [{ pubkey: IDENTITY, gossip: '203.0.113.10:8001' }],
    current: [{ votePubkey: VOTE, lastVote: SLOT - 10 }],
  })
  const result = await runIdentityPrecheck(input(), rec.deps)
  assertEquals(result.failures, [])
})

Deno.test('precheck refuses when the cluster shows the identity at another address', async () => {
  const rec = scenario({
    nodes: [{ pubkey: IDENTITY, gossip: '198.51.100.7:8001' }],
  })
  const result = await runIdentityPrecheck(input(), rec.deps)
  assertEquals(result.ok, false)
  assertStringIncludes(result.failures.join('\n'), '198.51.100.7')
})

Deno.test('precheck refuses when any gossip entry of the identity is not at the target', async () => {
  const rec = scenario({
    nodes: [
      { pubkey: IDENTITY, gossip: '203.0.113.10:8001' },
      { pubkey: IDENTITY, gossip: '198.51.100.7:8001' },
    ],
  })
  const result = await runIdentityPrecheck(input(), rec.deps)
  assertEquals(result.ok, false)
})

Deno.test('precheck refuses when the identity is in gossip without an address', async () => {
  const rec = scenario({ nodes: [{ pubkey: IDENTITY, gossip: null }] })
  const result = await runIdentityPrecheck(input(), rec.deps)
  assertEquals(result.ok, false)
})

Deno.test('precheck refuses when the vote account voted within 150 slots and the identity is not at the target', async () => {
  assertEquals(RECENT_VOTE_WINDOW_SLOTS, 150)
  for (const age of [0, 1, 100, 150]) {
    const rec = scenario({
      current: [{ votePubkey: VOTE, lastVote: SLOT - age }],
    })
    const result = await runIdentityPrecheck(input(), rec.deps)
    assertEquals(result.ok, false, `age=${age}`)
    assertStringIncludes(result.failures.join('\n'), 'voted')
  }
})

Deno.test('precheck counts a delinquent vote account that voted recently', async () => {
  const rec = scenario({
    delinquent: [{ votePubkey: VOTE, lastVote: SLOT - 140 }],
  })
  const result = await runIdentityPrecheck(input(), rec.deps)
  assertEquals(result.ok, false)
})

Deno.test('precheck passes when the last vote is older than 150 slots', async () => {
  for (const age of [151, 1_000, 5_000_000]) {
    const rec = scenario({
      current: [{ votePubkey: VOTE, lastVote: SLOT - age }],
    })
    const result = await runIdentityPrecheck(input(), rec.deps)
    assertEquals(result.failures, [], `age=${age}`)
  }
})

Deno.test('precheck ignores votes of other vote accounts', async () => {
  const rec = scenario({
    current: [{ votePubkey: OTHER_IDENTITY, lastVote: SLOT - 1 }],
  })
  assertEquals((await runIdentityPrecheck(input(), rec.deps)).failures, [])
})

Deno.test('precheck notes the missing vote account and still checks gossip', async () => {
  const rec = scenario({
    nodes: [{ pubkey: IDENTITY, gossip: '198.51.100.7:8001' }],
  })
  const result = await runIdentityPrecheck(
    input({ target: { ...TARGET, voteAccount: '' } }),
    rec.deps,
  )
  assertEquals(result.ok, false)
  assertEquals(rec.rpc.some((c) => c.method === 'getVoteAccounts'), false)

  const quiet = scenario()
  const passed = await runIdentityPrecheck(
    input({ target: { ...TARGET, voteAccount: '' } }),
    quiet.deps,
  )
  assertEquals(passed.failures, [])
  assertStringIncludes(passed.notes.join('\n'), 'vote_account')
})

Deno.test('precheck fails closed when the public RPC cannot answer', async () => {
  for (const method of ['getClusterNodes', 'getSlot', 'getVoteAccounts']) {
    const rec = scenario({ failMethods: [method] })
    const result = await runIdentityPrecheck(input(), rec.deps)
    assertEquals(result.ok, false, method)
    assertStringIncludes(result.failures.join('\n'), method)
  }
  const limited = scenario({ httpStatus: 429 })
  const result = await runIdentityPrecheck(input(), limited.deps)
  assertEquals(result.ok, false)
  assertStringIncludes(result.failures.join('\n'), '429')
})

Deno.test('precheck compares against every address a hostname resolves to', async () => {
  const named = { ...TARGET, ansibleHost: 'val-a.example.net' }
  const at = scenario({
    nodes: [{ pubkey: IDENTITY, gossip: '203.0.113.10:8001' }],
    resolve: { 'val-a.example.net': ['203.0.113.99', '203.0.113.10'] },
  })
  assertEquals(
    (await runIdentityPrecheck(input({ target: named }), at.deps)).failures,
    [],
  )
  assertEquals(at.resolved.includes('val-a.example.net'), true)

  const elsewhere = scenario({
    nodes: [{ pubkey: IDENTITY, gossip: '198.51.100.7:8001' }],
    resolve: { 'val-a.example.net': ['203.0.113.10'] },
  })
  assertEquals(
    (await runIdentityPrecheck(input({ target: named }), elsewhere.deps)).ok,
    false,
  )
})

Deno.test('precheck refuses when the target address cannot be compared with gossip', async () => {
  const cases: InventoryHost[] = [
    { ...TARGET, ansibleHost: 'nowhere.example.net' },
    { ...TARGET, ansibleHost: 'localhost', ansibleConnection: 'local' },
    { ...TARGET, ansibleHost: '127.0.0.1' },
  ]
  for (const target of cases) {
    const rec = scenario({
      resolve: { 'nowhere.example.net': [], localhost: ['127.0.0.1'] },
    })
    const result = await runIdentityPrecheck(input({ target }), rec.deps)
    assertEquals(result.ok, false, target.ansibleHost)
  }
})

Deno.test('parseGossipIp reads the address out of ip:port forms', () => {
  assertEquals(parseGossipIp('203.0.113.10:8001'), '203.0.113.10')
  assertEquals(parseGossipIp('203.0.113.10'), '203.0.113.10')
  assertEquals(parseGossipIp('[2001:db8::1]:8001'), '2001:db8::1')
  assertEquals(parseGossipIp(null), null)
  assertEquals(parseGossipIp(''), null)
  assertEquals(parseGossipIp(undefined), null)
})

Deno.test('resolveHostAddresses returns IP literals and localhost without a DNS lookup', async () => {
  assertEquals(await resolveHostAddresses('203.0.113.10'), ['203.0.113.10'])
  assertEquals(await resolveHostAddresses('2001:DB8::1'), ['2001:db8::1'])
  const local = await resolveHostAddresses('localhost')
  assert(local.includes('127.0.0.1'))
})

// --- peer view -------------------------------------------------------------

const withPeer = (overrides: Partial<PrecheckInput> = {}) =>
  input({ hosts: [TARGET, PEER, UNRELATED], ...overrides })

Deno.test('precheck refuses when a peer reports the identity', async () => {
  const rec = scenario({ peerOutput: peerLine('val-b', IDENTITY) })
  const result = await runIdentityPrecheck(withPeer(), rec.deps)
  assertEquals(result.ok, false)
  assertStringIncludes(result.failures.join('\n'), 'val-b')
  assertEquals(rec.runs, [{
    playbook: '/t/ansible/cmn/read_running_identity.yml',
    inventoryType: 'testnet_validators',
    limit: 'val-b',
  }])
})

Deno.test('precheck still refuses a peer that reports the identity when peer-down is confirmed', async () => {
  const rec = scenario({ peerOutput: peerLine('val-b', IDENTITY) })
  const result = await runIdentityPrecheck(
    withPeer({ peerDownConfirmed: true }),
    rec.deps,
  )
  assertEquals(result.ok, false)
})

Deno.test('precheck refuses when a peer reports unknown, unless peer-down is confirmed', async () => {
  const output = peerLine('val-b', 'unknown')
  const refused = await runIdentityPrecheck(
    withPeer(),
    scenario({ peerOutput: output }).deps,
  )
  assertEquals(refused.ok, false)
  assertStringIncludes(refused.failures.join('\n'), '--peer-down-confirmed')

  const allowed = await runIdentityPrecheck(
    withPeer({ peerDownConfirmed: true }),
    scenario({ peerOutput: output }).deps,
  )
  assertEquals(allowed.failures, [])
  assertStringIncludes(allowed.notes.join('\n'), 'val-b')
})

Deno.test('precheck treats a peer that printed no line as unknown', async () => {
  for (const peerSuccess of [true, false]) {
    const refused = await runIdentityPrecheck(
      withPeer(),
      scenario({ peerOutput: 'UNREACHABLE! val-b', peerSuccess }).deps,
    )
    assertEquals(refused.ok, false, `success=${peerSuccess}`)
    const allowed = await runIdentityPrecheck(
      withPeer({ peerDownConfirmed: true }),
      scenario({ peerOutput: '', peerSuccess }).deps,
    )
    assertEquals(allowed.failures, [], `success=${peerSuccess}`)
  }
})

Deno.test('precheck treats an ansible run that throws as no answer from the peers', async () => {
  const refused = await runIdentityPrecheck(
    withPeer(),
    scenario({ peerThrows: true }).deps,
  )
  assertEquals(refused.ok, false)
})

Deno.test('precheck passes when every peer runs a different identity', async () => {
  const rec = scenario({ peerOutput: peerLine('val-b', OTHER_IDENTITY) })
  const result = await runIdentityPrecheck(withPeer(), rec.deps)
  assertEquals(result.failures, [])
})

Deno.test('precheck reads all peers in one run limited to exactly those hosts', async () => {
  const second = makeHost('val-d', '203.0.113.13', IDENTITY)
  const rec = scenario({
    peerOutput: [
      peerLine('val-b', OTHER_IDENTITY),
      peerLine('val-d', OTHER_IDENTITY),
    ].join('\n'),
  })
  const result = await runIdentityPrecheck(
    input({ hosts: [TARGET, PEER, UNRELATED, second] }),
    rec.deps,
  )
  assertEquals(result.failures, [])
  assertEquals(rec.runs.length, 1)
  assertEquals(rec.runs[0].limit, 'val-b,val-d')
})

Deno.test('precheck does not run the peer playbook when nobody else holds the identity', async () => {
  const rec = scenario()
  await runIdentityPrecheck(input({ hosts: [TARGET, UNRELATED] }), rec.deps)
  assertEquals(rec.runs, [])
})

Deno.test('precheck reports the cluster failure and the peer failure together', async () => {
  const rec = scenario({
    nodes: [{ pubkey: IDENTITY, gossip: '198.51.100.7:8001' }],
    peerOutput: peerLine('val-b', IDENTITY),
  })
  const result = await runIdentityPrecheck(withPeer(), rec.deps)
  assertEquals(result.failures.length >= 2, true)
})

Deno.test('precheck refuses a target without an identity account', async () => {
  const rec = scenario()
  const result = await runIdentityPrecheck(
    input({ target: { ...TARGET, identityAccount: '' } }),
    rec.deps,
  )
  assertEquals(result.ok, false)
  assertEquals(rec.rpc, [])
})

// --- parsing of the peer playbook output ---------------------------------

Deno.test('parseRunningIdentityLines reads plain lines and ansible debug output', () => {
  const output = [
    `SLV_RUNNING_IDENTITY val-b ${IDENTITY}`,
    peerLine('val-c', 'unknown'),
    `    "msg": "SLV_RUNNING_IDENTITY val-d ${OTHER_IDENTITY}\\nSLV_RUNNING_IDENTITY val-e unknown"`,
  ].join('\n')
  const parsed = parseRunningIdentityLines(output)
  assertEquals(parsed.get('val-b'), [IDENTITY])
  assertEquals(parsed.get('val-c'), ['unknown'])
  assertEquals(parsed.get('val-d'), [OTHER_IDENTITY])
  assertEquals(parsed.get('val-e'), ['unknown'])
})

Deno.test('parseRunningIdentityLines ignores text that is not a well-formed line', () => {
  const output = [
    'TASK [Print SLV_RUNNING_IDENTITY line] ***********',
    'SLV_RUNNING_IDENTITY val-b',
    `SLV_RUNNING_IDENTITY val-c ${IDENTITY}${IDENTITY}`,
    'SLV_RUNNING_IDENTITY val-d not-a-key',
  ].join('\n')
  assertEquals(parseRunningIdentityLines(output).size, 0)
})
