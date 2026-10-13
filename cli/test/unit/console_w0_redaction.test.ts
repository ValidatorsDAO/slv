import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from '@std/assert'

import * as tools from '@/ai/console/tools.ts'
import { setAutoExecute, setTuiInstance } from '@/ai/console/tools.ts'
import { withHome } from '/test/unit/_credentialFixtures.ts'

type SafetyModule = {
  redactSecretKeys: (text: string) => Promise<string>
}

// Redaction lives in toolSafety.ts; it is loaded when a test runs.
const loadSafety = async (): Promise<SafetyModule> => {
  const specifier = '@/ai/console/toolSafety.ts'
  try {
    return await import(specifier) as SafetyModule
  } catch {
    throw new Error(`${specifier} cannot be loaded`)
  }
}

const redact = async (text: string): Promise<string> =>
  (await loadSafety()).redactSecretKeys(text)

const REDACTED = '[redacted secret key]'

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const encodeBase58 = (bytes: Uint8Array): string => {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  return '1'.repeat(zeros) +
    digits.reverse().map((d) => BASE58_ALPHABET[d]).join('')
}

const decodeLength = (text: string): number => {
  const bytes: number[] = []
  for (const ch of text) {
    let carry = BASE58_ALPHABET.indexOf(ch)
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  return zeros + bytes.length
}

type Keypair = { pair: CryptoKeyPair; secret: Uint8Array; text: string }

// A real Ed25519 key pair in the layout Solana uses: the 32-byte seed, then
// the 32-byte public key.
const newKeypair = async (): Promise<Keypair> => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]) as CryptoKeyPair
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  )
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  )
  const secret = new Uint8Array(64)
  secret.set(pkcs8.slice(16), 0)
  secret.set(publicKey, 32)
  return { pair, secret, text: encodeBase58(secret) }
}

// About one key pair in five is written with 87 characters, the rest with 88.
const keypairOfLength = async (length: number): Promise<Keypair> => {
  for (let i = 0; i < 400; i++) {
    const keypair = await newKeypair()
    if (keypair.text.length === length) return keypair
  }
  throw new Error(`no key pair of ${length} characters`)
}

// A real signature: 64 bytes made by signing with the key pair.
const signatureOfLength = async (
  pair: CryptoKeyPair,
  length: number,
): Promise<{ bytes: Uint8Array; text: string }> => {
  for (let i = 0; i < 400; i++) {
    const message = crypto.getRandomValues(new Uint8Array(64))
    const bytes = new Uint8Array(
      await crypto.subtle.sign('Ed25519', pair.privateKey, message),
    )
    const text = encodeBase58(bytes)
    if (text.length === length) return { bytes, text }
  }
  throw new Error(`no signature of ${length} characters`)
}

const filler = (length: number, seed = 1): string => {
  let out = ''
  let state = seed
  for (let i = 0; i < length; i++) {
    state = (state * 48271) % 2147483647
    out += BASE58_ALPHABET[state % BASE58_ALPHABET.length]
  }
  return out
}

const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n')

Deno.test('redaction hides a Solana keypair written as base58, 88 and 87 characters long', async () => {
  for (const length of [88, 87]) {
    const { text } = await keypairOfLength(length)
    assertEquals(text.length, length)
    assertEquals(await redact(text), REDACTED)
    assertEquals(await redact(`secret=${text}\n`), `secret=${REDACTED}\n`)
    assertEquals(await redact(`"${text}"`), `"${REDACTED}"`)
    assertEquals(
      await redact(`a ${text} b ${text} c`),
      `a ${REDACTED} b ${REDACTED} c`,
    )
  }
})

// The test key the repository keeps for its commit check (.husky). It was not
// made by this test; its base58 form was written out with two other encoders.
const REPOSITORY_TEST_KEY = [
  155,
  18,
  248,
  214,
  121,
  116,
  47,
  47,
  41,
  249,
  249,
  74,
  209,
  131,
  0,
  97,
  115,
  86,
  17,
  110,
  42,
  84,
  57,
  66,
  24,
  207,
  243,
  83,
  147,
  35,
  214,
  192,
  134,
  48,
  241,
  158,
  196,
  147,
  155,
  50,
  179,
  88,
  57,
  80,
  52,
  232,
  240,
  101,
  170,
  25,
  83,
  196,
  117,
  195,
  34,
  238,
  79,
  80,
  37,
  78,
  28,
  184,
  72,
  200,
]
const REPOSITORY_TEST_KEY_BASE58 =
  '46pqjgxnDXnSAFgVYgdEp5jgDgpAC5Qwa1x4MjNWkBa6yeDtzzQWYQznUFY31WoATcyqDJ9qPqoe6jkB9XjwHLa3'

