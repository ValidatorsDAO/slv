import { assertEquals, assertStringIncludes } from '@std/assert'
import { whyNotUnused } from '/lib/secret/unusedPubkey.ts'

const NEW = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5'
const OTHER = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'

type Rpc = {
  nodes?: unknown
  votes?: unknown
  status?: number
  rpcError?: string
  fail?: string
  /** What the cluster of mainnet answers; it answers like an empty cluster when these are absent. */
  mainnetNodes?: unknown
  mainnetVotes?: unknown
  mainnetFail?: string
}

/** A cluster that answers the two questions, and the requests it got. */
const cluster = (rpc: Rpc = {}) => {
  const requests: { url: string; method: string; params: unknown }[] = []
  return {
    requests,
    deps: {
      fetch: (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        requests.push({ url, method: body.method, params: body.params })
        if (url.includes('mainnet')) {
          if (rpc.mainnetFail !== undefined) {
            return Promise.reject(new Error(rpc.mainnetFail))
          }
          const result = body.method === 'getClusterNodes'
            ? rpc.mainnetNodes ?? []
            : rpc.mainnetVotes ?? { current: [], delinquent: [] }
          return Promise.resolve(
            new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
          )
        }
        if (rpc.fail !== undefined) return Promise.reject(new Error(rpc.fail))
        if (rpc.status !== undefined) {
          return Promise.resolve(new Response('', { status: rpc.status }))
        }
        if (rpc.rpcError !== undefined) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                error: { message: rpc.rpcError },
              }),
            ),
          )
        }
        const result = body.method === 'getClusterNodes'
          ? rpc.nodes ?? []
          : rpc.votes ?? { current: [], delinquent: [] }
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
        )
      },
    },
  }
}

Deno.test('a public key that is in no gossip table, no vote account (delinquent unstaked ones included) and no account of the inventory is unused', async () => {
  const fake = cluster({
    nodes: [{ pubkey: OTHER, gossip: '1.2.3.4:8001' }],
    votes: {
      current: [{ nodePubkey: OTHER, votePubkey: OTHER }],
      delinquent: [{ nodePubkey: OTHER, votePubkey: OTHER }],
    },
  })
  assertEquals(await whyNotUnused('testnet', NEW, [OTHER], fake.deps), null)
  // The cluster of the network, and then that of mainnet.
  assertEquals(
    fake.requests.map((request) => [request.url, request.method]),
    [
      ['https://api.testnet.solana.com', 'getClusterNodes'],
      ['https://api.testnet.solana.com', 'getVoteAccounts'],
      ['https://api.mainnet-beta.solana.com', 'getClusterNodes'],
      ['https://api.mainnet-beta.solana.com', 'getVoteAccounts'],
    ],
  )
  // The unstaked delinquent vote accounts are left out unless they are asked for.
  for (const request of [fake.requests[1], fake.requests[3]]) {
    assertEquals(request.params, [
      { keepUnstakedDelinquents: true, commitment: 'confirmed' },
    ])
  }
})

Deno.test('a public key that an inventory account, the gossip table or a vote account names is not unused, and neither is one that cannot be looked up', async () => {
  const cases: [string, string[], Rpc, string][] = [
    ['an account of the inventory', [NEW], {}, 'of the inventory'],
    [
      'the gossip table',
      [],
      { nodes: [{ pubkey: NEW }] },
      'in the gossip table of testnet',
    ],
    [
      'the node key of a current vote account',
      [],
      { votes: { current: [{ nodePubkey: NEW }], delinquent: [] } },
      'a vote account of testnet names',
    ],
    [
      'the vote key of a delinquent vote account',
      [],
      { votes: { current: [], delinquent: [{ votePubkey: NEW }] } },
      'a vote account of testnet names',
    ],
    ['an answer of HTTP 503', [], { status: 503 }, 'HTTP 503'],
    ['an error of the RPC', [], { rpcError: 'rate limited' }, 'rate limited'],
    ['a network that fails', [], { fail: 'ECONNRESET' }, 'ECONNRESET'],
    ['a gossip table that is no list', [], { nodes: { x: 1 } }, 'no list'],
    [
      'vote accounts that are no lists',
      [],
      { votes: { current: 1 } },
      'no vote account lists',
    ],
  ]
  for (const [name, accounts, rpc, expected] of cases) {
    const why = await whyNotUnused('testnet', NEW, accounts, cluster(rpc).deps)
    assertEquals(why !== null, true, name)
    assertStringIncludes(why!, expected)
  }
  // A network without a cluster to ask is a refusal too.
  assertStringIncludes(
    (await whyNotUnused('localnet', NEW, [], cluster().deps))!,
    'no cluster to ask for localnet',
  )
})

Deno.test('a public key that mainnet knows is not new on testnet or devnet: an account of the mainnet inventory, the gossip table of mainnet or a vote account of mainnet names it, and a mainnet that cannot be looked up is a refusal', async () => {
  const cases: [string, string[], Rpc, string][] = [
    [
      'an account of the mainnet inventory',
      [NEW],
      {},
      'identity_account or vote_account of the mainnet inventory',
    ],
    [
      'the gossip table of mainnet',
      [],
      { mainnetNodes: [{ pubkey: NEW }] },
      'in the gossip table of mainnet',
    ],
    [
      'the node key of a vote account of mainnet',
      [],
      { mainnetVotes: { current: [{ nodePubkey: NEW }], delinquent: [] } },
      'a vote account of mainnet names',
    ],
    [
      'the vote key of a delinquent vote account of mainnet',
      [],
      { mainnetVotes: { current: [], delinquent: [{ votePubkey: NEW }] } },
      'a vote account of mainnet names',
    ],
    [
      'a mainnet that fails',
      [],
      { mainnetFail: 'ECONNRESET' },
      'it could not be shown that',
    ],
  ]
  for (const network of ['testnet', 'devnet']) {
    for (const [name, mainnetAccounts, rpc, expected] of cases) {
      const why = await whyNotUnused(
        network,
        NEW,
        [OTHER],
        cluster(rpc).deps,
        mainnetAccounts,
      )
      assertEquals(why !== null, true, `${network}: ${name}`)
      assertStringIncludes(why!, expected)
    }
  }
  // The positive control: the same key is new when mainnet does not know it.
  assertEquals(
    await whyNotUnused('testnet', NEW, [OTHER], cluster().deps, [OTHER]),
    null,
  )
})
