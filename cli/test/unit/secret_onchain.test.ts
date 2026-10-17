import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { RPC_URLS } from '/lib/identityPrecheck.ts'
import { checkVoteBinding } from '/lib/secret/onchain.ts'

const IDENTITY = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5'
const OTHER_NODE = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'
const VOTE = 'Vote111111111111111111111111111111111111111'

type Row = { votePubkey: string; nodePubkey?: string; activatedStake?: number }

/** A cluster that answers getVoteAccounts with the given lists, and the requests it got. */
const cluster = (
  reply:
    | { current?: Row[]; delinquent?: Row[] }
    | 'http'
    | 'rpc-error'
    | 'throws'
    | 'no-lists',
) => {
  const requests: { url: string; method: string; params: unknown }[] = []
  return {
    requests,
    deps: {
      fetch: (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        requests.push({ url, method: body.method, params: body.params })
        if (reply === 'throws') return Promise.reject(new Error('ECONNRESET'))
        if (reply === 'http') {
          return Promise.resolve(new Response('', { status: 503 }))
        }
        const result = reply === 'rpc-error'
          ? undefined
          : reply === 'no-lists'
          ? { current: 1 }
          : { current: reply.current ?? [], delinquent: reply.delinquent ?? [] }
        const answer = reply === 'rpc-error'
          ? { jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }
          : { jsonrpc: '2.0', id: 1, result }
        return Promise.resolve(new Response(JSON.stringify(answer)))
      },
    },
  }
}

const input = { identityAccount: IDENTITY, voteAccount: VOTE }

Deno.test('a vote account whose node is not the identity_account of the host is refused on both networks, with both keys named', async () => {
  for (const network of ['testnet', 'mainnet'] as const) {
    const fake = cluster({
      current: [{
        votePubkey: VOTE,
        nodePubkey: OTHER_NODE,
        activatedStake: 5,
      }],
    })
    const result = await checkVoteBinding(network, input, fake.deps)
    assertEquals(result.ok, false, network)
    if (result.ok) continue
    for (const key of [VOTE, OTHER_NODE, IDENTITY]) {
      assertStringIncludes(result.reason, key, network)
    }
  }
})

Deno.test('a vote account without activated stake is refused on mainnet, whichever list it is in or whether the stake is missing', async () => {
  for (
    const reply of [
      {
        current: [{
          votePubkey: VOTE,
          nodePubkey: IDENTITY,
          activatedStake: 0,
        }],
      },
      {
        delinquent: [{
          votePubkey: VOTE,
          nodePubkey: IDENTITY,
          activatedStake: 0,
        }],
      },
      { current: [{ votePubkey: VOTE, nodePubkey: IDENTITY }] },
    ]
  ) {
    const result = await checkVoteBinding('mainnet', input, cluster(reply).deps)
    assertEquals(result.ok, false, JSON.stringify(reply))
    if (!result.ok) assertStringIncludes(result.reason, 'no activated stake')
  }
})

Deno.test('a vote account whose node is the identity_account passes: with stake on mainnet, with none on testnet, and the cluster is asked once about that vote account', async () => {
  const mainnet = cluster({
    current: [
      { votePubkey: OTHER_NODE, nodePubkey: OTHER_NODE, activatedStake: 9 },
      { votePubkey: VOTE, nodePubkey: IDENTITY, activatedStake: 1_000_000 },
    ],
  })
  assertEquals(await checkVoteBinding('mainnet', input, mainnet.deps), {
    ok: true,
    nodePubkey: IDENTITY,
    activatedStake: 1_000_000,
  })
  assertEquals(mainnet.requests, [{
    url: RPC_URLS.mainnet,
    method: 'getVoteAccounts',
    params: [{
      votePubkey: VOTE,
      commitment: 'confirmed',
      keepUnstakedDelinquents: true,
    }],
  }])

  const testnet = cluster({
    delinquent: [{ votePubkey: VOTE, nodePubkey: IDENTITY, activatedStake: 0 }],
  })
  const result = await checkVoteBinding('testnet', input, testnet.deps)
  assertEquals(result.ok, true)
  assertEquals(testnet.requests.map((request) => request.url), [
    RPC_URLS.testnet,
  ])
})

Deno.test('an answer that is not plain is a refusal: a vote account that is not listed, an error or no answer of the cluster, lists that are missing, two nodes for one vote account, and a host without a vote_account or identity_account', async () => {
  const cases: [string, Parameters<typeof cluster>[0], string][] = [
    ['not listed', {
      current: [{ votePubkey: OTHER_NODE, nodePubkey: OTHER_NODE }],
    }, 'not a vote account that testnet lists'],
    ['HTTP 503', 'http', 'HTTP 503'],
    ['an error of the RPC', 'rpc-error', 'rate limited'],
    ['a network that fails', 'throws', 'ECONNRESET'],
    ['no lists', 'no-lists', 'no vote account lists'],
    [
      'two nodes',
      {
        current: [{ votePubkey: VOTE, nodePubkey: IDENTITY }],
        delinquent: [{ votePubkey: VOTE, nodePubkey: OTHER_NODE }],
      },
      'no single node',
    ],
    [
      'no node',
      { current: [{ votePubkey: VOTE }] },
      'no single node',
    ],
  ]
  for (const [name, reply, expected] of cases) {
    const result = await checkVoteBinding('testnet', input, cluster(reply).deps)
    assertEquals(result.ok, false, name)
    if (!result.ok) assertStringIncludes(result.reason, expected, name)
  }
  for (
    const missing of [
      { identityAccount: IDENTITY, voteAccount: '' },
      { identityAccount: '', voteAccount: VOTE },
      { identityAccount: 'nope', voteAccount: VOTE },
    ]
  ) {
    const fake = cluster({ current: [] })
    const result = await checkVoteBinding('testnet', missing, fake.deps)
    assertEquals(result.ok, false, JSON.stringify(missing))
    assert(fake.requests.length === 0, 'the cluster was asked about nothing')
  }
})
