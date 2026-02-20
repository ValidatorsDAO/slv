/**
 * ERPC Snapshot Node definitions
 * Used for auto-selecting the nearest snapshot server during `slv init`
 */

export interface SnapshotNode {
  name: string
  region: string
  ip: string
  domain: string
  url: string
}

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
