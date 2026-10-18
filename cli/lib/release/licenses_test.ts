import { assertEquals } from 'jsr:@std/assert@1'
import {
  embeddedLicenses,
  printEmbeddedLicenses,
} from '/lib/release/licenses.ts'

Deno.test('embedded licenses preserve the canonical bytes exactly', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-licenses-' })
  const source = `${root}/THIRD_PARTY_NOTICES`
  const bytes = new Uint8Array([78, 79, 84, 73, 67, 69, 10, 0, 255])
  try {
    await Deno.writeFile(source, bytes)
    assertEquals(
      await embeddedLicenses(new URL(`file://${source}`)),
      bytes,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('licenses writes every byte after a partial writer result', async () => {
  const root = await Deno.makeTempDir({ prefix: 'slv-licenses-partial-' })
  const source = `${root}/THIRD_PARTY_NOTICES`
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 255])
  const output: number[] = []
  try {
    await Deno.writeFile(source, bytes)
    await printEmbeddedLicenses({
      async write(chunk) {
        const count = Math.min(2, chunk.length)
        output.push(...chunk.subarray(0, count))
        return count
      },
    }, new URL(`file://${source}`))
    assertEquals(new Uint8Array(output), bytes)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
