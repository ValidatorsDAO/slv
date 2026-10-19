import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import type { IdentityRef } from '/lib/secret/identityRef.ts'
import {
  KeypairFormatError,
  keypairText,
  parseKeypairText,
  proveKeypair,
  zero,
} from '/lib/secret/keypairBytes.ts'
import { buildOpEnv, firstLine, type OpSpawn } from '/lib/secret/opCli.ts'

// Reads the staked identity key of a reference into memory as bytes, proves it,
// and hands the caller a buffer to write to the stdin of a command and to wipe.

class ResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResolveError'
  }
}

type ResolveDeps = {
  op: OpSpawn
  /** The absolute path of the op executable. */
  opPath: string
  parentEnv: (name: string) => string | undefined
  /** The service account token of keyless.yml for the network, or null. */
  token: string | null
  readFile: (path: string) => Promise<Uint8Array>
}

type ResolvedKeypair = {
  pubkey: string
  /** The text `[n,n,...]` of the keypair, as bytes. */
  canonical: Uint8Array
  /** Overwrites the buffer with zeros. */
  wipe: () => void
}

/** `op read -n <ref>`: stdin null, the environment of buildOpEnv, and the bytes of what it prints. */
const opRead = async (
  reference: string,
  deps: ResolveDeps,
): Promise<Uint8Array> => {
  const result = await deps.op(
    deps.opPath,
    ['read', '-n', reference],
    { env: buildOpEnv(deps.parentEnv, deps.token), stdin: null },
  )
  if (!result.success) {
    zero(result.stdout)
    const why = firstLine(result.stderr, deps.token ? [deps.token] : [])
    throw new ResolveError(
      `op could not read ${reference}${why ? `: ${why}` : ''}`,
    )
  }
  return result.stdout
}

/**
 * The keypair of a reference. The text is read as bytes, parsed to exactly 64
 * integers, proved (the seed has to give the public key stored in it, and the
 * public key has to be `expectedPubkey` when one is given), and written out
 * again in the canonical form. The buffers it read are wiped before it returns.
 */
const resolveIdentity = async (
  ref: IdentityRef,
  options: { expectedPubkey?: string },
  deps: ResolveDeps,
): Promise<ResolvedKeypair> => {
  const raw = ref.kind === 'op'
    ? await opRead(ref.text, deps)
    : await deps.readFile(ref.path)
  let keypair: Uint8Array | null = null
  try {
    keypair = parseKeypairText(raw)
    const pubkey = await proveKeypair(keypair, options.expectedPubkey)
    const canonical = keypairText(keypair)
    return { pubkey, canonical, wipe: () => zero(canonical) }
  } catch (error) {
    if (error instanceof KeypairFormatError) {
      throw new ResolveError(`${ref.text}: ${error.message}`)
    }
    throw error
  } finally {
    zero(raw, keypair)
  }
}

/**
 * The public key written in the `pubkey` field of the 1Password item: a text
 * field with no secret in it, read so that the key itself is not read before a
 * person has agreed. The caller checks it against the key when it reads that.
 */
const readPubkeyField = async (
  reference: string,
  deps: ResolveDeps,
): Promise<string> => {
  const bytes = await opRead(reference, deps)
  const text = new TextDecoder().decode(bytes).trim()
  zero(bytes)
  if (!BASE58_PUBKEY.test(text)) {
    throw new ResolveError(
      `${reference} is not a public key: the item has to have a pubkey field with one in it`,
    )
  }
  return text
}

export { opRead, readPubkeyField, ResolveError, resolveIdentity }
export type { ResolveDeps, ResolvedKeypair }
