import { remotePingMinLatency } from '/lib/ping/remotePingMinLatency.ts'
import { getAllRegions, type JitoRegion } from '/lib/jito/jitoRegions.ts'

export interface RegionLatency {
  region: string
  info: JitoRegion
  latency: number
  host: string
}

/**
 * Extract hostname from Block Engine URL
 * @param blockEngineUrl - The full Block Engine URL
 * @returns Hostname extracted from URL
 */
function extractHostname(blockEngineUrl: string): string {
  try {
    const url = new URL(blockEngineUrl)
    return url.hostname
  } catch {
    // Fallback for malformed URLs
    return blockEngineUrl.replace('https://', '').replace('http://', '').split(
      '/',
    )[0]
  }
}

/**
 * Measure latency from a server to all Jito regions
 * @param serverIp - The server IP address to test from
 * @param network - 'mainnet' or 'testnet'
 * @param options - SSH connection options
 * @returns Array of region latency measurements sorted by latency
 */
export async function measureRegionLatencies(
  serverIp: string,
  network: 'mainnet' | 'testnet',
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<RegionLatency[]> {
  const regions = getAllRegions(network)
  const results: RegionLatency[] = []

  console.log(
    `\n📍 Measuring latencies from ${serverIp} to ${network} regions...`,
  )

  // Measure latencies in parallel
  const promises = regions
    .filter(([key, _]) => key !== 'global') // Skip global endpoint
    .map(async ([key, region]) => {
      const hostname = extractHostname(region.blockEngineUrl)
      console.log(`  Pinging ${region.name} (${hostname})...`)

      try {
        const latency = await remotePingMinLatency(serverIp, hostname, options)
        const result: RegionLatency = {
          region: key,
          info: region,
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
          info: region,
          latency: 9999,
          host: hostname,
        }
      }
    })

  const measuredResults = await Promise.all(promises)
  results.push(...measuredResults)

  // Sort by latency (lowest first)
  results.sort((a, b) => a.latency - b.latency)

  return results
}

/**
 * Find the nearest Jito region based on network latency
 * @param serverIp - The server IP address to test from
 * @param network - 'mainnet' or 'testnet'
 * @param options - SSH connection options
 * @returns The nearest region information or undefined if all regions are unreachable
 */
export async function findNearestJitoRegion(
  serverIp: string,
  network: 'mainnet' | 'testnet',
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<RegionLatency | undefined> {
  const latencies = await measureRegionLatencies(serverIp, network, options)

  // Filter out unreachable regions
  const reachableRegions = latencies.filter((r) => r.latency !== 9999)

  if (reachableRegions.length === 0) {
    console.log('\n⚠️  All regions are unreachable')
    return undefined
  }

  const nearest = reachableRegions[0]

  console.log(`\n🎯 Nearest region: ${nearest.info.emoji} ${nearest.info.name}`)
  console.log(`   Latency: ${nearest.latency.toFixed(3)} ms`)
  console.log(`   Block Engine: ${nearest.info.blockEngineUrl}`)
  if (nearest.info.shredReceiver) {
    console.log(`   Shred Receiver: ${nearest.info.shredReceiver}`)
  }
  if (nearest.info.relayerUrl) {
    console.log(`   Relayer: ${nearest.info.relayerUrl}`)
  }
  if (nearest.info.ntpServer) {
    console.log(`   NTP Server: ${nearest.info.ntpServer}`)
  }

  return nearest
}

/**
 * Display latency results in a formatted table
 * @param latencies - Array of region latency measurements
 */
export function displayLatencyResults(latencies: RegionLatency[]): void {
  console.log('\n📊 Latency Results (sorted by latency):')
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
