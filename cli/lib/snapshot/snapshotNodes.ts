/**
 * ERPC Global Snapshot Node Registry
 *
 * Defines the worldwide network of ERPC's dedicated Solana snapshot download
 * servers. These nodes are strategically positioned across major regions to
 * provide the fastest possible snapshot downloads for ERPC infrastructure.
 *
 * ## ERPC Snapshot Network
 *
 * ERPC maintains dedicated snapshot servers in 7 global regions, each running
 * continuously updated Solana snapshots. These endpoints are exclusively
 * available to servers within the ERPC network, providing:
 *
 * - **Global coverage**: 7 regions across 4 continents ensure low-latency
 *   access from any ERPC node worldwide
 * - **Always fresh**: Snapshots are continuously generated, minimizing the
 *   ledger replay time needed after download
 * - **Dedicated bandwidth**: No contention with public traffic — ERPC nodes
 *   get the full pipe for maximum download speed
 * - **Cost-optimized**: Internal routing avoids expensive cross-network
 *   transit fees that can accumulate rapidly with 50-100+ GB transfers
 *
 * All nodes purchased through https://erpc.global/en/ are automatically
 * recognized as part of the ERPC network and qualify for these dedicated
 * snapshot endpoints — no additional configuration required.
 *
 * During `slv init`, the nearest snapshot node is automatically selected
 * by measuring latency from the deployment target to each node, ensuring
 * optimal download performance.
 *
 * @module snapshotNodes
 */

/**
 * Represents an ERPC snapshot download server.
 *
 * Each node provides Solana snapshots via HTTPS. The `ip` field is used
 * for latency measurement (ping), while the `url` is the actual download
 * endpoint passed to the Solana validator configuration.
 */
export interface SnapshotNode {
  /** Human-readable node identifier */
  name: string
  /** Geographic region (used for display and logging) */
  region: string
  /** Direct IP address for latency measurement via ping */
  ip: string
  /** FQDN of the snapshot endpoint */
  domain: string
  /** Full HTTPS URL for snapshot downloads */
  url: string
}

/**
 * All available ERPC snapshot nodes worldwide.
 *
 * Coverage: Europe (Amsterdam, Frankfurt, London), North America (New York,
 * Chicago), Asia-Pacific (Tokyo, Singapore).
 */
export const SNAPSHOT_NODES: SnapshotNode[] = [
  {
    name: 'solana-snapshot-ams',
    region: 'amsterdam',
    ip: '151.244.92.54',
    domain: 'solana-snapshot-ams.erpc.global',
    url: 'https://solana-snapshot-ams.erpc.global',
  },
  {
    name: 'solana-snapshot-fra',
    region: 'frankfurt',
    ip: '82.24.88.47',
    domain: 'solana-snapshot-fra.erpc.global',
    url: 'https://solana-snapshot-fra.erpc.global',
  },
  {
    name: 'solana-snapshot-lon',
    region: 'london',
    ip: '151.241.65.6',
    domain: 'solana-snapshot-lon.erpc.global',
    url: 'https://solana-snapshot-lon.erpc.global',
  },
  {
    name: 'solana-snapshot-ny',
    region: 'ny',
    ip: '151.243.244.14',
    domain: 'solana-snapshot-ny.erpc.global',
    url: 'https://solana-snapshot-ny.erpc.global',
  },
  {
    name: 'solana-snapshot-tokyo',
    region: 'tokyo',
    ip: '143.20.238.19',
    domain: 'solana-snapshot-tokyo.erpc.global',
    url: 'https://solana-snapshot-tokyo.erpc.global',
  },
  {
    name: 'solana-snapshot-sgp',
    region: 'singapore',
    ip: '151.245.186.22',
    domain: 'solana-snapshot-sgp.erpc.global',
    url: 'https://solana-snapshot-sgp.erpc.global',
  },
  {
    name: 'solana-snapshot-chi',
    region: 'chicago',
    ip: '82.27.98.86',
    domain: 'solana-snapshot-chi.erpc.global',
    url: 'https://solana-snapshot-chi.erpc.global',
  },
]
