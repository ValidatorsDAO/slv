import { parse, stringify } from '@std/yaml'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'

// GitHub repos and their mapping to versions.yml fields
const RELEASE_SOURCES = [
  {
    repo: 'anza-xyz/agave',
    // mainnet = latest stable (no pre-release), testnet = latest (including pre-release)
    fields: {
      mainnet: ['mainnet_validators.version_agave', 'mainnet_rpcs.version_agave'],
      testnet: ['testnet_validators.version_agave', 'testnet_rpcs.version_agave'],
    },
    parseVersion: (tag: string) => tag.replace(/^v/, ''),
    isStable: (tag: string) => !tag.includes('beta') && !tag.includes('rc') && !tag.includes('alpha'),
  },
  {
    repo: 'jito-foundation/jito-solana',
    fields: {
      mainnet: ['mainnet_validators.version_jito', 'mainnet_rpcs.version_jito'],
      testnet: ['testnet_validators.version_jito', 'testnet_rpcs.version_jito'],
    },
    parseVersion: (tag: string) => tag.replace(/^v/, ''),
    isStable: (tag: string) => !tag.includes('beta') && !tag.includes('rc'),
  },
  {
    repo: 'firedancer-io/firedancer',
    fields: {
      mainnet: ['mainnet_validators.version_firedancer'],
      testnet: ['testnet_validators.version_firedancer'],
    },
    parseVersion: (tag: string) => tag.replace(/^v/, ''),
    // Firedancer: mainnet tags have 3xxxx pattern, testnet have 4xxxx
    isMainnet: (tag: string) => {
      const parts = tag.replace(/^v/, '').split('.')
      return parts.length >= 3 && parseInt(parts[2]) < 40000
    },
  },
  {
    repo: 'lamports-dev/richat',
    fields: {
      all: ['mainnet_rpcs.richat_version', 'devnet_rpcs.richat_version', 'testnet_rpcs.richat_version'],
    },
    parseVersion: (tag: string) => tag, // keep as-is (richat-v8.2.3)
    filter: (tag: string) => tag.startsWith('richat-'),
  },
  {
    repo: 'rpcpool/yellowstone-grpc',
    fields: {
      mainnet: ['mainnet_rpcs.geyser_version'],
      testnet: ['testnet_rpcs.geyser_version'],
    },
    parseVersion: (tag: string) => tag.replace(/^v/, ''),
    // Use tags that match solana mainnet version for mainnet, testnet for testnet
  },
]

export type VersionUpdate = {
  component: string    // e.g. "Agave"
  repo: string         // e.g. "anza-xyz/agave"
  current: string      // current version in versions.yml
  latest: string       // latest version from GitHub
  network: string      // mainnet / testnet / all
  field: string        // versions.yml field path
}

export async function checkSolanaReleases(): Promise<VersionUpdate[]> {
  const home = resolveHome()
  const versionsPath = `${home}/.slv/versions.yml`

  let versions: Record<string, any> = {}
  try {
    const raw = await Deno.readTextFile(versionsPath)
    versions = parse(raw) as Record<string, any>
  } catch {
    return [] // No versions.yml, nothing to check
  }

  const updates: VersionUpdate[] = []

  // Check each repo using GitHub API (unauthenticated, rate-limited to 60/hr)
  for (const source of RELEASE_SOURCES) {
    try {
      const res = await fetch(`https://api.github.com/repos/${source.repo}/releases?per_page=10`, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      })
      if (!res.ok) continue

      const releases = await res.json() as Array<{ tag_name: string; prerelease: boolean }>

      // Find latest stable (mainnet) and latest overall (testnet)
      let latestStable = ''
      let latestAll = ''

      for (const rel of releases) {
        const tag = rel.tag_name

        // Apply filter if defined
        if ('filter' in source && source.filter && !source.filter(tag)) continue

        if (!latestAll) latestAll = source.parseVersion(tag)

        if ('isStable' in source && source.isStable) {
          if (source.isStable(tag) && !latestStable) {
            latestStable = source.parseVersion(tag)
          }
        } else if ('isMainnet' in source && source.isMainnet) {
          if (source.isMainnet(tag) && !latestStable) {
            latestStable = source.parseVersion(tag)
          }
        }

        if (latestStable && latestAll) break
      }

      if (!latestStable) latestStable = latestAll

      // Compare with versions.yml
      const componentName = source.repo.split('/')[1] || source.repo

      if ('fields' in source) {
        const fields = source.fields as Record<string, string[]>

        if (fields.mainnet) {
          for (const fieldPath of fields.mainnet) {
            const current = getNestedValue(versions, fieldPath)
            if (current && latestStable && current !== latestStable) {
              updates.push({
                component: componentName,
                repo: source.repo,
                current: String(current),
                latest: latestStable,
                network: 'mainnet',
                field: fieldPath,
              })
            }
          }
        }

        if (fields.testnet) {
          for (const fieldPath of fields.testnet) {
            const current = getNestedValue(versions, fieldPath)
            if (current && latestAll && current !== latestAll) {
              updates.push({
                component: componentName,
                repo: source.repo,
                current: String(current),
                latest: latestAll,
                network: 'testnet',
                field: fieldPath,
              })
            }
          }
        }

        if (fields.all) {
          for (const fieldPath of fields.all) {
            const current = getNestedValue(versions, fieldPath)
            if (current && latestStable && current !== latestStable) {
              updates.push({
                component: componentName,
                repo: source.repo,
                current: String(current),
                latest: latestStable,
                network: 'all',
                field: fieldPath,
              })
            }
          }
        }
      }
    } catch {
      // Network error, skip this repo
      continue
    }
  }

  // Deduplicate by component+network (show only unique updates)
  const seen = new Set<string>()
  return updates.filter(u => {
    const key = `${u.component}-${u.network}-${u.latest}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Apply updates to versions.yml
export async function applyVersionUpdates(updates: VersionUpdate[]): Promise<void> {
  const home = resolveHome()
  const versionsPath = `${home}/.slv/versions.yml`

  let versions: Record<string, any> = {}
  try {
    const raw = await Deno.readTextFile(versionsPath)
    versions = parse(raw) as Record<string, any>
  } catch { return }

  for (const update of updates) {
    setNestedValue(versions, update.field, update.latest)
  }

  await Deno.writeTextFile(versionsPath, stringify(versions))
}

function getNestedValue(obj: Record<string, any>, path: string): unknown {
  const parts = path.split('.')
  let current: any = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function setNestedValue(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: any = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {}
    }
    current = current[parts[i]]
  }
  current[parts[parts.length - 1]] = value
}