Deno.test('redaction hides a Solana keypair made outside this test', async () => {
  assertEquals(
    encodeBase58(Uint8Array.from(REPOSITORY_TEST_KEY)),
    REPOSITORY_TEST_KEY_BASE58,
  )
  assertEquals(REPOSITORY_TEST_KEY_BASE58.length, 88)
  assertEquals(await redact(REPOSITORY_TEST_KEY_BASE58), REDACTED)
  assertEquals(await redact(JSON.stringify(REPOSITORY_TEST_KEY)), REDACTED)
  // the same bytes with the public half changed are no keypair
  const changed = Uint8Array.from(REPOSITORY_TEST_KEY)
  changed[40] ^= 1
  const text = encodeBase58(changed)
  assertEquals(await redact(text), text)
})

Deno.test('redaction hides a Solana keypair written as 64 integers', async () => {
  const { secret } = await newKeypair()
  const bytes = Array.from(secret)
  assertEquals(await redact(JSON.stringify(bytes)), REDACTED)
  assertEquals(
    await redact(`key: ${JSON.stringify(bytes)}\n`),
    `key: ${REDACTED}\n`,
  )
  assertEquals(await redact(JSON.stringify(bytes, null, 2)), REDACTED)
  assertEquals(await redact(`[ ${bytes.join(' , ')} ]`), REDACTED)
})

Deno.test('redaction shows a transaction signature as long as a keypair', async () => {
  const { pair } = await newKeypair()
  for (const length of [88, 87]) {
    const signature = await signatureOfLength(pair, length)
    assertEquals(signature.text.length, length)
    assertEquals(decodeLength(signature.text), 64)
    assertEquals(await redact(signature.text), signature.text)
    const line = `Signature: ${signature.text}\nStatus: Finalized\n`
    assertEquals(await redact(line), line)
  }
})

Deno.test('redaction shows 64 bytes that are not a keypair, and a string of another size', async () => {
  const keypair = await keypairOfLength(88)
  const sameSeedOtherHalf = keypair.secret.slice()
  sameSeedOtherHalf[63] ^= 1
  const otherSeed = keypair.secret.slice()
  otherSeed[0] ^= 1
  const random = crypto.getRandomValues(new Uint8Array(64))
  random[0] = 0x80
  const larger = crypto.getRandomValues(new Uint8Array(65))
  larger[0] = 1
  for (const bytes of [sameSeedOtherHalf, otherSeed, random, larger]) {
    const text = encodeBase58(bytes)
    if (text.length !== 87 && text.length !== 88) continue
    assertEquals(await redact(text), text, `${bytes.length} bytes`)
  }
  // the 65-byte value is written with 88 characters in about half the draws;
  // make sure the case is exercised at least once
  let exercised = false
  for (let i = 0; i < 200 && !exercised; i++) {
    const value = crypto.getRandomValues(new Uint8Array(65))
    value[0] = 1
    const text = encodeBase58(value)
    if (text.length === 88) {
      assertEquals(decodeLength(text), 65)
      assertEquals(await redact(text), text)
      exercised = true
    }
  }
  assert(exercised, 'no 88-character string of 65 bytes was drawn')
})

Deno.test('redaction hides the value when the check throws', async () => {
  const keypair = await keypairOfLength(88)
  const signature = (await signatureOfLength(keypair.pair, 88)).text
  assertEquals(await redact(signature), signature, 'the signature is shown')

  const subtle = crypto.subtle as unknown as Record<string, unknown>
  const failures: Record<string, () => unknown> = {
    importKey: () => Promise.reject(new Error('import failed')),
    exportKey: () => Promise.reject(new Error('export failed')),
    // an export that has no public key in it
    exportKeyEmpty: () => Promise.resolve({}),
    importKeySync: () => {
      throw new Error('import threw')
    },
  }
  for (const [name, replacement] of Object.entries(failures)) {
    const method = name.startsWith('import') ? 'importKey' : 'exportKey'
    const had = Object.hasOwn(subtle, method)
    const original = subtle[method]
    subtle[method] = replacement
    try {
      assertEquals(await redact(signature), REDACTED, name)
      assertEquals(
        await redact(`before ${signature} after`),
        `before ${REDACTED} after`,
        name,
      )
    } finally {
      if (had) subtle[method] = original
      else delete subtle[method]
    }
  }
  assertEquals(await redact(signature), signature, 'the check works again')
})

