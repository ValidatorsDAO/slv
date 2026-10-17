import { dirname } from '@std/path'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import { parse } from 'https://deno.land/std@0.202.0/yaml/parse.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import {
  type IdentityRef,
  IdentityRefError,
  parseIdentityRef,
} from '/lib/secret/identityRef.ts'
import {
  KeypairFormatError,
  keypairText,
  parseKeypairText,
  proveKeypair,
  zero,
} from '/lib/secret/keypairBytes.ts'
import {
  chooseVault,
  createItem,
  itemTemplate,
  listItems,
  OpRefusal,
  printable,
  verifyStoredKey,
} from '/lib/secret/opItems.ts'
import { ResolveError } from '/lib/secret/resolveIdentity.ts'
import {
  defaultSecretSetupDeps,
  prepareSecretSetup,
  SecretRefusal,
  type SecretSetup,
  type SecretSetupDeps,
} from '/lib/secret/setup.ts'
import { defaultTty, type Tty } from '/lib/secret/tty.ts'
import {
  checkRefVault,
  type KeylessNetwork,
  PolicyError,
  writeVaultId,
} from '/lib/secret/vaultPolicy.ts'
import { validatorGroup } from '/lib/ssh/inventoryTarget.ts'
import { defaultIo, describe, type Io } from '/src/validator/keys/io.ts'

// keys:import puts the key file of a validator into 1Password, checks the item
// by reading it back, and only then writes its reference into the inventory.
// The key file is read and never changed or removed.

class ImportRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportRefusal'
  }
}

type ImportOptions = { network?: string; host?: string; file?: string }

type ImportDeps = {
  setup: SecretSetupDeps
  tty: Tty
  io: Io
  homeDir: string | undefined
  /** The path of the inventory file of a group. */
  inventoryPath: (group: InventoryType) => string
  /** The text of a file, or null when there is none. */
  readText: (path: string) => Promise<string | null>
  /** Replaces the inventory file with the text. */
  writeInventory: (path: string, text: string) => Promise<void>
  readKeyFile: (path: string) => Promise<Uint8Array>
  writeVault: (network: KeylessNetwork, vaultId: string) => Promise<void>
}

/** A key file is a few hundred bytes of text. */
const MAX_KEY_FILE_BYTES = 16 * 1024

const defaultImportDeps = (): ImportDeps => ({
  setup: defaultSecretSetupDeps(),
  tty: defaultTty,
  io: defaultIo(),
  homeDir: Deno.env.get('HOME'),
  inventoryPath: (group) => getInventoryPath(group),
  readText: async (path) => {
    try {
      return await Deno.readTextFile(path)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null
      throw error
    }
  },
  writeInventory: async (path, text) => {
    // A link is followed: the file it points at is the inventory, and the link stays.
    let target = path
    try {
      target = await Deno.realPath(path)
    } catch (_error) {
      // A file that is not there yet is written where it is named.
    }
    let mode = 0o600
    try {
      mode = (await Deno.stat(target)).mode! & 0o777
    } catch (_error) {
      // A new file is private.
    }
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    try {
      const file = await Deno.open(temporary, {
        write: true,
        createNew: true,
        mode,
      })
      try {
        const bytes = new TextEncoder().encode(text)
        let written = 0
        while (written < bytes.length) {
          written += await file.write(bytes.subarray(written))
        }
        // The data is on the disk before the name is.
        await file.syncData()
      } finally {
        file.close()
      }
      await Deno.chmod(temporary, mode)
      await Deno.rename(temporary, target)
    } catch (error) {
      await Deno.remove(temporary).catch(() => undefined)
      throw error
    }
    // And the directory entry, where the system lets a directory be synced.
    try {
      const directory = await Deno.open(dirname(target), { read: true })
      try {
        await directory.syncData()
      } finally {
        directory.close()
      }
    } catch (_error) {
      // Not everywhere can a directory be opened and synced.
    }
  },
  readKeyFile: async (path) => {
    const info = await Deno.stat(path)
    if (!info.isFile || info.size > MAX_KEY_FILE_BYTES) {
      throw new ImportRefusal(
        `${path} is not a key file: a regular file of at most ${MAX_KEY_FILE_BYTES} bytes is expected`,
      )
    }
    return await Deno.readFile(path)
  },
  writeVault: (network, vaultId) => writeVaultId(network, vaultId),
})

