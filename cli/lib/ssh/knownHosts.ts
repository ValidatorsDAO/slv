import { join } from '@std/path'
import { configRoot } from '@cmn/constants/path.ts'

// The keys of nodes that slv trusts, and where it learns one. ~/.slv/known_hosts
// holds the pins, one line per key, keyed by `[address]:port` (the HostKeyAlias
// of the ssh configuration), apart from the ~/.ssh/known_hosts of the person.
// A key gets in only after it has been shown with its fingerprint and the person
// has typed yes: either a key that ~/.ssh/known_hosts already holds for the
// host, or, when it holds none, what ssh-keyscan returns.

const PINS_PATH = join(configRoot, 'known_hosts')

/**
 * The key type that is pinned, and the only one that the ssh configuration
 * accepts for a host. ssh-keyscan asks for each type over a connection of its
 * own, so a person who has checked the fingerprint of one key has not checked
 * the others.
 */
const KEY_TYPES: readonly string[] = ['ssh-ed25519']

type HostKey = {
  keyType: string
  /** The key as it is written in known_hosts. */
  base64: string
  /** SHA256:<unpadded base64>, as `ssh-keygen -l` prints it. */
  fingerprint: string
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!BASE64.test(text) || text.length % 4 !== 0) return null
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch (_error) {
    return null
  }
}

const encodeBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

/** The type name that a key blob starts with (a length and that many bytes). */
const blobKeyType = (blob: Uint8Array): string | null => {
  if (blob.length < 4) return null
  const length = (blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]
  if (length < 1 || length > 64 || 4 + length > blob.length) return null
  return new TextDecoder().decode(blob.slice(4, 4 + length))
}

const fingerprintOfBlob = async (
  blob: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob))
  return `SHA256:${encodeBase64(digest).replace(/=+$/, '')}`
}

/** A key from its type and base64 text, or null when it is not one of the pinned types or is not what its type says. */
const parseHostKey = async (
  keyType: string,
  base64: string,
): Promise<HostKey | null> => {
  if (!KEY_TYPES.includes(keyType)) return null
  const blob = decodeBase64(base64)
  if (blob === null || blobKeyType(blob) !== keyType) return null
  return { keyType, base64, fingerprint: await fingerprintOfBlob(blob) }
}

/** How known_hosts names a host and port: the host alone on port 22, `[host]:port` otherwise. */
const hostForms = (host: string, port: number): string[] =>
  port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`]

/**
 * True when the first field of a known_hosts line names one of `forms`. The
 * field is a list of names separated by commas, or a hash `|1|salt|HMAC`.
 * Wildcards are not interpreted and a line with a negation is not used: no
 * match only means that the key is asked for with ssh-keyscan instead.
 */
const fieldNames = async (
  field: string,
  forms: readonly string[],
): Promise<boolean> => {
  if (field.startsWith('|')) {
    const parts = field.split('|')
    if (parts.length !== 4 || parts[1] !== '1') return false
    const salt = decodeBase64(parts[2])
    if (salt === null) return false
    const key = await crypto.subtle.importKey(
      'raw',
      salt,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    )
    for (const form of forms) {
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(form)),
      )
      if (encodeBase64(mac) === parts[3]) return true
    }
    return false
  }
  const names = field.split(',')
  // A negation may exclude the very name that is asked for; such a line is not used.
  if (names.some((name) => name.startsWith('!'))) return false
  return names.some((name) => forms.includes(name))
}

/**
 * The keys that the text of a known_hosts file holds for a host and port,
 * without any that the file revokes.
 */
const findHostKeys = async (
  text: string,
  host: string,
  port: number,
): Promise<HostKey[]> => {
  const forms = hostForms(host, port)
  const revoked = new Set<string>()
  const found: HostKey[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3 || fields[0].startsWith('#')) continue
    if (fields[0] === '@revoked') {
      if (fields.length >= 4) revoked.add(fields[3])
      continue
    }
    if (fields[0].startsWith('@')) continue
    if (!(await fieldNames(fields[0], forms))) continue
    const key = await parseHostKey(fields[1], fields[2])
    if (key !== null && !found.some((k) => k.base64 === key.base64)) {
      found.push(key)
    }
  }
  return found.filter((key) => !revoked.has(key.base64))
}

/** The keys in the output of ssh-keyscan: `<host> <type> <key>` lines, with its `#` comments left out. */
const parseScan = async (output: string): Promise<HostKey[]> => {
  const found: HostKey[] = []
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 3 || fields[0].startsWith('#')) continue
    const key = await parseHostKey(fields[1], fields[2])
    if (key !== null && !found.some((k) => k.base64 === key.base64)) {
      found.push(key)
    }
  }
  return found
}

/** The lines to add to the pins for `alias`. */
const pinLines = (alias: string, keys: readonly HostKey[]): string[] =>
  keys.map((key) => `${alias} ${key.keyType} ${key.base64}`)

/** The text of the pins with `lines` added; one that is there already is not added twice. */
const withPins = (text: string | null, lines: readonly string[]): string => {
  const existing = text ?? ''
  const have = new Set(existing.split('\n').map((line) => line.trim()))
  const added = lines.filter((line) => !have.has(line))
  const base = existing === '' || existing.endsWith('\n')
    ? existing
    : `${existing}\n`
  return added.length === 0 ? existing : `${base}${added.join('\n')}\n`
}

export {
  blobKeyType,
  decodeBase64,
  encodeBase64,
  findHostKeys,
  fingerprintOfBlob,
  hostForms,
  KEY_TYPES,
  parseHostKey,
  parseScan,
  pinLines,
  PINS_PATH,
  withPins,
}
export type { HostKey }
