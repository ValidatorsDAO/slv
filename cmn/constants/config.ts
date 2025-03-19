export const compileTargets = [
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
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

export const SHREDSTREAM_ADDRESS = {
  amsterdam: '74.118.140.240:1002',
  ny: '141.98.216.96:1002',
  frankfurt: '64.130.50.14:1002',
  tokyo: '202.8.9.160:1002',
  salt_lake_city: '64.130.53.8:1002',
}

export const DEFAULT_RPC_ADDRESS = '3YgDq4EbniJZGeshHuYxg8KQfpDiawkuEp17DvQeGWhL'