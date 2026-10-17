import { encodeBase58 } from '/lib/secret/base58.ts'

// A Solana keypair is 64 bytes: the 32-byte Ed25519 seed, then the 32-byte
// public key. In a file, in 1Password and on the stdin of agave-validator it is
// the text of a JSON array of those 64 integers. These helpers work on bytes
// only, so that the key is never a string that cannot be wiped, and no message
// they raise holds any of it.

const KEYPAIR_BYTES = 64
const SEED_BYTES = 32

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
])

class KeypairFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeypairFormatError'
  }
}

const isSpace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d

/**
 * The 64 bytes that the text of a keypair stands for: `[n,n,...]` with exactly
 * 64 integers from 0 to 255, in plain decimal, and spaces or line breaks around
 * the numbers and the brackets. Anything else is refused, and the message says
 * what is wrong with the shape, never what the text holds.
 */
const parseKeypairText = (text: Uint8Array): Uint8Array => {
  const refuse = (): never => {
    throw new KeypairFormatError(
      'not a Solana keypair: it has to be a JSON array of exactly 64 integers from 0 to 255',
    )
  }
  let at = 0
  const skipSpace = () => {
    while (at < text.length && isSpace(text[at])) at++
  }
  const keypair = new Uint8Array(KEYPAIR_BYTES)
  try {
    skipSpace()
    if (text[at++] !== 0x5b) refuse()
    for (let index = 0; index < KEYPAIR_BYTES; index++) {
      skipSpace()
      const start = at
      let value = 0
      while (at < text.length && text[at] >= 0x30 && text[at] <= 0x39) {
        value = value * 10 + (text[at] - 0x30)
        at++
        if (at - start > 3) refuse()
      }
      const length = at - start
      if (length === 0 || value > 255) refuse()
      // Plain decimal: no leading zeros.
      if (length > 1 && text[start] === 0x30) refuse()
      keypair[index] = value
      skipSpace()
      if (index < KEYPAIR_BYTES - 1) {
        if (text[at++] !== 0x2c) refuse()
      }
    }
    if (text[at++] !== 0x5d) refuse()
    skipSpace()
    if (at !== text.length) refuse()
    return keypair
  } catch (error) {
    keypair.fill(0)
    throw error
  }
}

/** The text of a keypair in the form that solana-keygen writes: `[n,n,...]`, no spaces. */
const keypairText = (keypair: Uint8Array): Uint8Array => {
  if (keypair.length !== KEYPAIR_BYTES) {
    throw new KeypairFormatError('a keypair has to be 64 bytes')
  }
  // Up to 3 digits and a comma for each byte, and the brackets.
  const out = new Uint8Array(KEYPAIR_BYTES * 4 + 2)
  let at = 0
  out[at++] = 0x5b
  for (let index = 0; index < KEYPAIR_BYTES; index++) {
    if (index > 0) out[at++] = 0x2c
    const value = keypair[index]
    if (value >= 100) out[at++] = 0x30 + Math.floor(value / 100)
    if (value >= 10) out[at++] = 0x30 + Math.floor(value / 10) % 10
    out[at++] = 0x30 + value % 10
  }
  out[at++] = 0x5d
  const text = out.slice(0, at)
  out.fill(0)
  return text
}

/** `bytes` the same length and content, compared without stopping at the first difference. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index]
  }
  return difference === 0
}

/** Overwrites each buffer with zeros. */
const zero = (...buffers: (Uint8Array | null | undefined)[]): void => {
  for (const buffer of buffers) buffer?.fill(0)
}

/**
 * The public key, in base58, of a keypair whose seed really yields the public
 * key stored in it (bytes 32 to 63). The proof is a signature: the seed signs a
 * random challenge and the stored public key verifies it, so the seed never
 * leaves the buffer it is in as an exported key or a string. With `expected`,
 * the public key also has to be that one.
 */
const proveKeypair = async (
  keypair: Uint8Array,
  expected?: string,
): Promise<string> => {
  if (keypair.length !== KEYPAIR_BYTES) {
    throw new KeypairFormatError('a keypair has to be 64 bytes')
  }
  const mismatch = (): never => {
    throw new KeypairFormatError(
      'the seed of the keypair does not give the public key stored in it',
    )
  }
  const pkcs8 = new Uint8Array(
    new ArrayBuffer(PKCS8_PREFIX.length + SEED_BYTES),
  )
  pkcs8.set(PKCS8_PREFIX, 0)
  pkcs8.set(keypair.subarray(0, SEED_BYTES), PKCS8_PREFIX.length)
  const publicBytes = new Uint8Array(
    new ArrayBuffer(KEYPAIR_BYTES - SEED_BYTES),
  )
  publicBytes.set(keypair.subarray(SEED_BYTES))
  try {
    let verified = false
    try {
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        'Ed25519',
        false,
        ['sign'],
      )
      const publicKey = await crypto.subtle.importKey(
        'raw',
        publicBytes,
        'Ed25519',
        false,
        ['verify'],
      )
      const challenge = crypto.getRandomValues(new Uint8Array(32))
      const signature = await crypto.subtle.sign(
        'Ed25519',
        privateKey,
        challenge,
      )
      verified = await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        signature,
        challenge,
      )
    } catch (_error) {
      verified = false
    }
    if (!verified) mismatch()
    const pubkey = encodeBase58(publicBytes)
    if (expected !== undefined && pubkey !== expected) {
      throw new KeypairFormatError(
        `the public key of the keypair is ${pubkey}, not ${expected}`,
      )
    }
    return pubkey
  } finally {
    zero(pkcs8)
  }
}

/** A new Ed25519 keypair, as the 64 bytes of a Solana keypair, made by WebCrypto. */
const generateKeypair = async (): Promise<Uint8Array> => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]) as CryptoKeyPair
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  )
  const publicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  )
  try {
    const known = pkcs8.length === PKCS8_PREFIX.length + SEED_BYTES &&
      sameBytes(pkcs8.subarray(0, PKCS8_PREFIX.length), PKCS8_PREFIX)
    if (!known || publicBytes.length !== KEYPAIR_BYTES - SEED_BYTES) {
      throw new KeypairFormatError(
        'WebCrypto exported an Ed25519 key in a form that is not known',
      )
    }
    const keypair = new Uint8Array(KEYPAIR_BYTES)
    keypair.set(pkcs8.subarray(PKCS8_PREFIX.length), 0)
    keypair.set(publicBytes, SEED_BYTES)
    return keypair
  } finally {
    zero(pkcs8)
  }
}

export {
  generateKeypair,
  KEYPAIR_BYTES,
  KeypairFormatError,
  keypairText,
  parseKeypairText,
  proveKeypair,
  sameBytes,
  SEED_BYTES,
  zero,
}
