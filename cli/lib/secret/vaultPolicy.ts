import { dirname, join } from '@std/path'
import { parse, stringify } from '@std/yaml'
import { configRoot } from '@cmn/constants/path.ts'
import type { IdentityRef } from '/lib/secret/identityRef.ts'

// ~/.slv/keyless.yml says which 1Password vault holds the keys of each network,
// and how slv signs in to it. It is read from this machine only, never from the
// inventory:
//
//   networks:
//     testnet:
//       vault_id: <26 lower-case letters and digits>
//       service_account_token_file: /absolute/path/of/a/file/with/mode/0600
//   ssh:
//     identity_agent: /absolute/path/of/an/ssh/agent/socket    # optional

type KeylessNetwork = 'testnet' | 'devnet' | 'mainnet'

type NetworkPolicy = { vaultId: string | null; tokenFile: string | null }

type KeylessConfig = {
  networks: Partial<Record<KeylessNetwork, NetworkPolicy>>
  /** An ssh agent socket to take the key for the nodes from, or null. */
  identityAgent: string | null
}

class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

const KEYLESS_PATH = join(configRoot, 'keyless.yml')

const NETWORKS: readonly KeylessNetwork[] = ['testnet', 'devnet', 'mainnet']
const VAULT_ID = /^[a-z0-9]{26}$/
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const absolutePath = (value: unknown, what: string): string => {
  if (
    typeof value !== 'string' || !ABSOLUTE_PATH.test(value) ||
    value.split('/').some((segment, index) =>
      index > 0 && (segment === '' || segment === '.' || segment === '..')
    )
  ) {
    throw new PolicyError(
      `keyless.yml: ${what} has to be an absolute path of letters, digits, . _ - and /`,
    )
  }
  return value
}

const onlyKeys = (
  mapping: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void => {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) {
      throw new PolicyError(`keyless.yml: ${where} has an unknown key "${key}"`)
    }
  }
}

/** The settings in the text of keyless.yml; whatever is not as above is refused, by its name. */
const parseKeylessConfig = (text: string): KeylessConfig => {
  let document: unknown
  try {
    document = parse(text)
  } catch (_error) {
    throw new PolicyError('keyless.yml is not valid YAML')
  }
  const config: KeylessConfig = { networks: {}, identityAgent: null }
  if (document === null || document === undefined) return config
  if (!isMapping(document)) {
    throw new PolicyError('keyless.yml has to be a mapping')
  }
  onlyKeys(document, ['networks', 'ssh'], 'the top level')
  if (document.networks !== undefined) {
    if (!isMapping(document.networks)) {
      throw new PolicyError('keyless.yml: networks has to be a mapping')
    }
    for (const [name, entry] of Object.entries(document.networks)) {
      if (!NETWORKS.includes(name as KeylessNetwork)) {
        throw new PolicyError(`keyless.yml: "${name}" is not a network`)
      }
      if (!isMapping(entry)) {
        throw new PolicyError(
          `keyless.yml: networks.${name} has to be a mapping`,
        )
      }
      onlyKeys(
        entry,
        ['vault_id', 'service_account_token_file'],
        `networks.${name}`,
      )
      let vaultId: string | null = null
      if (entry.vault_id !== undefined) {
        if (
          typeof entry.vault_id !== 'string' || !VAULT_ID.test(entry.vault_id)
        ) {
          throw new PolicyError(
            `keyless.yml: networks.${name}.vault_id has to be the id of a vault: 26 lower-case letters and digits`,
          )
        }
        vaultId = entry.vault_id
      }
      let tokenFile: string | null = null
      if (entry.service_account_token_file !== undefined) {
        tokenFile = absolutePath(
          entry.service_account_token_file,
          `networks.${name}.service_account_token_file`,
        )
      }
      config.networks[name as KeylessNetwork] = { vaultId, tokenFile }
    }
  }
  if (document.ssh !== undefined) {
    if (!isMapping(document.ssh)) {
      throw new PolicyError('keyless.yml: ssh has to be a mapping')
    }
    onlyKeys(document.ssh, ['identity_agent'], 'ssh')
    if (document.ssh.identity_agent !== undefined) {
      config.identityAgent = absolutePath(
        document.ssh.identity_agent,
        'ssh.identity_agent',
      )
    }
  }
  return config
}

type PolicyDeps = {
  /** The text of a file, or null when there is none. */
  readText: (path: string) => Promise<string | null>
  lstat: (path: string) => Promise<
    {
      isFile: boolean
      isSymlink: boolean
      mode: number | null
      uid: number | null
    }
  >
  uid: () => number | null
  writeText: (path: string, text: string) => Promise<void>
}

