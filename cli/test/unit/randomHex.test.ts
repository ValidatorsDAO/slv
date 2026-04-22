import { assertEquals, assertMatch } from '@std/assert'
import { randomHex } from '/lib/randomHex.ts'

Deno.test('randomHex returns the requested byte count as 2x hex chars', () => {
  assertEquals(randomHex(1).length, 2)
  assertEquals(randomHex(16).length, 32)
  assertEquals(randomHex(32).length, 64)
})

Deno.test('randomHex uses only lowercase 0-9a-f', () => {
  for (let i = 0; i < 20; i++) {
    assertMatch(randomHex(32), /^[0-9a-f]+$/)
  }
})

Deno.test('randomHex produces distinct outputs for back-to-back calls', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) {
    seen.add(randomHex(16))
  }
  // 128 bits of entropy × 100 calls — the chance of a collision is
  // vanishingly small; if this fails, crypto.getRandomValues is broken.
  assertEquals(seen.size, 100)
})
