import { type IdentityRef, pubkeyFieldRef } from '/lib/secret/identityRef.ts'
import { sameBytes, zero } from '/lib/secret/keypairBytes.ts'
import { buildOpEnv, firstLine } from '/lib/secret/opCli.ts'
import {
  readPubkeyField,
  resolveIdentity,
} from '/lib/secret/resolveIdentity.ts'
import type { SecretSetup } from '/lib/secret/setup.ts'
import type { Tty } from '/lib/secret/tty.ts'
import type { KeylessNetwork } from '/lib/secret/vaultPolicy.ts'

// How the verbs that put a key into 1Password talk to op about items: the
// vault, the new item, and the check that it holds the key that went in.

const VAULT_ID = /^[a-z0-9]{26}$/

class OpRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpRefusal'
  }
}

/**
 * The JSON template that `op item create` reads on its stdin. The keypair is
 * placed into it as bytes: the text of a keypair is digits, commas and square
 * brackets, which JSON needs no escape for, so no string ever holds it.
 */
const itemTemplate = (
  title: string,
  pubkey: string,
  keypair: Uint8Array,
): Uint8Array => {
  const encoder = new TextEncoder()
  const head = encoder.encode(
    `{"title":${
      JSON.stringify(title)
    },"category":"API_CREDENTIAL","fields":[{"id":"keypair","label":"keypair","type":"CONCEALED","value":"`,
  )
  const tail = encoder.encode(
    `"},{"id":"pubkey","label":"pubkey","type":"STRING","value":${
      JSON.stringify(pubkey)
    }}]}`,
  )
  const template = new Uint8Array(head.length + keypair.length + tail.length)
  template.set(head, 0)
  template.set(keypair, head.length)
  template.set(tail, head.length + keypair.length)
  return template
}

const runOp = (
  setup: SecretSetup,
  args: string[],
  stdin: Uint8Array | null,
  stdout: 'piped' | 'null' = 'piped',
) =>
  setup.resolve.op(setup.resolve.opPath, args, {
    env: buildOpEnv(setup.resolve.parentEnv, setup.token),
    stdin,
    stdout,
  })

/** The list that `op ... list --format json` prints, as records. These lists hold ids, names and titles, never a field value. */
const parseList = (stdout: Uint8Array): Record<string, unknown>[] => {
  const text = new TextDecoder().decode(stdout).trim()
  if (text === '') return []
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value)) throw new Error('op did not print a list')
  return value.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null
  )
}

const printable = (text: string): string =>
  // deno-lint-ignore no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 60)

const listOrRefuse = async (
  setup: SecretSetup,
  args: string[],
  what: string,
): Promise<Record<string, unknown>[]> => {
  const result = await runOp(setup, args, null)
  try {
    if (!result.success) {
      const why = firstLine(result.stderr, setup.token ? [setup.token] : [])
      throw new OpRefusal(`op could not ${what}${why ? `: ${why}` : ''}`)
    }
    try {
      return parseList(result.stdout)
    } catch (_error) {
      throw new OpRefusal(
        `op printed something unreadable when it was asked to ${what}`,
      )
    }
  } finally {
    zero(result.stdout)
  }
}

type VaultSummary = { id: string; name: string }

/** The vaults that `op vault list` prints, by id and name. */
const listVaults = async (setup: SecretSetup): Promise<VaultSummary[]> =>
  (await listOrRefuse(
    setup,
    ['vault', 'list', '--format', 'json'],
    'list the vaults',
  )).flatMap((vault) =>
    typeof vault.id === 'string' && VAULT_ID.test(vault.id)
      ? [{ id: vault.id, name: printable(String(vault.name ?? '')) }]
      : []
  )

/** keyless.yml has no vault for the network: the vaults that op lists are shown, and the person types the id of one. */
const pickVault = async (
  network: KeylessNetwork,
  setup: SecretSetup,
  listed: readonly VaultSummary[],
  tty: Tty,
): Promise<string> => {
  // The vault of mainnet is for mainnet alone, and mainnet takes none of the others.
  const apart = new Map<string, string>()
  for (
    const other of network === 'mainnet'
      ? (['testnet', 'devnet'] as const)
      : (['mainnet'] as const)
  ) {
    const vaultId = setup.config.networks[other]?.vaultId
    if (vaultId != null) apart.set(vaultId, other)
  }
  const vaults = listed.filter((vault) => !apart.has(vault.id))
  if (vaults.length === 0) {
    throw new OpRefusal(
      listed.length === 0
        ? 'op lists no vault that this sign-in can use'
        : `op lists no vault for ${network} besides the vaults of the other networks`,
    )
  }
  await tty.say(
    `No vault is set for ${network} in keyless.yml. The vaults that op lists:\n${
      vaults.map((vault, index) => `  ${index + 1}. ${vault.name}\n`).join('')
    }`,
  )
  const answer = (await tty.ask(
    `Choose the vault number for ${network}${
      vaults.length === 1 ? ' (Enter for 1)' : ''
    }: `,
  )).trim()
  const selected = answer === '' && vaults.length === 1
    ? 1
    : /^\d+$/.test(answer)
    ? Number(answer)
    : NaN
  const typed =
    Number.isInteger(selected) && selected >= 1 && selected <= vaults.length
      ? vaults[selected - 1].id
      : answer
  const taken = apart.get(typed)
  if (taken !== undefined) {
    throw new OpRefusal(
      `that is the vault of ${taken}, and the keys of mainnet and of the other networks are not kept together. Nothing was made.`,
    )
  }
  if (!vaults.some((vault) => vault.id === typed)) {
    throw new OpRefusal(
      'that is not a listed vault number or id. Nothing was made.',
    )
  }
  return typed
}

