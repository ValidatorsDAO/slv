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
) =>
  setup.resolve.op(setup.resolve.opPath, args, {
    env: buildOpEnv(setup.resolve.parentEnv, setup.token),
    stdin,
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

/** The vault the keys of the network go to: the one in keyless.yml, or the one the person confirms on the terminal. */
const chooseVault = async (
  network: KeylessNetwork,
  setup: SecretSetup,
  tty: Tty,
): Promise<{ vaultId: string; confirmed: boolean }> => {
  if (setup.policy.vaultId !== null) {
    return { vaultId: setup.policy.vaultId, confirmed: false }
  }
  const vaults = (await listOrRefuse(
    setup,
    ['vault', 'list', '--format', 'json'],
    'list the vaults',
  )).flatMap((vault) =>
    typeof vault.id === 'string' && VAULT_ID.test(vault.id)
      ? [{ id: vault.id, name: printable(String(vault.name ?? '')) }]
      : []
  )
  if (vaults.length === 0) {
    throw new OpRefusal('op lists no vault that this sign-in can use')
  }
  await tty.say(
    `No vault is set for ${network} in keyless.yml. The vaults that op lists:\n${
      vaults.map((vault) => `  ${vault.id}  ${vault.name}\n`).join('')
    }`,
  )
  const typed = (await tty.ask(
    `Type the id of the vault that is to hold the ${network} keys (anything else stops here): `,
  )).trim()
  if (!vaults.some((vault) => vault.id === typed)) {
    throw new OpRefusal(
      'that is not the id of a listed vault. Nothing was made.',
    )
  }
  return { vaultId: typed, confirmed: true }
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
  const created = await runOp(
    setup,
    ['item', 'create', '--vault', vaultId, '-'],
    template,
  )
  zero(created.stdout)
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
 * what the verb did not do because of this failure.
 */
const verifyStoredKey = async (
  setup: SecretSetup,
  ref: IdentityRef,
  stored: { pubkey: string; canonical: Uint8Array },
  words: { what: string; consequence: string },
): Promise<void> => {
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
        `${where} does not hold the key that was ${words.what}. ${words.consequence}; remove that item in 1Password.`,
      )
    }
  } finally {
    back.wipe()
  }
  const field = await readPubkeyField(pubkeyFieldRef(ref)!, setup.resolve)
  if (field !== stored.pubkey) {
    throw new OpRefusal(
      `the pubkey field of ${where} is not the public key of the key that was ${words.what}. ${words.consequence}; remove that item in 1Password.`,
    )
  }
}

export {
  chooseVault,
  createItem,
  itemTemplate,
  listItems,
  OpRefusal,
  verifyStoredKey,
}
export type { ItemSummary }
