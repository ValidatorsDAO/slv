import type { AlpenglowReading, AlpenglowState } from '/lib/alpenglowState.ts'
import type {
  READ_ONLY_METHODS,
  ReadinessHost,
} from '/lib/alpenglowReadiness.ts'

// slv overhaul: Alpenglow. A stubbed cluster for the tests of `slv v check:alpenglow`.

export const IDENTITY = 'Aa'.repeat(22)
export const OTHER_VOTER = 'Bb'.repeat(22)
export const VOTE = 'Cc'.repeat(22)
export const BLS = 'Dd'.repeat(33)
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111'
export const RENT_EXEMPT = 19_761_200
export const SOL = 1_000_000_000

export const HOST: ReadinessHost = {
  name: 'val-1',
  ansibleHost: '203.0.113.10',
  identityAccount: IDENTITY,
  voteAccount: VOTE,
  validatorType: 'jito',
}

export const reading = (state: AlpenglowState): AlpenglowReading => ({
  state,
  detail: `getAgGenesisCert: ${state}`,
  marginSlots: 3000,
})

// --- a stubbed cluster ----------------------------------------------------------

export type VoteFixture = {
  /** The node the vote account names; the identity by default. */
  node?: string
  lamports?: number
  bls?: string | null
  /** [epoch, authorized voter] */
  voters?: [number, string][]
  space?: number
  owner?: string
}

export const voteResult = (fixture: VoteFixture) => ({
  context: { slot: 1 },
  value: {
    owner: fixture.owner ?? VOTE_PROGRAM,
    lamports: fixture.lamports ?? RENT_EXEMPT + 10 * SOL,
    space: fixture.space ?? 3762,
    executable: false,
    data: {
      program: 'vote',
      space: fixture.space ?? 3762,
      parsed: {
        type: 'vote',
        info: {
          nodePubkey: fixture.node ?? IDENTITY,
          authorizedVoters:
            (fixture.voters ?? [[1058, IDENTITY], [1059, IDENTITY]])
              .map(([epoch, authorizedVoter]) => ({ epoch, authorizedVoter })),
          blsPubkeyCompressed: fixture.bls === undefined ? BLS : fixture.bls,
        },
      },
    },
  },
})

export type Cluster = {
  /** The answer for each vote account address; `null` is an account that does not exist. */
  votes?: Record<string, VoteFixture | null>
  /** The balance of each system account. */
  balances?: Record<string, number>
  epoch?: number
  rentExempt?: number
  /**
   * The gossip table. By default the identity of HOST gossips from the address
   * of HOST with the version of the network (4.3.2 on mainnet, 4.4.0-beta.1 on
   * testnet).
   */
  nodes?: { pubkey: string; gossip?: string | null; version?: string | null }[]
  /** HTTP status for a method, in place of an answer. */
  fail?: Partial<Record<(typeof READ_ONLY_METHODS)[number], number>>
}

export const cluster = (setup: Cluster = {}) => {
  const calls: { url: string; method: string; params: unknown[] }[] = []
  const sleeps: number[] = []
  const deps = {
    fetch: (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        method: keyof NonNullable<Cluster['fail']>
        params: unknown[]
      }
      calls.push({ url, method: body.method, params: body.params })
      const status = setup.fail?.[body.method]
      if (status) return Promise.resolve(new Response('no', { status }))
      let result: unknown
      if (body.method === 'getEpochInfo') {
        result = {
          epoch: setup.epoch ?? 1059,
          slotIndex: 1,
          slotsInEpoch: 432000,
        }
      } else if (body.method === 'getMinimumBalanceForRentExemption') {
        result = setup.rentExempt ?? RENT_EXEMPT
      } else if (body.method === 'getBalance') {
        const address = String(body.params[0])
        result = {
          context: { slot: 1 },
          value: setup.balances?.[address] ?? 5 * SOL,
        }
      } else if (body.method === 'getClusterNodes') {
        const version = url.includes('testnet') ? '4.4.0-beta.1' : '4.3.2'
        result = (setup.nodes ??
          [{ pubkey: IDENTITY, gossip: '203.0.113.10:8001', version }]).map((
            node,
          ) => ({
            featureSet: 1,
            shredVersion: 1,
            gossip: null,
            version: null,
            ...node,
          }))
      } else if (body.method === 'getAccountInfo') {
        const address = String(body.params[0])
        const fixture = setup.votes && address in setup.votes
          ? setup.votes[address]
          : {}
        result = fixture === null
          ? { context: { slot: 1 }, value: null }
          : voteResult(fixture ?? {})
      } else {
        result = null
      }
      return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result }))
    },
    sleep: (ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    /** An address stands for itself, localhost for the loopback, any other name for nothing. */
    resolveHost: (host: string) =>
      Promise.resolve(
        /^[0-9.]+$/.test(host)
          ? [host]
          : host === 'localhost'
          ? ['127.0.0.1', '::1']
          : [],
      ),
  }
  return { calls, sleeps, deps }
}
