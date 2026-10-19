import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import { parseIdentityRef, pubkeyFieldRef } from '/lib/secret/identityRef.ts'
import { generateKeypair } from '/lib/secret/keypairBytes.ts'
import { storeGeneratedKey } from '/lib/secret/storeGeneratedKey.ts'
import { chooseVault, confirmKeyVault } from '/lib/secret/opItems.ts'
import {
  checkVoteBinding,
  defaultOnchainDeps,
  type OnchainDeps,
} from '/lib/secret/onchain.ts'
import {
  readPubkeyField,
  resolveIdentity,
} from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { defaultTty, type Tty } from '/lib/secret/tty.ts'
import { checkRefVault, writeVaultId } from '/lib/secret/vaultPolicy.ts'

export type ValidatorInitAccounts = {
  identity_account: string
  identity_ref: string
  vote_account: string
  authority_account: ''
  no_voting: true
}

export type InitAccountsDeps = {
  setup: SecretSetupDeps
  tty: Tty
  generate: () => Promise<Uint8Array>
  writeVault: typeof writeVaultId
  onchain: OnchainDeps
}

const defaults = (): InitAccountsDeps => ({
  setup: defaultSecretSetupDeps(),
  tty: defaultTty,
  generate: generateKeypair,
  writeVault: writeVaultId,
  onchain: defaultOnchainDeps(),
})

/** This check belongs before init's SSH/password/user-setup side effects. */
export const checkValidatorInitContext = async (
  network: 'mainnet' | 'testnet',
  deps: SecretSetupDeps = defaultSecretSetupDeps(),
): Promise<void> => {
  await prepareSecretSetup(network, deps)
}

/** Public metadata only. No generated key is written to a local file. */
export async function prepareValidatorInitAccounts(
  network: 'mainnet' | 'testnet',
  name: string,
  overrides: Partial<InitAccountsDeps> = {},
): Promise<ValidatorInitAccounts> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new SecretRefusal(
      'Use an inventory name of letters, digits, dots, underscores or hyphens.',
    )
  }
  const deps = { ...defaults(), ...overrides }
  // Repeat the context check at the secret boundary, including direct callers.
  const setup = await prepareSecretSetup(network, deps.setup)
  const choice = (await deps.tty.ask(
    'Identity: [1] Create and save in 1Password (default), [2] Use an existing 1Password item: ',
  )).trim() || '1'
  if (choice !== '1' && choice !== '2') {
    throw new SecretRefusal('Setup cancelled; choose 1 or 2.')
  }

  let pubkey: string
  let reference: string
  let voteAccount = ''
  if (choice === '1') {
    // Mainnet creation is human-only under the existing mainnet context policy.
    // Its vault is additionally confirmed by name before any key is generated.
    const { vaultId, confirmed } = await (network === 'mainnet'
      ? confirmKeyVault(network, setup, deps.tty)
      : chooseVault(network, setup, deps.tty))
    const title = `SLV ${network} ${name} identity`.slice(0, 80)
    const stored = await storeGeneratedKey(
      setup,
      vaultId,
      title,
      deps.generate,
      'The validator inventory was not written',
    )
    pubkey = stored.pubkey
    reference = stored.identityRef
    if (confirmed) {
      try {
        await deps.writeVault(network, vaultId)
      } catch {
        throw new SecretRefusal(
          `The identity was verified in 1Password at ${reference}, but keyless.yml could not be saved. No validator inventory was written. Configure the ${network} vault and reuse this item; do not generate another key.`,
        )
      }
    }
  } else {
    const value = (await deps.tty.ask(
      'Existing 1Password reference (op://<vault-id>/<item-id>/keypair): ',
    )).trim()
    const ref = parseIdentityRef(value, { homeDir: '/' }).ref
    if (ref.kind !== 'op') {
      throw new SecretRefusal(
        'Validator init accepts a 1Password item, not a local key file.',
      )
    }
    const { vaultId, confirmed } = await chooseVault(network, setup, deps.tty)
    checkRefVault(ref, { ...setup.policy, vaultId }, network)
    const expected = await readPubkeyField(pubkeyFieldRef(ref)!, setup.resolve)
    const key = await resolveIdentity(
      ref,
      { expectedPubkey: expected },
      setup.resolve,
    )
    try {
      pubkey = key.pubkey
    } finally {
      key.wipe()
    }
    reference = ref.text
    if (confirmed) await deps.writeVault(network, vaultId)
    voteAccount = (await deps.tty.ask(
      'Existing vote account public key (optional; Enter to skip). This setup will not vote: ',
    )).trim()
    if (voteAccount) {
      if (!BASE58_PUBKEY.test(voteAccount)) {
        throw new SecretRefusal(
          'The vote account must be a public key, not key contents.',
        )
      }
      const binding = await checkVoteBinding(network, {
        identityAccount: pubkey,
        voteAccount,
      }, deps.onchain)
      if (!binding.ok) throw new SecretRefusal(binding.reason)
    }
  }
  await deps.tty.say(
    `1Password identity verified.\n  Public key: ${pubkey}\n  Reference: ${reference}\nSync-only setup: deploy starts the server with its unstaked identity, not this stored identity. No vote account is created, no airdrop or transaction is sent, and voting stays disabled.\n`,
  )
  return {
    identity_account: pubkey,
    identity_ref: reference,
    vote_account: voteAccount,
    authority_account: '',
    no_voting: true,
  }
}
