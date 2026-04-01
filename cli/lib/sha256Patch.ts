import { colors } from '@cliffy/colors'
import { Command } from '@cliffy'
import { Input } from '@cliffy/prompt'
import type { CmnType, InventoryType, NetworkType } from '@cmn/types/config.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { genOrReadInventory } from '/lib/genOrReadInventory.ts'
import { genOrReadVersions } from '/lib/genOrReadVersions.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'

type Sha256PatchRole = 'validator' | 'rpc'
type VersionsSection = keyof CmnType
type VersionField = 'version_agave' | 'version_jito'

const getSha256PatchInventoryType = (
  role: Sha256PatchRole,
  network: NetworkType,
): InventoryType => {
  if (role === 'rpc') {
    return `${network}_rpcs` as InventoryType
  }

  if (network === 'mainnet') {
    return 'mainnet_validators'
  }
  if (network === 'testnet') {
    return 'testnet_validators'
  }

  throw new Error('Validator patch:sha256 supports mainnet and testnet only.')
}

const normalizeVersionTag = (version: string) =>
  version.startsWith('v') ? version : `v${version}`

const getSha256VersionsSection = (
  role: Sha256PatchRole,
  network: NetworkType,
): VersionsSection => {
  if (role === 'rpc') {
    return `${network}_rpcs` as VersionsSection
  }

  if (network === 'mainnet') {
    return 'mainnet_validators'
  }
  if (network === 'testnet') {
    return 'testnet_validators'
  }

  throw new Error('Validator patch:sha256 supports mainnet and testnet only.')
}

const normalizeValidatorTypeToVersionField = (
  validatorType?: string,
): VersionField | undefined => {
  if (!validatorType) {
    return undefined
  }

  if (validatorType.includes('jito')) {
    return 'version_jito'
  }

  if (validatorType.includes('agave') || validatorType.includes('firedancer')) {
    return 'version_agave'
  }

  return undefined
}

const resolveVersionFieldFromInventory = async (
  inventoryType: InventoryType,
  pubkey?: string,
) => {
  const inventory = await genOrReadInventory(inventoryType) as Record<
    string,
    {
      hosts?: Record<string, { validator_type?: string }>
    }
  >
  const hosts = inventory[inventoryType]?.hosts ?? {}

  if (pubkey) {
    const host = hosts[pubkey]
    if (!host) {
      throw new Error(`Host '${pubkey}' was not found in ${inventoryType}.`)
    }
    return normalizeValidatorTypeToVersionField(host.validator_type)
  }

  const versionFields = Object.values(hosts)
    .map((host) => normalizeValidatorTypeToVersionField(host.validator_type))
    .filter((field): field is VersionField => field !== undefined)

  const uniqueFields = [...new Set(versionFields)]
  if (uniqueFields.length === 1) {
    return uniqueFields[0]
  }

  return undefined
}

const getDefaultSha256Version = async (
  role: Sha256PatchRole,
  network: NetworkType,
  pubkey?: string,
) => {
  const versions = await genOrReadVersions()
  const section = getSha256VersionsSection(role, network)
  const inventoryType = getSha256PatchInventoryType(role, network)
  const versionField = await resolveVersionFieldFromInventory(
    inventoryType,
    pubkey,
  )
  if (!versionField) {
    return undefined
  }

  const versionData = versions[section]
  const rawVersion = versionData[versionField]

  if (!rawVersion) {
    throw new Error(
      `No default ${versionField} found in ~/.slv/versions.yml for ${section}.`,
    )
  }

  return normalizeVersionTag(rawVersion)
}

const resolveSha256Version = async (
  role: Sha256PatchRole,
  network: NetworkType,
  inventoryType: InventoryType,
  pubkey?: string,
  providedVersion?: string,
) => {
  if (providedVersion) {
    return normalizeVersionTag(providedVersion)
  }

  const defaultVersion = await getDefaultSha256Version(role, network, pubkey)
  if (!Deno.stdin.isTerminal()) {
    if (!defaultVersion) {
      throw new Error(
        `Could not infer a default Solana version for ${inventoryType}. Specify --pubkey or --solana-version.`,
      )
    }
    console.log(
      colors.blue(
        `Using default Solana version from ~/.slv/versions.yml: ${defaultVersion}`,
      ),
    )
    return defaultVersion
  }

  const version = await Input.prompt(
    defaultVersion
      ? {
        message: 'Solana source tag to build from:',
        default: defaultVersion,
      }
      : {
        message:
          'Solana source tag to build from (no single default; mixed validator_type targets):',
      },
  )

  if (!version.trim()) {
    throw new Error('Solana source tag is required.')
  }

  return normalizeVersionTag(version)
}

export const registerSha256PatchCommands = (
  parentCmd: Command,
  role: Sha256PatchRole,
  defaultNetwork: NetworkType,
) => {
  const label = role === 'validator' ? 'Validator' : 'RPC'

  parentCmd.command('patch:sha256')
    .description(`⚙️ Patch ${label} with optimized SHA256 binary`)
    .option('-n, --network <network>', 'Solana Network', {
      default: defaultNetwork,
    })
    .option('-p, --pubkey <pubkey>', `Target ${label} inventory key`)
    .option(
      '--solana-version <version>',
      'Solana source tag to build from',
    )
    .action(async (options) => {
      try {
        const network = options.network as NetworkType
        const inventoryType = getSha256PatchInventoryType(role, network)
        const solanaVersion = await resolveSha256Version(
          role,
          network,
          inventoryType,
          options.pubkey,
          options.solanaVersion,
        )
        const templateRoot = getTemplatePath()
        const playbook = `${templateRoot}/ansible/cmn/patch_sha256.yml`
        const extraVars = {
          solana_version: solanaVersion,
        }

        const result = options.pubkey
          ? await runAnsilbe(playbook, inventoryType, options.pubkey, extraVars)
          : await runAnsilbe(playbook, inventoryType, undefined, extraVars)

        if (result) {
          console.log(
            colors.white(
              `✅ Successfully deployed patched SHA256 ${label} binary (restart not performed)`,
            ),
          )
        }
      } catch (error) {
        console.error(
          colors.red(
            error instanceof Error
              ? `❌ ${error.message}`
              : `❌ ${String(error)}`,
          ),
        )
      }
    })
}
