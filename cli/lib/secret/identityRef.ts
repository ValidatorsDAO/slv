import { BASE58_PUBKEY } from '/lib/secret/base58.ts'

// Where the staked identity key of a host is kept. `op://<vault id>/<item
// id>/keypair` is a field of a 1Password item, named by the ids and never by
// names. `file://<absolute path>` is a key file on this machine.

type IdentityRef =
  | { kind: 'op'; vaultId: string; itemId: string; text: string }
  | { kind: 'file'; path: string; legacy: boolean; text: string }

class IdentityRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityRefError'
  }
}

/** The ids of 1Password vaults and items: 26 lower-case letters and digits. */
const OP_ID = /^[a-z0-9]{26}$/
const FILE_PATH = /^\/[A-Za-z0-9._/-]+$/

/** Characters that never belong in a reference: spaces, control characters, a query. */
// deno-lint-ignore no-control-regex
const UNSAFE = /[\s\u0000-\u001f\u007f?]/

const KEYPAIR_FIELD = 'keypair'

type ParsedRef = { ref: IdentityRef; warnings: string[] }

/**
 * Reads a reference. With none, the host's key is the file ~/.slv/keys/<identity
 * account>.json of this machine, which is said once in a warning. It refuses
 * names in place of ids, sections, a query, a relative path, any other scheme
 * and `-`.
 */
const parseIdentityRef = (
  value: string | undefined,
  options: { identityAccount?: string; homeDir: string },
): ParsedRef => {
  if (value === undefined || value === '') {
    const identity = options.identityAccount ?? ''
    if (!BASE58_PUBKEY.test(identity)) {
      throw new IdentityRefError(
        'there is no reference, and no identity account to name the key file by',
      )
    }
    const path = `${options.homeDir}/.slv/keys/${identity}.json`
    if (!FILE_PATH.test(path)) {
      throw new IdentityRefError(
        'the home directory has characters that a key file path cannot have',
      )
    }
    return {
      ref: { kind: 'file', path, legacy: true, text: `file://${path}` },
      warnings: [
        `no identity_ref: reading the key file ~/.slv/keys/${identity}.json on this machine. Put the key in 1Password and use its reference instead`,
      ],
    }
  }
  if (value === '-') {
    throw new IdentityRefError('a key read from stdin is not supported')
  }
  if (UNSAFE.test(value)) {
    throw new IdentityRefError(
      'a reference has no spaces, control characters or query in it',
    )
  }
  if (value.startsWith('op://')) {
    const parts = value.slice('op://'.length).split('/')
    if (parts.length !== 3) {
      throw new IdentityRefError(
        'a 1Password reference is op://<vault id>/<item id>/keypair, with no section',
      )
    }
    const [vaultId, itemId, field] = parts
    if (!OP_ID.test(vaultId) || !OP_ID.test(itemId)) {
      throw new IdentityRefError(
        'a 1Password reference names the vault and the item by their ids (26 lower-case letters and digits), not by name',
      )
    }
    if (field !== KEYPAIR_FIELD) {
      throw new IdentityRefError(
        `a 1Password reference ends in /${KEYPAIR_FIELD}`,
      )
    }
    return {
      ref: { kind: 'op', vaultId, itemId, text: value },
      warnings: [],
    }
  }
  if (value.startsWith('file://')) {
    const path = value.slice('file://'.length)
    if (!FILE_PATH.test(path)) {
      throw new IdentityRefError(
        'a file reference is file:// and an absolute path of letters, digits, . _ - and /',
      )
    }
    const segments = path.split('/').slice(1)
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new IdentityRefError(
        'a file reference has no empty, . or .. segment in its path',
      )
    }
    return {
      ref: { kind: 'file', path, legacy: false, text: value },
      warnings: [],
    }
  }
  throw new IdentityRefError(
    'a reference is op://<vault id>/<item id>/keypair or file://<absolute path>',
  )
}

/** The reference of the `pubkey` field of the same 1Password item, a text field with no secret in it. */
const pubkeyFieldRef = (ref: IdentityRef): string | null =>
  ref.kind === 'op' ? `op://${ref.vaultId}/${ref.itemId}/pubkey` : null

export { IdentityRefError, parseIdentityRef, pubkeyFieldRef }
export type { IdentityRef, ParsedRef }
