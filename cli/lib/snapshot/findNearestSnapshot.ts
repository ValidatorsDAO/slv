import { remotePingMinLatency } from '/lib/ping/remotePingMinLatency.ts'
import { SNAPSHOT_NODES, type SnapshotNode } from './snapshotNodes.ts'
import { checkOwnServer } from './checkOwnServer.ts'
import { colors } from '@cliffy/colors'

export interface SnapshotLatency {
  node: SnapshotNode
  latency: number
}

/**
 * Measure latency from a server to all snapshot nodes
 * @param serverIp - The server IP to test from
 * @param options - SSH connection options
 * @returns Array of snapshot latency measurements sorted by latency
 */
async function measureSnapshotLatencies(
  serverIp: string,
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<SnapshotLatency[]> {
  console.log(
    `\n📍 Measuring latencies from ${serverIp} to snapshot nodes...`,
  )

  const promises = SNAPSHOT_NODES.map(async (node) => {
    console.log(`  Pinging ${node.name} (${node.ip})...`)

    try {
      const latency = await remotePingMinLatency(serverIp, node.ip, options)

      if (latency === 9999) {
        console.log(`  ❌ ${node.name}: unreachable`)
      } else {
        console.log(`  ✅ ${node.name}: ${latency.toFixed(3)} ms`)
      }

      return { node, latency }
    } catch (error) {
      console.log(`  ❌ ${node.name}: error - ${error}`)
      return { node, latency: 9999 }
    }
  })

  const results = await Promise.all(promises)
  results.sort((a, b) => a.latency - b.latency)

  return results
}

/**
 * Find the nearest snapshot node for a given server.
 * Only runs for mainnet deployments on our own infrastructure.
 *
 * Flow:
 * 1. Check if server IP is our own (via user-api check-ip)
 * 2. If yes, measure ping to all snapshot nodes
 * 3. Return the nearest snapshot node URL
 * 4. If not our server or all unreachable, return empty string
 *
 * @param serverIp - The deployment target IP
 * @param options - SSH connection options
 * @returns Snapshot URL string (empty if not applicable)
 */
export async function findNearestSnapshotUrl(
  serverIp: string,
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<string> {
  console.log(`\n🔍 Checking if ${serverIp} is an ERPC server...`)

  const checkResult = await checkOwnServer(serverIp)

  if (!checkResult.isOwn) {
    console.log(
      colors.yellow(
        `  ℹ️  ${serverIp} is not an ERPC server. Skipping snapshot auto-detection.`,
      ),
    )
    return ''
  }

  console.log(
    colors.green(
      `  ✅ ${serverIp} is an ERPC ${checkResult.type} (${checkResult.region})`,
    ),
  )

  const latencies = await measureSnapshotLatencies(serverIp, options)
  const reachable = latencies.filter((r) => r.latency !== 9999)

  if (reachable.length === 0) {
    console.log(
      colors.yellow(
        '\n⚠️  All snapshot nodes unreachable. Snapshot URL will be empty.',
      ),
    )
    return ''
  }

  const nearest = reachable[0]

  console.log(
    `\n🎯 Nearest snapshot node: ${nearest.node.name} (${nearest.node.region})`,
  )
  console.log(`   Latency: ${nearest.latency.toFixed(3)} ms`)
  console.log(`   URL: ${nearest.node.url}`)

  return nearest.node.url
}
