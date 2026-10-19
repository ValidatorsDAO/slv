import { getInventoryPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import { HostFactsError, readHostKeyFacts } from '/lib/secret/hostKeyFacts.ts'
import {
  IdentityRefError,
  parseIdentityRef,
  pubkeyFieldRef,
} from '/lib/secret/identityRef.ts'
import {
  checkVoteBinding,
  defaultOnchainDeps,
  type OnchainDeps,
} from '/lib/secret/onchain.ts'
import {
  readPubkeyField,
  ResolveError,
  resolveIdentity,
} from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetup,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { defaultTty, type Tty } from '/lib/secret/tty.ts'
import { checkRefVault, PolicyError } from '/lib/secret/vaultPolicy.ts'
import {
  defaultInventoryReader,
  type InventoryReader,
} from '/lib/ssh/inventoryTarget.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'

// keys:check reads the key of a host and shows that it is the key of the
// identity_account of its inventory entry, with the vault and the vote account
// on chain held against it first and the name of the host typed by the person.
// With --ref and --pubkey it reads a key that has no host (a key made by
// keys:gen) and shows that it has the public key given. It talks to 1Password
// and the cluster only: no node, no ssh, no ansible.

type CheckOptions = {
  network?: string
  /** The inventory name of the host. */
  host?: string
  ref?: string
  pubkey?: string
}

type CheckDeps = {
  setup: SecretSetupDeps
  io: Io
  tty: Tty
  reader: InventoryReader
  onchain: OnchainDeps
}

const defaultCheckDeps = (): CheckDeps => ({
  setup: defaultSecretSetupDeps(),
  io: defaultIo(),
  tty: defaultTty,
  reader: defaultInventoryReader(),
  onchain: defaultOnchainDeps(),
})

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Returns true when the key proves out and is the key it should be: that of the
 * identity_account of the host, or the public key that --pubkey says.
 */
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
  const hasHost = options.host !== undefined && options.host !== ''
  const hasRef = options.ref !== undefined && options.ref !== ''
  if (hasHost && (hasRef || options.pubkey !== undefined)) {
    return refuse(
      'keys:check takes -p <inventory name of the host>, or --ref and --pubkey, and not both.',
    )
  }
  if (!hasHost && !hasRef) {
    return refuse(
      'keys:check needs -p <inventory name of the host>, or --ref <reference of the key> with --pubkey <the public key it has to have>.',
    )
  }
  if (hasHost) return await checkHost(network, options.host!, deps, refuse)

  if (options.pubkey === undefined) {
    return refuse(
      "keys:check --ref needs --pubkey <the public key the key has to have>: a key that is no host's has no identity_account to be held against. To check the key of a host use -p <inventory name>.",
    )
  }
  if (!BASE58_PUBKEY.test(options.pubkey)) {
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
    deps.io.info('   pubkey matches the expected one')
    return true
  } catch (error) {
    if (error instanceof ResolveError) return refuse(error.message)
    return refuse(`keys:check stopped: ${describe(error)}`)
  }
}

/**
 * The key of a host, in this order: where keys are resolved, the entry of the
 * inventory, the reference (the legacy key file when the entry has none) and
 * its vault, the vote account on chain, the name of the host typed by the
 * person, the pubkey field of the item, and then the key itself.
 */
const checkHost = async (
  network: 'testnet' | 'devnet' | 'mainnet',
  hostName: string,
  deps: CheckDeps,
  refuse: (message: string) => false,
): Promise<boolean> => {
  if (network === 'devnet') {
    return refuse(
      'keys:check -p reads a host of the validator inventory of testnet or mainnet, and devnet has none.',
    )
  }
  if (!PLAIN_NAME.test(hostName)) {
    return refuse(
      `"${hostName.slice(0, 40)}" is not the inventory name of a host.`,
    )
  }
  let setup: SecretSetup
  try {
    setup = await prepareSecretSetup(network, deps.setup)
  } catch (error) {
    if (error instanceof SecretRefusal || error instanceof PolicyError) {
      return refuse(error.message)
    }
    return refuse(`keys:check stopped: ${describe(error)}`)
  }

  try {
    const homeDir = deps.reader.homeDir
    if (!homeDir) return refuse('HOME is not set.')
    const group: InventoryType = network === 'mainnet'
      ? 'mainnet_validators'
      : 'testnet_validators'
    const path = getInventoryPath(group)
    const text = await deps.reader.readText(path)
    if (text === null) return refuse(`there is no inventory file ${path}`)

    let facts
    try {
      facts = readHostKeyFacts(text, group, hostName)
    } catch (error) {
      if (error instanceof HostFactsError) return refuse(error.message)
      throw error
    }
    let parsed
    try {
      parsed = parseIdentityRef(facts.identityRef, {
        identityAccount: facts.identityAccount,
        homeDir,
      })
    } catch (error) {
      if (error instanceof IdentityRefError) {
        return refuse(`identity_ref of ${hostName}: ${error.message}`)
      }
      throw error
    }
    const { ref } = parsed
    for (const warning of parsed.warnings) deps.io.info(`⚠️  ${warning}`)
    try {
      checkRefVault(ref, setup.policy, network)
    } catch (error) {
      if (error instanceof PolicyError) {
        return refuse(`${error.message}. Nothing was read.`)
      }
      throw error
    }
    if (facts.voteAccount === null) {
      return refuse(
        `${hostName} has no vote_account in the inventory, so its identity_account cannot be held against the vote account on chain. Nothing was read.`,
      )
    }
    const binding = await checkVoteBinding(network, {
      identityAccount: facts.identityAccount,
      voteAccount: facts.voteAccount,
    }, deps.onchain)
    if (!binding.ok) {
      return refuse(
        `${binding.reason.replace(/[.\s]+$/, '')}. Nothing was read.`,
      )
    }

    let typed: string
    try {
      await deps.tty.say(
        [
          'keys:check reads the key of a host and shows that it is the key of its identity_account. It sends nothing to any node.',
          `  host      ${hostName}`,
          `  identity  ${facts.identityAccount}`,
          `  vote      ${facts.voteAccount}`,
          `  ref       ${ref.text}`,
          '',
        ].join('\n'),
      )
      typed = (await deps.tty.ask(
        `Type the name of the host (${hostName}) to go on, anything else stops here: `,
      )).trim()
    } catch (_error) {
      return refuse(
        'keys:check asks you on /dev/tty and cannot run without a terminal. Nothing was read.',
      )
    }
    if (typed !== hostName) {
      return refuse('That is not the name of the host. Nothing was read.')
    }

    // The item says whose key it is, in a field that holds no secret; then the key.
    const fieldRef = pubkeyFieldRef(ref)
    if (fieldRef !== null) {
      const field = await readPubkeyField(fieldRef, setup.resolve)
      if (field !== facts.identityAccount) {
        return refuse(
          `the pubkey field of ${ref.text} is ${field}, not the identity_account ${facts.identityAccount} of ${hostName}. The key was not read.`,
        )
      }
    }
    const key = await resolveIdentity(
      ref,
      { expectedPubkey: facts.identityAccount },
      setup.resolve,
    )
    key.wipe()
    deps.io.info(
      `✅ ${ref.text} holds the keypair of ${facts.identityAccount}, the identity_account of ${hostName}`,
    )
    deps.io.info('   pubkey matches')
    return true
  } catch (error) {
    if (error instanceof ResolveError) return refuse(error.message)
    return refuse(`keys:check stopped: ${describe(error)}`)
  }
}

export { checkKey, defaultCheckDeps }
export type { CheckDeps, CheckOptions }