type OpReference = Extract<IdentityRef, { kind: 'op' }>

type IdentityEntries = {
  identityAccount: string
  /** Every host of the group that has this identity_account, the named one included. */
  names: string[]
  /** The hosts among them that have an identity_ref already, with its text as it is written. */
  referenced: { name: string; ref: string }[]
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hostsOf = (document: unknown, group: string): Record<string, unknown> => {
  const entry = isMapping(document) ? document[group] : undefined
  const hosts = isMapping(entry) ? entry.hosts : undefined
  return isMapping(hosts) ? hosts : {}
}

/** The hosts of the group that share the identity_account of the named host. */
const findEntries = (
  document: unknown,
  group: string,
  host: string,
): IdentityEntries => {
  const hosts = hostsOf(document, group)
  const named = hosts[host]
  if (!isMapping(named)) {
    throw new ImportRefusal(
      `${host} is not a host of ${group} in the inventory`,
    )
  }
  const identityAccount = named.identity_account
  if (
    typeof identityAccount !== 'string' || !BASE58_PUBKEY.test(identityAccount)
  ) {
    throw new ImportRefusal(`${host} has no identity_account in the inventory`)
  }
  const names: string[] = []
  const referenced: { name: string; ref: string }[] = []
  for (const [name, entry] of Object.entries(hosts)) {
    if (!isMapping(entry) || entry.identity_account !== identityAccount) {
      continue
    }
    names.push(name)
    const ref = entry.identity_ref
    if (ref !== undefined && ref !== null && ref !== '') {
      referenced.push({ name, ref: String(ref) })
    }
  }
  return { identityAccount, names, referenced }
}

const listReferenced = (referenced: IdentityEntries['referenced']): string =>
  referenced.map((entry) =>
    `${entry.name} has identity_ref ${printable(entry.ref)}`
  ).join('; ')

const refusalForReferenced = (referenced: IdentityEntries['referenced']) =>
  `${
    listReferenced(referenced)
  }: keys:import does not overwrite a reference. Remove the line from the inventory if the key is to be imported again. Nothing was changed.`

/**
 * The 1Password reference that every entry with the identity_account that has
 * one shares, when it is in the vault of the network: keys:import then points
 * the entries that lack it at that item and makes no other. Any other
 * reference is refused.
 */
const sharedReference = (
  referenced: IdentityEntries['referenced'],
  setup: SecretSetup,
  network: KeylessNetwork,
): OpReference | null => {
  const texts = [...new Set(referenced.map((entry) => entry.ref))]
  if (texts.length === 0) return null
  if (texts.length > 1) {
    throw new ImportRefusal(
      `${
        listReferenced(referenced)
      }: the entries do not agree on the reference, and keys:import does not choose one. Nothing was changed.`,
    )
  }
  let ref: IdentityRef
  try {
    ref = parseIdentityRef(texts[0], { homeDir: '/' }).ref
  } catch (error) {
    if (error instanceof IdentityRefError) {
      throw new ImportRefusal(refusalForReferenced(referenced))
    }
    throw error
  }
  if (ref.kind !== 'op') {
    throw new ImportRefusal(refusalForReferenced(referenced))
  }
  try {
    checkRefVault(ref, setup.policy, network)
  } catch (error) {
    if (error instanceof PolicyError) {
      throw new ImportRefusal(
        `${
          listReferenced(referenced)
        }: ${error.message}. keys:import does not overwrite a reference. Nothing was changed.`,
      )
    }
    throw error
  }
  return ref
}

/** What the person does when the vault has an item with the title already: remove it, or check it and point the inventory at it by hand. */
const refusalForExisting = (
  network: string,
  vaultId: string,
  identityAccount: string,
  existing: readonly { id: string }[],
): string => {
  const many = existing.length > 1
  const checks = existing.flatMap((item) => {
    try {
      const { ref } = parseIdentityRef(`op://${vaultId}/${item.id}/keypair`, {
        homeDir: '/',
      })
      return [
        `slv v keys:check -n ${network} --ref ${ref.text} --pubkey ${identityAccount}`,
      ]
    } catch (_error) {
      return []
    }
  })
  return `the vault ${vaultId} has an item titled ${identityAccount} already (${
    existing.map((item) => printable(item.id)).join(', ')
  }), and keys:import does not make a second one. Nothing was changed. Either remove ${
    many ? 'those items' : 'that item'
  } in 1Password and run keys:import again, or check ${
    many ? 'each' : 'it'
  } with ${
    checks.length > 0
      ? checks.join(' ; ')
      : `slv v keys:check -n ${network} --ref op://<vault id>/<item id>/keypair --pubkey ${identityAccount}`
  } and, if it holds the key, set identity_ref of the inventory entries to its reference by hand.`
}

/**
 * Puts the key file of a host into 1Password and writes the reference of the
 * item into the inventory entries that have the identity_account of the host.
 * Returns true when the item was read back equal and the inventory was written.
 */
const importKey = async (
  options: ImportOptions,
  overrides: Partial<ImportDeps> = {},
): Promise<boolean> => {
  const deps: ImportDeps = { ...defaultImportDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.io.error(`❌ ${message}`)
    deps.io.setExitCode(1)
    return false
  }

  const network = options.network
  if (network !== 'testnet' && network !== 'mainnet') {
    return refuse(
      `keys:import supports -n testnet or -n mainnet, got ${
        network === undefined ? 'no network' : `"${network}"`
      }.`,
    )
  }
  const host = options.host
  if (host === undefined || host === '') {
    return refuse('keys:import needs -p <inventory name of the host>.')
  }
  const group = validatorGroup(network)!
  const homeDir = deps.homeDir
  if (!homeDir) return refuse('HOME is not set.')

  let setup: SecretSetup
  try {
    setup = await prepareSecretSetup(network, deps.setup, {
      refuseServiceAccount:
        `keys:import puts a real key into 1Password through the app and does not run with a service account, which networks.${network}.service_account_token_file in keyless.yml names. A service account is for the throwaway keys of keys:gen.`,
    })
  } catch (error) {
    if (error instanceof SecretRefusal) return refuse(error.message)
    return refuse(`keys:import stopped: ${describe(error)}`)
  }

  let keypair: Uint8Array | null = null
  let canonical: Uint8Array | null = null
  let template: Uint8Array | null = null
  try {
    const inventoryFile = deps.inventoryPath(group)
    const inventoryText = await deps.readText(inventoryFile)
    if (inventoryText === null) {
      throw new ImportRefusal(`there is no inventory file ${inventoryFile}`)
    }
    const entries = findEntries(parse(inventoryText), group, host)
    const { identityAccount } = entries
    // Entries that point at one item of the vault already: the item is the one to use.
    const shared = sharedReference(entries.referenced, setup, network)
    if (
      shared !== null &&
      entries.names.every((name) =>
        entries.referenced.some((entry) => entry.name === name)
      )
    ) {
      deps.io.info(
        `✅ Every entry of ${identityAccount} points at ${shared.text} already. Nothing was changed.`,
      )
      deps.io.info(`   check it: slv v keys:check -n ${network} -p ${host}`)
      return true
    }

    // The key file: the one named, or the one slv has always kept the key in.
    let keyPath: string
    try {
      const file = options.file
      const { ref: named } = file === undefined
        ? parseIdentityRef(undefined, { identityAccount, homeDir })
        : parseIdentityRef(
          `file://${
            file.startsWith('~/') ? `${homeDir}${file.slice(1)}` : file
          }`,
          { homeDir },
        )
      if (named.kind !== 'file') throw new ImportRefusal('that is no file')
      keyPath = named.path
    } catch (error) {
      if (error instanceof IdentityRefError) {
        throw new ImportRefusal(
          options.file === undefined
            ? error.message
            : `--file takes an absolute path, or one that starts with ~/, made of letters, digits, . _ - and /; got ${
              printable(options.file)
            }`,
        )
      }
      throw error
    }
    const raw = await deps.readKeyFile(keyPath)
    try {
      keypair = parseKeypairText(raw)
    } finally {
      zero(raw)
    }
    try {
      await proveKeypair(keypair, identityAccount)
    } catch (error) {
      if (error instanceof KeypairFormatError) {
        throw new ImportRefusal(`${keyPath}: ${error.message}`)
      }
      throw error
    }
    canonical = keypairText(keypair)

    let ref: IdentityRef
    let vaultId: string
    let confirmed = false
    if (shared !== null) {
      // The item is there. It has to be the item of this identity and hold this key.
      ref = shared
      vaultId = shared.vaultId
      const item = (await listItems(setup, vaultId)).find((candidate) =>
        candidate.id === shared.itemId
      )
      if (item === undefined) {
        throw new ImportRefusal(
          `${
            listReferenced(entries.referenced)
          }, and the vault ${vaultId} has no item with that id. Nothing was changed.`,
        )
      }
      if (item.title !== identityAccount) {
        throw new ImportRefusal(
          `the item ${shared.itemId} of ${shared.text} is titled "${
            printable(item.title)
          }", not ${identityAccount}. Nothing was changed.`,
        )
      }
      await verifyStoredKey(
        setup,
        ref,
        { pubkey: identityAccount, canonical },
        {
          what: 'read from the key file',
          consequence: 'The inventory was not changed',
          advice:
            'the item and the key file are two keys, so find out which of them is the key of the identity',
        },
      )
    } else {
      ;({ vaultId, confirmed } = await chooseVault(network, setup, deps.tty))
      const before = await listItems(setup, vaultId)
      const existing = before.filter((item) => item.title === identityAccount)
      if (existing.length > 0) {
        throw new ImportRefusal(
          refusalForExisting(network, vaultId, identityAccount, existing),
        )
      }

      template = itemTemplate(identityAccount, identityAccount, canonical)
      const itemId = await createItem(
        setup,
        vaultId,
        identityAccount,
        template,
        before,
      )
      ref = parseIdentityRef(`op://${vaultId}/${itemId}/keypair`, {
        homeDir: '/',
      }).ref
      await verifyStoredKey(
        setup,
        ref,
        { pubkey: identityAccount, canonical },
        {
          what: 'imported',
          consequence: 'The inventory was not changed',
        },
      )
    }

    // Only now the inventory: read again, since a person took the time in between.
    const latestText = await deps.readText(inventoryFile)
    if (latestText === null) {
      throw new ImportRefusal(`the inventory file ${inventoryFile} is gone`)
    }
    const document = parse(latestText)
    const latest = findEntries(document, group, host)
    if (latest.identityAccount !== identityAccount) {
      throw new ImportRefusal(
        `${host} has another identity_account now. The inventory was not changed; the item ${ref.text} is in the vault.`,
      )
    }
    // A reference that is not the item's appeared meanwhile: not overwritten, and not agreed with.
    const others = latest.referenced.filter((entry) => entry.ref !== ref.text)
    if (
      others.length > 0 || (shared === null && latest.referenced.length > 0)
    ) {
      throw new ImportRefusal(
        `${
          refusalForReferenced(shared === null ? latest.referenced : others)
        } The item ${ref.text} is in the vault.`,
      )
    }
    const hosts = hostsOf(document, group)
    const lacking = latest.names.filter((name) =>
      !latest.referenced.some((entry) => entry.name === name)
    )
    for (const name of lacking) {
      ;(hosts[name] as Record<string, unknown>).identity_ref = ref.text
    }
    if (lacking.length > 0) {
      await deps.writeInventory(
        inventoryFile,
        stringify(document as Record<string, unknown>),
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

    deps.io.info(
      shared === null
        ? `✅ The key of ${identityAccount} is in 1Password, and the inventory points at it.`
        : `✅ The key of ${identityAccount} is the key in 1Password, and the entries that lacked the reference point at it now.`,
    )
    deps.io.info(`   ref    ${ref.text}`)
    deps.io.info(`   hosts  ${lacking.join(', ')}`)
    deps.io.info(
      `   check it: slv v keys:check -n ${network} -p ${host}`,
    )
    deps.io.info(
      `   The key file ${keyPath} was not removed. Remove it yourself after you have checked the key.`,
    )
    if (unsaved !== null) {
      return refuse(
        `The vault could not be written to keyless.yml (${unsaved}). Add networks.${network}.vault_id: ${vaultId} to it yourself; slv reads no other vault.`,
      )
    }
    return true
  } catch (error) {
    if (
      error instanceof ImportRefusal || error instanceof OpRefusal ||
      error instanceof ResolveError
    ) {
      return refuse(error.message)
    }
    return refuse(`keys:import stopped: ${describe(error)}`)
  } finally {
    zero(keypair, canonical, template)
  }
}

export { defaultImportDeps, importKey }
export type { ImportDeps, ImportOptions }
