/**
 * ERPC Intelligent Snapshot Routing
 *
 * Automatically selects the nearest ERPC snapshot download server for a given
 * deployment target. This is the core of ERPC's smart init flow — ensuring
 * that every node bootstraps from the geographically closest snapshot server
 * for maximum speed and minimum cost.
 *
 * ## How it works
 *
 * 1. **Ping-based detection**: Measures real network latency (via SSH + ping)
 *    from the deployment target to all snapshot nodes worldwide. ERPC snapshot
 *    endpoints restrict access to ERPC-network servers only, so:
 *    - **ERPC servers**: pings succeed, latency measured, nearest node selected
 *    - **Non-ERPC servers**: all pings timeout (blocked by firewall)
 *
 * 2. **Automatic selection**: Returns the URL of the lowest-latency snapshot
 *    node. If all nodes are unreachable, returns an empty string so the init
 *    flow can continue with standard snapshot sources.
 *
 * ## Why dedicated snapshot routing?
 *
 * Solana snapshots are large (50-100+ GB). Downloading from the nearest
 * internal node vs. a random public endpoint can mean:
 * - **10x+ faster downloads** through optimized internal routing
 * - **Significantly lower bandwidth costs** (internal vs. external traffic)
 * - **More reliable transfers** with dedicated bandwidth allocation
 *
 * @module findNearestSnapshot
 */

import { remotePingMinLatency } from '/lib/ping/remotePingMinLatency.ts'
import { SNAPSHOT_NODES, type SnapshotNode } from './snapshotNodes.ts'
import { colors } from '@cliffy/colors'

/**
 * Latency measurement result for a single snapshot node.
 * Used to rank and select the optimal download source.
 */
export interface SnapshotLatency {
  /** The snapshot node that was measured */
  node: SnapshotNode
  /** Round-trip latency in milliseconds (9999 = unreachable) */
  latency: number
}

/**
 * Measure network latency from a server to all ERPC snapshot nodes.
 *
 * Uses SSH to execute ping from the target server (not from the local machine),
 * ensuring measurements reflect the actual network path the snapshot download
 * will take. All nodes are measured in parallel for efficiency.
 *
 * @param serverIp - The deployment target IP to measure from
 * @param options - SSH connection parameters (user, key file, port)
 * @returns Array of latency measurements, sorted ascending (fastest first)
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
 * Find the nearest ERPC snapshot node for a deployment target.
 *
 * This is the main entry point for snapshot URL auto-determination during
 * `slv init`. It uses ping-based detection — ERPC snapshot endpoints restrict
 * access to ERPC-network servers only, so reachability itself proves membership.
 *
 * **Detection flow**:
 * 1. Ping all 7 global snapshot nodes from the target server
 * 2. If **all pings timeout** → server is not on ERPC network → return empty string
 * 3. If **any ping succeeds** → server is on ERPC network → select nearest by latency
 *
 * No external HTTP calls or API tokens required — pure network-level detection.
 *
 * @param serverIp - The deployment target IP address
 * @param options - SSH connection parameters for remote ping
 * @returns The optimal snapshot download URL, or empty string for non-ERPC servers
 *
 * @example
 * ```ts
 * // During slv init for a mainnet RPC node
 * const snapshotUrl = await findNearestSnapshotUrl('94.100.18.202', {
 *   user: 'solv',
 *   keyFile: '~/.ssh/id_rsa',
 * })
 * // → 'https://solana-snapshot-ams.erpc.global' (nearest to Amsterdam server)
 * ```
 */
export async function findNearestSnapshotUrl(
  serverIp: string,
  options?: {
    user?: string
    keyFile?: string
    port?: number
  },
): Promise<string> {
  console.log(
    `\n🔍 Detecting ERPC network membership for ${serverIp} via snapshot node reachability...`,
  )

  const latencies = await measureSnapshotLatencies(serverIp, options)
  const reachable = latencies.filter((r) => r.latency !== 9999)

  if (reachable.length === 0) {
    console.log(
      colors.yellow(
        `\n  ℹ️  ${serverIp} cannot reach any ERPC snapshot nodes. Not an ERPC server or network issue.`,
      ),
    )
    return ''
  }

  const nearest = reachable[0]

  console.log(
    colors.green(
      `\n  ✅ ${serverIp} is on the ERPC network (${reachable.length}/${latencies.length} nodes reachable)`,
    ),
  )
  console.log(
    `\n🎯 Nearest snapshot node: ${nearest.node.name} (${nearest.node.region})`,
  )
  console.log(`   Latency: ${nearest.latency.toFixed(3)} ms`)
  console.log(`   URL: ${nearest.node.url}`)

  return nearest.node.url
}
