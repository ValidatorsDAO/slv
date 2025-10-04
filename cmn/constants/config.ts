export const compileTargets = [
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
]

export const NETWORK = ['mainnet', 'testnet', 'devnet'] as const

export const SolanaNodeTypes = [
  'agave',
  'jito',
  'firedancer-agave',
  'firedancer-jito',
]

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

export const FB_TESTNET_UI_PROXY = '35.204.43.53'

export const SHREDSTREAM_ADDRESS = {
  amsterdam: '74.118.140.240:1002',
  ny: '141.98.216.96:1002',
  frankfurt: '64.130.50.14:1002',
  tokyo: '202.8.9.160:1002',
  salt_lake_city: '64.130.53.8:1002',
}

export const RELAYER_URL = {
  amsterdam: 'http://amsterdam.mainnet.relayer.jito.wtf:8100',
  ny: 'http://ny.mainnet.relayer.jito.wtf:8100',
  frankfurt: 'http://frankfurt.mainnet.relayer.jito.wtf:8100',
  tokyo: 'http://tokyo.mainnet.relayer.jito.wtf:8100',
  salt_lake_city: 'http://slc.mainnet.relayer.jito.wtf:8100',
}

export const DEFAULT_RPC_ADDRESS = '3YgDq4EbniJZGeshHuYxg8KQfpDiawkuEp17DvQeGWhL'