/** The vault the keys of the network go to: the one in keyless.yml, or the one the person confirms on the terminal. */
const chooseVault = async (
  network: KeylessNetwork,
  setup: SecretSetup,
  tty: Tty,
): Promise<{ vaultId: string; confirmed: boolean }> => {
  if (setup.policy.vaultId !== null) {
    return { vaultId: setup.policy.vaultId, confirmed: false }
  }
  const vaultId = await pickVault(network, setup, await listVaults(setup), tty)
  return { vaultId, confirmed: true }
}

/**
 * The vault a real key goes into, whether keyless.yml sets it or the person
 * picks it: shown by the name and the id that `op vault list` gives, and the
 * person types its name before anything is made. A vault that keyless.yml sets
 * and that op does not list is a refusal.
 */
const confirmKeyVault = async (
  network: KeylessNetwork,
  setup: SecretSetup,
  tty: Tty,
): Promise<{ vaultId: string; confirmed: boolean }> => {
  const listed = await listVaults(setup)
  const set = setup.policy.vaultId
  const vaultId = set ?? await pickVault(network, setup, listed, tty)
  const vault = listed.find((candidate) => candidate.id === vaultId)
  if (vault === undefined) {
    throw new OpRefusal(
      `keyless.yml sets the vault ${vaultId} for ${network}, and op lists no vault with that id: it may be out of date. Nothing was made. Set networks.${network}.vault_id to the id of the vault, or remove it to be asked.`,
    )
  }
  const name = vault.name.trim()
  if (name === '') {
    throw new OpRefusal(
      `the vault ${vault.id} has no name to type. Give it one in 1Password. Nothing was made.`,
    )
  }
  await tty.say(
    `${
      set === null ? '' : 'keyless.yml sets this vault. '
    }The ${network} key goes into this vault, as a new item:\n  ${vault.id}  ${name}\n`,
  )
  const typed = (await tty.ask(
    `Type the name of the vault (${name}) to go on, anything else stops here: `,
  )).trim()
  if (typed !== name) {
    throw new OpRefusal('that is not the name of the vault. Nothing was made.')
  }
  return { vaultId: vault.id, confirmed: set === null }
}

type ItemSummary = { id: string; title: string }

/** The items of a vault, by id and title. */
const listItems = async (
  setup: SecretSetup,
  vaultId: string,
): Promise<ItemSummary[]> =>
  (await listOrRefuse(
    setup,
    ['item', 'list', '--vault', vaultId, '--format', 'json'],
    'list the items of the vault',
  )).flatMap((item) =>
    typeof item.id === 'string'
      ? [{ id: item.id, title: String(item.title ?? '') }]
      : []
  )

/**
 * Creates the item from a template on stdin and returns its id: the one new
 * item of the vault that has the title. What op prints about the item is not
 * read.
 */
const createItem = async (
  setup: SecretSetup,
  vaultId: string,
  title: string,
  template: Uint8Array,
  before: readonly ItemSummary[],
): Promise<string> => {
  // op prints the item it made; that output is not collected.
  const created = await runOp(
    setup,
    ['item', 'create', '--vault', vaultId, '-'],
    template,
    'null',
  )
  if (!created.success) {
    const why = firstLine(created.stderr, setup.token ? [setup.token] : [])
    throw new OpRefusal(`op could not create the item${why ? `: ${why}` : ''}`)
  }
  const known = new Set(before.map((item) => item.id))
  const found = (await listItems(setup, vaultId)).filter((item) =>
    !known.has(item.id) && item.title === title
  )
  if (found.length !== 1) {
    throw new OpRefusal(
      `the vault has ${found.length} new items titled "${title}" after the key was saved, not exactly one, so the reference is not made. Look at the vault ${vaultId} in 1Password.`,
    )
  }
  return found[0].id
}

/**
 * Reads the item back through the resolver and requires the key to be the one
 * that went in, byte for byte, and the pubkey field to be its public key.
 * `what` says what was done to the key (made, imported) and `consequence`
 * what the verb did not do because of this failure; `advice` is what the
 * person does about it, and by default removes the item that was just made.
 */
const verifyStoredKey = async (
  setup: SecretSetup,
  ref: IdentityRef,
  stored: { pubkey: string; canonical: Uint8Array },
  words: { what: string; consequence: string; advice?: string },
): Promise<void> => {
  const advice = words.advice ?? 'remove that item in 1Password'
  const where = ref.kind === 'op'
    ? `the item ${ref.itemId} in the vault ${ref.vaultId}`
    : ref.text
  const back = await resolveIdentity(ref, {}, setup.resolve)
  try {
    if (
      back.pubkey !== stored.pubkey ||
      !sameBytes(back.canonical, stored.canonical)
    ) {
      throw new OpRefusal(
        `${where} does not hold the key that was ${words.what}. ${words.consequence}; ${advice}.`,
      )
    }
  } finally {
    back.wipe()
  }
  const field = await readPubkeyField(pubkeyFieldRef(ref)!, setup.resolve)
  if (field !== stored.pubkey) {
    throw new OpRefusal(
      `the pubkey field of ${where} is not the public key of the key that was ${words.what}. ${words.consequence}; ${advice}.`,
    )
  }
}

export {
  chooseVault,
  confirmKeyVault,
  createItem,
  itemTemplate,
  listItems,
  OpRefusal,
  printable,
  verifyStoredKey,
}
export type { ItemSummary }
