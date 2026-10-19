import { generateKeypair } from '/lib/secret/keypairBytes.ts'
import { chooseVault, itemTemplate, OpRefusal } from '/lib/secret/opItems.ts'
import { storeGeneratedKey } from '/lib/secret/storeGeneratedKey.ts'
import { ResolveError } from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetup,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { defaultTty, type Tty } from '/lib/secret/tty.ts'
import { type KeylessNetwork, writeVaultId } from '/lib/secret/vaultPolicy.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'

// keys:gen makes a throwaway identity for testnet or devnet: the keypair is
// made in memory, goes to 1Password on the stdin of `op item create`, is read
// back through the resolver and compared byte for byte, and only then is its
// public key and reference printed. It is never in an argument, a file or a
// log.

const TITLE = /^[\x20-\x7e]{1,80}$/

type GenOptions = { network?: string; title?: string }

type GenDeps = {
  setup: SecretSetupDeps
  tty: Tty
  io: Io
  /** Makes a keypair: 32 bytes of seed and the 32 bytes of the public key. */
  generate: () => Promise<Uint8Array>
  writeVault: (network: KeylessNetwork, vaultId: string) => Promise<void>
}

const defaultGenDeps = (): GenDeps => ({
  setup: defaultSecretSetupDeps(),
  tty: defaultTty,
  io: defaultIo(),
  generate: generateKeypair,
  writeVault: (network, vaultId) => writeVaultId(network, vaultId),
})

/**
 * Makes a throwaway identity in 1Password and prints its public key and
 * reference. Returns true when the key is in the vault and read back equal.
 */
const genKey = async (
  options: GenOptions,
  overrides: Partial<GenDeps> = {},
): Promise<boolean> => {
  const deps: GenDeps = { ...defaultGenDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.io.error(`❌ ${message}`)
    deps.io.setExitCode(1)
    return false
  }

  const network = options.network
  if (network !== 'testnet' && network !== 'devnet') {
    return refuse(
      `keys:gen makes throwaway keys for -n testnet or -n devnet, got ${
        network === undefined ? 'no network' : `"${network}"`
      }.`,
    )
  }
  const title = options.title?.trim() ?? ''
  if (!TITLE.test(title)) {
    return refuse(
      'keys:gen needs --title <text>: 1 to 80 printable ASCII characters, the title of the 1Password item.',
    )
  }

  let setup: SecretSetup
  try {
    setup = await prepareSecretSetup(network, deps.setup)
  } catch (error) {
    if (error instanceof SecretRefusal) return refuse(error.message)
    return refuse(`keys:gen stopped: ${describe(error)}`)
  }

  try {
    const { vaultId, confirmed } = await chooseVault(network, setup, deps.tty)
    const { pubkey, identityRef } = await storeGeneratedKey(
      setup,
      vaultId,
      title,
      deps.generate,
      'No reference is printed',
    )
    let unsaved: string | null = null
    if (confirmed) {
      try {
        await deps.writeVault(network, vaultId)
      } catch (error) {
        unsaved = describe(error)
      }
    }

    deps.io.info(`✅ A throwaway ${network} identity is in 1Password.`)
    deps.io.info(`   pubkey  ${pubkey}`)
    deps.io.info(`   ref     ${identityRef}`)
    deps.io.info(
      `   check it: slv v keys:check -n ${network} --ref ${identityRef} --pubkey ${pubkey}`,
    )
    if (unsaved !== null) {
      return refuse(
        `The key is in the vault, but the vault could not be written to keyless.yml (${unsaved}). Add networks.${network}.vault_id: ${vaultId} to it yourself; slv reads no other vault.`,
      )
    }
    return true
  } catch (error) {
    if (error instanceof OpRefusal || error instanceof ResolveError) {
      return refuse(error.message)
    }
    return refuse(`keys:gen stopped: ${describe(error)}`)
  }
}

export { defaultGenDeps, genKey, itemTemplate }
export type { GenDeps, GenOptions }
