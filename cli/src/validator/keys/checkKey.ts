import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import { IdentityRefError, parseIdentityRef } from '/lib/secret/identityRef.ts'
import { ResolveError, resolveIdentity } from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetup,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { checkRefVault, PolicyError } from '/lib/secret/vaultPolicy.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'

// keys:check reads the key of a reference, shows that it is a whole keypair, and
// prints its public key (or says it is not the public key that was expected).
// It talks to 1Password only: no node, no ssh, no ansible.

type CheckOptions = { network?: string; ref?: string; pubkey?: string }

type CheckDeps = { setup: SecretSetupDeps; io: Io }

const defaultCheckDeps = (): CheckDeps => ({
  setup: defaultSecretSetupDeps(),
  io: defaultIo(),
})

/** Returns true when the reference holds a keypair that proves out, and is the expected one when one is given. */
const checkKey = async (
  options: CheckOptions,
  overrides: Partial<CheckDeps> = {},
): Promise<boolean> => {
  const deps: CheckDeps = { ...defaultCheckDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.io.error(`❌ ${message}`)
    deps.io.setExitCode(1)
    return false
  }

  const network = options.network
  if (network !== 'testnet' && network !== 'devnet' && network !== 'mainnet') {
    return refuse(
      `keys:check supports -n testnet, -n devnet or -n mainnet, got ${
        network === undefined ? 'no network' : `"${network}"`
      }.`,
    )
  }
  if (options.ref === undefined || options.ref === '') {
    return refuse('keys:check needs --ref <reference of the key>.')
  }
  if (options.pubkey !== undefined && !BASE58_PUBKEY.test(options.pubkey)) {
    return refuse('--pubkey is not a public key.')
  }

  let ref
  try {
    ref = parseIdentityRef(options.ref, { homeDir: '/' }).ref
  } catch (error) {
    if (error instanceof IdentityRefError) return refuse(error.message)
    throw error
  }

  let setup: SecretSetup
  try {
    setup = await prepareSecretSetup(network, deps.setup)
    checkRefVault(ref, setup.policy, network)
  } catch (error) {
    if (error instanceof SecretRefusal || error instanceof PolicyError) {
      return refuse(error.message)
    }
    return refuse(`keys:check stopped: ${describe(error)}`)
  }

  try {
    const key = await resolveIdentity(
      ref,
      { expectedPubkey: options.pubkey },
      setup.resolve,
    )
    key.wipe()
    deps.io.info(
      `✅ ${ref.text} holds a keypair whose public key is ${key.pubkey}`,
    )
    if (options.pubkey !== undefined) {
      deps.io.info('   pubkey matches the expected one')
    }
    return true
  } catch (error) {
    if (error instanceof ResolveError) return refuse(error.message)
    return refuse(`keys:check stopped: ${describe(error)}`)
  }
}

export { checkKey, defaultCheckDeps }
export type { CheckDeps, CheckOptions }
