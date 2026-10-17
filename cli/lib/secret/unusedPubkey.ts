// A key that is to be tried on a node has to be new: not running anywhere, with
// no vote account, and not an account of the inventory. Anything that cannot be
// shown is a refusal.

type UnusedDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

const RPC_URLS: Record<string, string> = {
  testnet: 'https://api.testnet.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

const rpc = async (
  deps: UnusedDeps,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> => {
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}`)
  }
  const body = await response.json() as {
    result?: unknown
    error?: { message?: string }
  }
  if (body.error) {
    throw new Error(
      `${method} failed: ${body.error.message ?? 'unknown error'}`,
    )
  }
  if (body.result === undefined) throw new Error(`${method} returned no result`)
  return body.result
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null
    )
    : []

/**
 * Why `pubkey` is not new, or cannot be shown to be, or null when it is new:
 * it is an account of the inventory, it is in the gossip table, or a vote
 * account names it (the vote accounts are asked for with the unstaked delinquent
 * ones, which are left out by default).
 */
const whyNotUnused = async (
  network: string,
  pubkey: string,
  inventoryAccounts: readonly string[],
  deps: UnusedDeps,
): Promise<string | null> => {
  if (inventoryAccounts.includes(pubkey)) {
    return `${pubkey} is an identity_account or vote_account of the inventory`
  }
  const url = RPC_URLS[network]
  if (url === undefined) return `there is no cluster to ask for ${network}`
  try {
    const nodes = await rpc(deps, url, 'getClusterNodes', [])
    if (!Array.isArray(nodes)) {
      throw new Error('getClusterNodes returned no list')
    }
    if (records(nodes).some((node) => node.pubkey === pubkey)) {
      return `${pubkey} is in the gossip table of ${network}`
    }
    const votes = await rpc(deps, url, 'getVoteAccounts', [{
      keepUnstakedDelinquents: true,
      commitment: 'confirmed',
    }]) as { current?: unknown; delinquent?: unknown }
    if (
      typeof votes !== 'object' || votes === null ||
      !Array.isArray(votes.current) || !Array.isArray(votes.delinquent)
    ) {
      throw new Error('getVoteAccounts returned no vote account lists')
    }
    if (
      [...records(votes.current), ...records(votes.delinquent)].some((vote) =>
        vote.nodePubkey === pubkey || vote.votePubkey === pubkey
      )
    ) {
      return `a vote account of ${network} names ${pubkey}`
    }
  } catch (error) {
    return `it could not be shown that ${pubkey} is unused: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  return null
}

export { RPC_URLS, whyNotUnused }
export type { UnusedDeps }
