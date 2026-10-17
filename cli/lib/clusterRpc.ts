// The public JSON-RPC of the cluster, as the identity checks ask it.

type RpcNetwork = 'mainnet' | 'testnet'

// Public RPC endpoints, as in registerBlsPubkey.ts.
const RPC_URLS: Record<RpcNetwork, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  testnet: 'https://api.testnet.solana.com',
}

const RPC_TIMEOUT_MS = 20_000

type RpcDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

const rpcRequest = async (
  deps: RpcDeps,
  url: string,
  method: string,
  params?: unknown[],
): Promise<unknown> => {
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
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

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null
    )
    : []

export { asRecords, RPC_TIMEOUT_MS, RPC_URLS, rpcRequest }
export type { RpcDeps, RpcNetwork }
