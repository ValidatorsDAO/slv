import { remotePingMinLatency } from '/lib/ping/remotePingMinLatency.ts'
import { getAllRegions, type JitoRegion } from '/lib/jito/jitoRegions.ts'
import type { RegionLatency } from '/lib/jito/findNearestRegion.ts'

/**
 * Extract hostname from BAM URL
 * @param bamUrl - The full BAM URL
 * @returns Hostname extracted from URL
 */
function extractHostname(bamUrl: string): string {
  try {
    const url = new URL(bamUrl)
    return url.hostname
  } catch {
    return bamUrl.replace('https://', '').replace('http://', '').split('/')[0]
  }
}

/**
 * Measure latency from a server to all Jito BAM regions
 * @param serverIp - The server IP address to test from
 * @param network - 'mainnet' or 'testnet'
 * @param options - SSH connection options
 * @returns Array of region latency measurements sorted by latency
 */
export async function measureBamRegionLatencies(
  serverIp: string,
  network: 'mainnet' | 'testnet',
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<RegionLatency[]> {
  const regions = getAllRegions(network).filter(([, region]) => region.bamUrl)

  if (regions.length === 0) {
    console.log(`\n⚠️  No BAM endpoints configured for ${network}`)
    return []
  }

  const results: RegionLatency[] = []

  console.log(
    `\n📍 Measuring BAM latencies from ${serverIp} to ${network} regions...`,
  )

  const promises = regions.map(async ([key, region]) => {
    const hostname = extractHostname(region.bamUrl as string)
    console.log(`  Pinging BAM ${region.name} (${hostname})...`)

    try {
      const latency = await remotePingMinLatency(serverIp, hostname, options)
      const result: RegionLatency = {
        region: key,
        info: region as JitoRegion,
        latency,
        host: hostname,
      }

      if (latency === 9999) {
        console.log(`  ❌ ${region.name}: unreachable`)
      } else {
        console.log(`  ✅ ${region.name}: ${latency.toFixed(3)} ms`)
      }

      return result
    } catch (error) {
      console.log(`  ❌ ${region.name}: error - ${error}`)
      return {
        region: key,
        info: region as JitoRegion,
        latency: 9999,
        host: hostname,
      }
    }
  })

  const measuredResults = await Promise.all(promises)
  results.push(...measuredResults)

  results.sort((a, b) => a.latency - b.latency)

  return results
}

/**
 * Find the nearest Jito BAM region based on network latency
 * @param serverIp - The server IP address to test from
 * @param network - 'mainnet' or 'testnet'
 * @param options - SSH connection options
 * @returns The nearest region information, Frankfurt if all unreachable, or undefined if Frankfurt doesn't exist
 */
export async function findNearestBamRegion(
  serverIp: string,
  network: 'mainnet' | 'testnet',
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<RegionLatency | undefined> {
  const latencies = await measureBamRegionLatencies(serverIp, network, options)

  if (latencies.length === 0) return undefined

  const reachableRegions = latencies.filter((r) => r.latency !== 9999)

  if (reachableRegions.length === 0) {
    console.log(
      '\n⚠️  All BAM regions are unreachable, defaulting to Frankfurt',
    )

    const frankfurt = latencies.find((r) => r.region === 'frankfurt')
    if (frankfurt) {
      console.log(
        `\n🎯 Default BAM region: ${frankfurt.info.emoji} ${frankfurt.info.name}`,
      )
      console.log(`   BAM URL: ${frankfurt.info.bamUrl}`)
      return frankfurt
    }

    return undefined
  }

  const nearest = reachableRegions[0]

  console.log(
    `\n🎯 Nearest BAM region: ${nearest.info.emoji} ${nearest.info.name}`,
  )
  console.log(`   Latency: ${nearest.latency.toFixed(3)} ms`)
  console.log(`   BAM URL: ${nearest.info.bamUrl}`)

  return nearest
}

/**
 * Display BAM latency results in a formatted table
 * @param latencies - Array of region latency measurements
 */
export function displayBamLatencyResults(latencies: RegionLatency[]): void {
  console.log('\n📊 BAM Latency Results (sorted by latency):')
  console.log('─'.repeat(60))

  for (const result of latencies) {
    const latencyStr = result.latency === 9999
      ? 'Unreachable'
      : `${result.latency.toFixed(3)} ms`

    const status = result.latency === 9999 ? '❌' : '✅'
    console.log(
      `${status} ${result.info.emoji} ${result.info.name.padEnd(15)} ${
        latencyStr.padStart(15)
      }`,
    )
  }

  console.log('─'.repeat(60))
}
