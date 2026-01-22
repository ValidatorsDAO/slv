export { SolanaNodeTypes } from '../types/config.ts'
export type { SolanaNodeType } from '../types/config.ts'

export const LOCAL_DB_URL = 'mysql://solv:solvLocal@127.0.0.1:4000/slv_api'
export const compileTargets = [
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
]

export const NETWORK = ['mainnet', 'testnet', 'devnet'] as const

export const getOSTarget = () => {
  const os = Deno.build.os
  if (os === 'darwin') {
    return 'x86_64-apple-darwin'
  }
  if (os === 'linux') {
    return 'x86_64-unknown-linux-gnu'
  }
  return 'x86_64-unknown-linux-gnu'
}

export const DEFAULT_COMMISSION_RATE = 5 // 5%

export const JITO_BLOCK_ENGINE_REGIONS = [
  'amsterdam',
  'frankfurt',
  'ny',
  'salt_lake_city',
  'tokyo'
]

export const DEFAULT_RPC_ADDRESS = '7KEVKK9gZ1VUjaTowuCCA8mwMJYTUsZSrSKuTCowSLV'