Deno.test('a key array and a PEM private key are hidden whatever they hold', async () => {
  const notAKeypair = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)
  assertEquals(await redact(JSON.stringify(notAKeypair)), REDACTED)
  const pem = await redact(`head\n${PEM}tail`)
  assertFalse(pem.includes('b3BlbnNzaC1rZXk'))
  assertStringIncludes(pem, REDACTED)
  assertStringIncludes(pem, 'head')
  assertStringIncludes(pem, 'tail')
  assertFalse(
    (await redact(
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAA',
    ))
      .includes('MIIEvQ'),
    'a key cut off before its end line',
  )
})

Deno.test('redaction leaves ordinary output unchanged', async () => {
  const bytes = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)
  const keypair = await keypairOfLength(88)
  const ordinary = [
    '',
    'hello world\n',
    'total 8\ndrwxr-xr-x 2 u u 4096 Oct 13 12:00 .\n',
    JSON.stringify(bytes.slice(0, 63)),
    JSON.stringify([...bytes, 1]),
    JSON.stringify(bytes.map((n, i) => (i === 10 ? 256 : n))),
    JSON.stringify(Array.from({ length: 64 }, () => 'a')),
    '[1, 2, 3]',
    // a public key (43-44 characters), a short token, a hash
    filler(44),
    filler(43, 3),
    filler(86, 5),
    filler(89, 5),
    filler(120, 7),
    '0'.repeat(88),
    '0OIl'.repeat(22),
    'f'.repeat(64),
    // 87 and 88 characters of base58 that are not a keypair
    filler(88, 11),
    filler(87, 13),
    // the public half of a keypair on its own
    encodeBase58(keypair.secret.slice(32)),
    '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  ]
  for (const text of ordinary) {
    assertEquals(await redact(text), text, text.slice(0, 40))
  }
})

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
  }
}

Deno.test('run_command and read_file results come back redacted', async () => {
  await withHome(null, async (home) => {
    try {
      setTuiInstance(null)
      setAutoExecute(true)
      const keypair = await keypairOfLength(88)
      const signature = (await signatureOfLength(keypair.pair, 88)).text
      const json = JSON.stringify(Array.from(keypair.secret))
      const file = `${home}/data.txt`
      await Deno.writeTextFile(
        file,
        `${json}\n${keypair.text}\nSignature: ${signature}\nplain line\n`,
      )

      const viaCommand = await quiet(() =>
        tools.executeTool('run_command', { command: `cat '${file}'` })
      )
      const viaError = await quiet(() =>
        tools.executeTool('run_command', {
          command: `cat '${file}' >&2; false`,
        })
      )
      const viaFile = await tools.executeTool('read_file', {
        path: file,
        refresh: true,
      })

      for (const output of [viaCommand, viaError, viaFile]) {
        assertStringIncludes(output, REDACTED)
        assertStringIncludes(output, 'plain line')
        assertStringIncludes(output, `Signature: ${signature}`)
        assertFalse(output.includes(keypair.text), 'the base58 keypair')
        assertFalse(output.includes(json), 'the integer array')
      }
    } finally {
      setAutoExecute(true)
      setTuiInstance(null)
    }
  })
})

Deno.test('a key cut by the output limit is redacted before it is cut', async () => {
  await withHome(null, async (home) => {
    try {
      setTuiInstance(null)
      setAutoExecute(true)
      const keypair = await keypairOfLength(88)
      const file = `${home}/long.txt`
      // the key sits where the 10,000-character limit cuts the output
      await Deno.writeTextFile(file, `${keypair.text}\n${'x'.repeat(9_970)}\n`)
      const output = await quiet(() =>
        tools.executeTool('run_command', { command: `cat '${file}'` })
      )
      assertFalse(
        output.includes(keypair.text.slice(-25)),
        'the tail of the key',
      )
      assertFalse(
        output.includes(keypair.text.slice(0, 25)),
        'the head of the key',
      )
      assertStringIncludes(output, REDACTED)
    } finally {
      setAutoExecute(true)
      setTuiInstance(null)
    }
  })
})
