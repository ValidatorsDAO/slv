export interface JitoRegion {
  name: string
  emoji: string
  blockEngineUrl: string
  bamUrl?: string
  shredReceiver?: string
  relayerUrl?: string
  ntpServer?: string
}

export interface JitoRegions {
  mainnet: Map<string, JitoRegion>
  testnet: Map<string, JitoRegion>
}

// Mainnet regions
const mainnetRegions = new Map<string, JitoRegion>([
  ['global', {
    name: 'Global',
    emoji: '🌍 🌎 🌏',
    blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
  }],
  ['amsterdam', {
    name: 'Amsterdam',
    emoji: '🇳🇱',
    blockEngineUrl: 'https://amsterdam.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://amsterdam.mainnet.bam.jito.wtf',
    shredReceiver: '74.118.140.240:1002',
    relayerUrl: 'http://amsterdam.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.amsterdam.jito.wtf',
  }],
  ['dublin', {
    name: 'Dublin',
    emoji: '🇮🇪',
    blockEngineUrl: 'https://dublin.mainnet.block-engine.jito.wtf',
    shredReceiver: '64.130.61.8:1002',
    relayerUrl: 'http://dublin.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.dublin.jito.wtf',
  }],
  ['frankfurt', {
    name: 'Frankfurt',
    emoji: '🇩🇪',
    blockEngineUrl: 'https://frankfurt.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://frankfurt.mainnet.bam.jito.wtf',
    shredReceiver: '64.130.50.14:1002',
    relayerUrl: 'http://frankfurt.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.frankfurt.jito.wtf',
  }],
  ['london', {
    name: 'London',
    emoji: '🇬🇧',
    blockEngineUrl: 'https://london.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://london.mainnet.bam.jito.wtf',
    shredReceiver: '142.91.127.175:1002',
    relayerUrl: 'http://london.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.london.jito.wtf',
  }],
  ['ny', {
    name: 'New York',
    emoji: '🇺🇸',
    blockEngineUrl: 'https://ny.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://ny.mainnet.bam.jito.wtf',
    shredReceiver: '141.98.216.96:1002',
    relayerUrl: 'http://ny.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.dallas.jito.wtf',
  }],
  ['slc', {
    name: 'Salt Lake City',
    emoji: '🇺🇸',
    blockEngineUrl: 'https://slc.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://slc.mainnet.bam.jito.wtf',
    shredReceiver: '64.130.53.8:1002',
    relayerUrl: 'http://slc.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.slc.jito.wtf',
  }],
  ['singapore', {
    name: 'Singapore',
    emoji: '🇸🇬',
    blockEngineUrl: 'https://singapore.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://singapore.mainnet.bam.jito.wtf',
    shredReceiver: '202.8.11.224:1002',
    relayerUrl: 'http://singapore.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.singapore.jito.wtf',
  }],
  ['tokyo', {
    name: 'Tokyo',
    emoji: '🇯🇵',
    blockEngineUrl: 'https://tokyo.mainnet.block-engine.jito.wtf',
    bamUrl: 'http://tokyo.mainnet.bam.jito.wtf',
    shredReceiver: '202.8.9.160:1002',
    relayerUrl: 'http://tokyo.mainnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.tokyo.jito.wtf',
  }],
])

// Testnet regions
const testnetRegions = new Map<string, JitoRegion>([
  ['global', {
    name: 'Global',
    emoji: '🌍 🌎 🌏',
    blockEngineUrl: 'https://testnet.block-engine.jito.wtf',
  }],
  ['dallas', {
    name: 'Dallas',
    emoji: '🇺🇸',
    blockEngineUrl: 'https://dallas.testnet.block-engine.jito.wtf',
    bamUrl: 'http://dallas.testnet.bam.jito.wtf',
    shredReceiver: '141.98.218.12:1002',
    relayerUrl: 'http://dallas.testnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.dallas.jito.wtf',
  }],
  ['ny', {
    name: 'New York',
    emoji: '🇺🇸',
    blockEngineUrl: 'https://ny.testnet.block-engine.jito.wtf',
    bamUrl: 'http://ny.testnet.bam.jito.wtf',
    shredReceiver: '64.130.35.224:1002',
    relayerUrl: 'http://ny.testnet.relayer.jito.wtf:8100',
    ntpServer: 'ntp.dallas.jito.wtf',
  }],
  ['slc', {
    name: 'Salt Lake City',
    emoji: '🇺🇸',
    blockEngineUrl: 'https://slc.testnet.block-engine.jito.wtf',
    bamUrl: 'http://slc.testnet.bam.jito.wtf',
  }],
])

// Export the regions
export const jitoRegions: JitoRegions = {
  mainnet: mainnetRegions,
  testnet: testnetRegions,
}

/**
 * Get Jito region information by region key
 * @param network - 'mainnet' or 'testnet'
 * @param region - Region key (e.g., 'amsterdam', 'tokyo', 'ny')
 * @returns JitoRegion information or undefined if not found
 */
export function getJitoRegion(
  network: 'mainnet' | 'testnet',
  region: string,
): JitoRegion | undefined {
  return jitoRegions[network].get(region.toLowerCase())
}

/**
 * Get all available regions for a network
 * @param network - 'mainnet' or 'testnet'
 * @returns Array of region keys
 */
export function getAvailableRegions(network: 'mainnet' | 'testnet'): string[] {
  return Array.from(jitoRegions[network].keys())
}

/**
 * Get all regions with details for a network
 * @param network - 'mainnet' or 'testnet'
 * @returns Array of [key, JitoRegion] tuples
 */
export function getAllRegions(
  network: 'mainnet' | 'testnet',
): Array<[string, JitoRegion]> {
  return Array.from(jitoRegions[network].entries())
}

/**
 * Find the nearest Jito region by comparing latencies
 * @param network - 'mainnet' or 'testnet'
 * @param latencyMap - Map of region keys to latency values in ms
 * @returns The region key with the lowest latency
 */
export function findNearestRegion(
  network: 'mainnet' | 'testnet',
  latencyMap: Map<string, number>,
): string | undefined {
  let minLatency = Infinity
  let nearestRegion: string | undefined

  for (const [region, latency] of latencyMap) {
    if (jitoRegions[network].has(region) && latency < minLatency) {
      minLatency = latency
      nearestRegion = region
    }
  }

  return nearestRegion
}