const defaultPolicyDeps = (): PolicyDeps => ({
  readText: async (path) => {
    try {
      return await Deno.readTextFile(path)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null
      throw error
    }
  },
  lstat: async (path) => {
    const info = await Deno.lstat(path)
    return {
      isFile: info.isFile,
      isSymlink: info.isSymlink,
      mode: info.mode,
      uid: info.uid,
    }
  },
  uid: () => Deno.uid(),
  writeText: async (path, text) => {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    await Deno.writeTextFile(temporary, text, { mode: 0o600, createNew: true })
    await Deno.rename(temporary, path)
  },
})

/** keyless.yml, or no settings when there is no such file. */
const readKeylessConfig = async (
  path: string = KEYLESS_PATH,
  deps: Pick<PolicyDeps, 'readText'> = defaultPolicyDeps(),
): Promise<KeylessConfig> => {
  const text = await deps.readText(path)
  return text === null
    ? { networks: {}, identityAgent: null }
    : parseKeylessConfig(text)
}

const policyOf = (
  config: KeylessConfig,
  network: KeylessNetwork,
): NetworkPolicy =>
  config.networks[network] ?? { vaultId: null, tokenFile: null }

/** True when any network has a service account token configured. */
const anyTokenConfigured = (config: KeylessConfig): boolean =>
  Object.values(config.networks).some((policy) => policy?.tokenFile != null)

/**
 * A reference to a 1Password item is read only from the vault configured for
 * the network, and one in any other vault is refused before anything is asked
 * or read. A file reference has no vault.
 */
const checkRefVault = (
  ref: IdentityRef,
  policy: NetworkPolicy,
  network: KeylessNetwork,
): void => {
  if (ref.kind !== 'op') return
  if (policy.vaultId === null) {
    throw new PolicyError(
      `no vault is configured for ${network} in keyless.yml (networks.${network}.vault_id), so no 1Password reference is read`,
    )
  }
  if (ref.vaultId !== policy.vaultId) {
    throw new PolicyError(
      `the vault of this reference is not the vault configured for ${network}`,
    )
  }
}

/**
 * The service account token in a file: a regular file (not a link) of mode
 * 0600 that belongs to the user running slv. Nothing it says holds the token.
 */
const readServiceAccountToken = async (
  path: string,
  deps: Pick<PolicyDeps, 'readText' | 'lstat' | 'uid'> = defaultPolicyDeps(),
): Promise<string> => {
  let info
  try {
    info = await deps.lstat(path)
  } catch (_error) {
    throw new PolicyError(
      `the service account token file ${path} cannot be read`,
    )
  }
  if (info.isSymlink || !info.isFile) {
    throw new PolicyError(
      `the service account token file ${path} has to be a regular file, not a link`,
    )
  }
  if (info.mode === null || (info.mode & 0o7777) !== 0o600) {
    throw new PolicyError(
      `the service account token file ${path} has to have mode 0600${
        info.mode === null
          ? ''
          : `, it has ${(info.mode & 0o7777).toString(8).padStart(4, '0')}`
      }`,
    )
  }
  if (info.uid === null || info.uid !== deps.uid()) {
    throw new PolicyError(
      `the service account token file ${path} has to belong to the user that runs slv`,
    )
  }
  const text = await deps.readText(path)
  const token = text?.trim() ?? ''
  if (token === '') {
    throw new PolicyError(`the service account token file ${path} is empty`)
  }
  return token
}

/** Writes the vault of a network into keyless.yml, and keeps what else is in it. */
const writeVaultId = async (
  network: KeylessNetwork,
  vaultId: string,
  path: string = KEYLESS_PATH,
  deps: Pick<PolicyDeps, 'readText' | 'writeText'> = defaultPolicyDeps(),
): Promise<void> => {
  if (!VAULT_ID.test(vaultId)) {
    throw new PolicyError('a vault id is 26 lower-case letters and digits')
  }
  const text = await deps.readText(path)
  // Read it the way it is read everywhere, so that a file that would be
  // refused is not written over.
  if (text !== null) parseKeylessConfig(text)
  const document = text === null
    ? {}
    : (parse(text) ?? {}) as Record<string, unknown>
  const networks = isMapping(document.networks) ? document.networks : {}
  const entry = isMapping(networks[network])
    ? networks[network] as Record<string, unknown>
    : {}
  networks[network] = { ...entry, vault_id: vaultId }
  document.networks = networks
  await deps.writeText(path, stringify(document))
}

export {
  anyTokenConfigured,
  checkRefVault,
  defaultPolicyDeps,
  KEYLESS_PATH,
  parseKeylessConfig,
  PolicyError,
  policyOf,
  readKeylessConfig,
  readServiceAccountToken,
  writeVaultId,
}
export type { KeylessConfig, KeylessNetwork, NetworkPolicy, PolicyDeps }
