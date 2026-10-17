import { parseIdentityRef, pubkeyFieldRef } from '/lib/secret/identityRef.ts'
import {
  generateKeypair,
  keypairText,
  proveKeypair,
  sameBytes,
  zero,
} from '/lib/secret/keypairBytes.ts'
import { buildOpEnv, firstLine } from '/lib/secret/opCli.ts'
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
import { type KeylessNetwork, writeVaultId } from '/lib/secret/vaultPolicy.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'

// keys:gen makes a throwaway identity for testnet or devnet: the keypair is
// made in memory, goes to 1Password on the stdin of `op item create`, is read
// back through the resolver and compared byte for byte, and only then is its
// public key and reference printed. It is never in an argument, a file or a
// log.

const VAULT_ID = /^[a-z0-9]{26}$/
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

class GenRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenRefusal'
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
      throw new GenRefusal(`op could not ${what}${why ? `: ${why}` : ''}`)
    }
    try {
      return parseList(result.stdout)
    } catch (_error) {
      throw new GenRefusal(
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
  deps: GenDeps,
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
    throw new GenRefusal('op lists no vault that this sign-in can use')
  }
  await deps.tty.say(
    `No vault is set for ${network} in keyless.yml. The vaults that op lists:\n${
      vaults.map((vault) => `  ${vault.id}  ${vault.name}\n`).join('')
    }`,
  )
  const typed = (await deps.tty.ask(
    `Type the id of the vault that is to hold the ${network} keys (anything else stops here): `,
  )).trim()
  if (!vaults.some((vault) => vault.id === typed)) {
    throw new GenRefusal(
      'that is not the id of a listed vault. Nothing was made.',
    )
  }
  return { vaultId: typed, confirmed: true }
}

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

  const keypair = await deps.generate()
  let canonical: Uint8Array | null = null
  let template: Uint8Array | null = null
  try {
    const pubkey = await proveKeypair(keypair)
    canonical = keypairText(keypair)

    const { vaultId, confirmed } = await chooseVault(network, setup, deps)

    const before = new Set(
      (await listOrRefuse(
        setup,
        ['item', 'list', '--vault', vaultId, '--format', 'json'],
        'list the items of the vault',
      )).map((item) => item.id),
    )

    template = itemTemplate(title, pubkey, canonical)
    const created = await runOp(
      setup,
      ['item', 'create', '--vault', vaultId, '-'],
      template,
    )
    // What op prints about the new item is not read.
    zero(created.stdout)
    if (!created.success) {
      const why = firstLine(created.stderr, setup.token ? [setup.token] : [])
      throw new GenRefusal(
        `op could not create the item${why ? `: ${why}` : ''}`,
      )
    }

    const found = (await listOrRefuse(
      setup,
      ['item', 'list', '--vault', vaultId, '--format', 'json'],
      'list the items of the vault',
    )).filter((item) =>
      typeof item.id === 'string' && !before.has(item.id) &&
      item.title === title
    )
    if (found.length !== 1) {
      throw new GenRefusal(
        `the vault has ${found.length} new items titled "${title}" after the key was saved, not exactly one, so the reference is not made. Look at the vault ${vaultId} in 1Password.`,
      )
    }
    const itemId = String(found[0].id)
    const ref = parseIdentityRef(`op://${vaultId}/${itemId}/keypair`, {
      homeDir: '/',
    }).ref

    const back = await resolveIdentity(ref, {}, setup.resolve)
    try {
      if (back.pubkey !== pubkey || !sameBytes(back.canonical, canonical)) {
        throw new GenRefusal(
          `the item ${itemId} in the vault ${vaultId} does not hold the key that was made. No reference is printed; remove that item in 1Password.`,
        )
      }
    } finally {
      back.wipe()
    }
    const stored = await readPubkeyField(pubkeyFieldRef(ref)!, setup.resolve)
    if (stored !== pubkey) {
      throw new GenRefusal(
        `the pubkey field of the item ${itemId} in the vault ${vaultId} is not the public key of the key that was made. No reference is printed; remove that item in 1Password.`,
      )
    }

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
    deps.io.info(`   ref     ${ref.text}`)
    deps.io.info(
      `   check it: slv v keys:check -n ${network} --ref ${ref.text} --pubkey ${pubkey}`,
    )
    if (unsaved !== null) {
      return refuse(
        `The key is in the vault, but the vault could not be written to keyless.yml (${unsaved}). Add networks.${network}.vault_id: ${vaultId} to it yourself; slv reads no other vault.`,
      )
    }
    return true
  } catch (error) {
    if (error instanceof GenRefusal || error instanceof ResolveError) {
      return refuse(error.message)
    }
    return refuse(`keys:gen stopped: ${describe(error)}`)
  } finally {
    zero(keypair, canonical, template)
  }
}

export { defaultGenDeps, genKey, itemTemplate }
export type { GenDeps, GenOptions }
