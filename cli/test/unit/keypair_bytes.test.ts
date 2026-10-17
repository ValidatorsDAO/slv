import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from '@std/assert'
import { encodeBase58 } from '/lib/secret/base58.ts'
import {
  generateKeypair,
  KEYPAIR_BYTES,
  KeypairFormatError,
  keypairText,
  parseKeypairText,
  proveKeypair,
  sameBytes,
  zero,
} from '/lib/secret/keypairBytes.ts'

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

// RFC 8032, section 7.1, tests 1 and 2: a seed and the public key it gives.
const SEED_1 = hex(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
)
const PUBLIC_1 = hex(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
)
const PUBKEY_1 = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'
const SEED_2 = hex(
  '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
)
const PUBLIC_2 = hex(
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
)
const PUBKEY_2 = '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5'

const keypairOf = (seed: Uint8Array, publicBytes: Uint8Array): Uint8Array => {
  const keypair = new Uint8Array(KEYPAIR_BYTES)
  keypair.set(seed, 0)
  keypair.set(publicBytes, 32)
  return keypair
}

const arrayText = (values: number[]): string => `[${values.join(',')}]`
const SIXTY_FOUR = Array.from({ length: 64 }, (_, i) => (i * 7) % 256)

Deno.test('base58 gives the known answers of the Solana alphabet', () => {
  assertEquals(encodeBase58(new Uint8Array(32)), '1'.repeat(32))
  assertEquals(encodeBase58(Uint8Array.from([0, 0, 1, 2, 3])), '11Ldp')
  assertEquals(
    encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => i)),
    '1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE',
  )
  assertEquals(
    encodeBase58(new Uint8Array(32).fill(255)),
    'JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG',
  )
  assertEquals(encodeBase58(PUBLIC_1), PUBKEY_1)
})

Deno.test('a keypair text of exactly 64 integers is read with spaces and a line break around them, and rebuilt as solana-keygen writes it', () => {
  for (
    const text of [
      arrayText(SIXTY_FOUR),
      `${arrayText(SIXTY_FOUR)}\n`,
      `\n  [ ${SIXTY_FOUR.join(' ,\n ')} ]\r\n`,
    ]
  ) {
    const bytes = parseKeypairText(encode(text))
    assertEquals([...bytes], SIXTY_FOUR)
    assertEquals(
      new TextDecoder().decode(keypairText(bytes)),
      arrayText(SIXTY_FOUR),
    )
  }
})

Deno.test('a keypair text is refused with 63 or 65 integers, 256, -1, a non-digit, a leading zero, base58 text or text after the array, and the message holds none of it', () => {
  const sixtyFour = (change: (values: string[]) => string[]): string =>
    `[${change(SIXTY_FOUR.map(String)).join(',')}]`
  const cases: [string, string][] = [
    ['63 integers', sixtyFour((v) => v.slice(1))],
    ['65 integers', sixtyFour((v) => [...v, '1'])],
    ['256', sixtyFour((v) => [...v.slice(1), '256'])],
    ['-1', sixtyFour((v) => [...v.slice(1), '-1'])],
    ['a non-digit', sixtyFour((v) => [...v.slice(1), '1x'])],
    ['a leading zero', sixtyFour((v) => [...v.slice(1), '007'])],
    ['a fraction', sixtyFour((v) => [...v.slice(1), '1.5'])],
    ['four digits', sixtyFour((v) => [...v.slice(1), '1000'])],
    ['no integer', sixtyFour((v) => [...v.slice(1), ''])],
    ['a trailing comma', `${arrayText(SIXTY_FOUR).slice(0, -1)},]`],
    ['no brackets', SIXTY_FOUR.join(',')],
    ['text after the array', `${arrayText(SIXTY_FOUR)} 1`],
    ['base58 text', PUBKEY_1],
    ['nothing', ''],
    ['the canary 222 in a short array', '[222,222,222]'],
  ]
  for (const [name, text] of cases) {
    const error = assertThrows(
      () => parseKeypairText(encode(text)),
      KeypairFormatError,
    )
    assert(
      !error.message.includes('222'),
      `${name}: the message holds the text`,
    )
    assert(
      !error.message.includes(PUBKEY_1),
      `${name}: the message holds the text`,
    )
  }
})

Deno.test('a keypair is proved by its own seed: the public key is the base58 text of bytes 32 to 63, a seed that does not give it is refused, and so is a public key that is not the expected one', async () => {
  assertEquals(await proveKeypair(keypairOf(SEED_1, PUBLIC_1)), PUBKEY_1)
  assertEquals(await proveKeypair(keypairOf(SEED_2, PUBLIC_2)), PUBKEY_2)
  assertEquals(
    await proveKeypair(keypairOf(SEED_1, PUBLIC_1), PUBKEY_1),
    PUBKEY_1,
  )

  // The seed of one, the public key of the other.
  await assertRejects(
    () => proveKeypair(keypairOf(SEED_1, PUBLIC_2)),
    KeypairFormatError,
    'does not give the public key',
  )
  // Bytes that are no point of the curve at all.
  await assertRejects(
    () => proveKeypair(keypairOf(SEED_1, new Uint8Array(32).fill(255))),
    KeypairFormatError,
  )
  // A valid keypair, but not the identity that was expected.
  await assertRejects(
    () => proveKeypair(keypairOf(SEED_1, PUBLIC_1), PUBKEY_2),
    KeypairFormatError,
    `is ${PUBKEY_1}, not ${PUBKEY_2}`,
  )
  await assertRejects(
    () => proveKeypair(new Uint8Array(63)),
    KeypairFormatError,
  )
})

Deno.test('a generated keypair has a random seed and the public key that proves, and zero wipes a buffer', async () => {
  const first = await generateKeypair()
  const second = await generateKeypair()
  assertEquals(first.length, KEYPAIR_BYTES)
  assertNotEquals(encodeBase58(first), encodeBase58(second))
  const pubkey = await proveKeypair(first)
  assertEquals(pubkey, encodeBase58(first.subarray(32)))
  // The text it is stored as reads back to the same bytes.
  assert(sameBytes(parseKeypairText(keypairText(first)), first))

  zero(first, null, undefined)
  assertEquals([...first], new Array(KEYPAIR_BYTES).fill(0))
  assert(!sameBytes(first, second))
})
