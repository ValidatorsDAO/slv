// Automatic version updates are switched off until a new version resolver
// ships. Nothing here reads from the network or writes versions.yml.

export const VERSION_UPDATES_DISABLED_MESSAGE =
  'Automatic version updates are disabled until a new version resolver ships. No version was changed.'

export type VersionUpdate = {
  component: string // e.g. "Agave"
  repo: string // e.g. "anza-xyz/agave"
  current: string // current version in versions.yml
  latest: string // latest version from GitHub
  network: string // mainnet / testnet / all
  field: string // versions.yml field path
}

export function checkSolanaReleases(): Promise<VersionUpdate[]> {
  return Promise.resolve([])
}

export function applyVersionUpdates(_updates: VersionUpdate[]): Promise<void> {
  return Promise.resolve()
}
