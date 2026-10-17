import {
  asRecords,
  RPC_TIMEOUT_MS,
  RPC_URLS,
  rpcRequest,
} from '/lib/identityPrecheck.ts'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'

// What the cluster says about the vote account of a host, held against the
// identity_account of its inventory entry before a key is read.

type OnchainNetwork = 'mainnet' | 'testnet'

type OnchainDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

type VoteBinding =
  | { ok: true; nodePubkey: string; activatedStake: number }
  | { ok: false; reason: string }

const defaultOnchainDeps = (): OnchainDeps => ({
  fetch: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
})

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The node of the vote account has to be the identity_account of the host, on
 * both networks, and on mainnet the vote account has to have activated stake.
 * Whatever the cluster does not answer plainly is a refusal.
 */
const checkVoteBinding = async (
  network: OnchainNetwork,
  input: { identityAccount: string; voteAccount: string },
  deps: OnchainDeps = defaultOnchainDeps(),
): Promise<VoteBinding> => {
  const { identityAccount, voteAccount } = input
  const refuse = (reason: string): VoteBinding => ({ ok: false, reason })
  if (!BASE58_PUBKEY.test(identityAccount)) {
    return refuse('the host has no identity_account')
  }
  if (!BASE58_PUBKEY.test(voteAccount)) {
    return refuse('the host has no vote_account')
  }

  let votes: unknown
  try {
    // The unstaked delinquent vote accounts are left out unless they are asked for.
    votes = await rpcRequest(deps, RPC_URLS[network], 'getVoteAccounts', [{
      votePubkey: voteAccount,
      commitment: 'confirmed',
      keepUnstakedDelinquents: true,
    }])
  } catch (error) {
    return refuse(
      `the vote account ${voteAccount} could not be read on ${network}: ${
        describe(error)
      }`,
    )
  }
  const lists = votes as { current?: unknown; delinquent?: unknown } | null
  if (
    typeof lists !== 'object' || lists === null ||
    !Array.isArray(lists.current) || !Array.isArray(lists.delinquent)
  ) {
    return refuse('getVoteAccounts returned no vote account lists')
  }
  const rows = [...asRecords(lists.current), ...asRecords(lists.delinquent)]
    .filter((vote) => vote.votePubkey === voteAccount)
  if (rows.length === 0) {
    return refuse(
      `${voteAccount} is not a vote account that ${network} lists, so its node cannot be checked`,
    )
  }
  const nodes = new Set(
    rows.map((vote) =>
      typeof vote.nodePubkey === 'string' ? vote.nodePubkey : ''
    ),
  )
  const nodePubkey = nodes.size === 1 ? [...nodes][0] : ''
  if (nodePubkey === '') {
    return refuse(
      `${network} names no single node for the vote account ${voteAccount}`,
    )
  }
  if (nodePubkey !== identityAccount) {
    return refuse(
      `the node of the vote account ${voteAccount} is ${nodePubkey}, not the identity_account ${identityAccount} of the host`,
    )
  }

  const stake = rows[0].activatedStake
  const activatedStake = typeof stake === 'number' ? stake : Number.NaN
  if (network === 'mainnet' && !(activatedStake > 0)) {
    return refuse(
      `the vote account ${voteAccount} has no activated stake on mainnet`,
    )
  }
  return {
    ok: true,
    nodePubkey,
    activatedStake: Number.isNaN(activatedStake) ? 0 : activatedStake,
  }
}

export { checkVoteBinding, defaultOnchainDeps }
export type { OnchainDeps, OnchainNetwork, VoteBinding }
