import { assert, assertEquals } from '@std/assert'
import {
  ALLOWED_IMAGE_MIME,
  explainImageParseError,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGES_BASE64_BYTES,
  messageInputToContent,
  parseImagesParam,
} from '/src/ai/core/messageInput.ts'

const smallB64 = 'AAAA' // 3 bytes of 0 when decoded

Deno.test('parseImagesParam: undefined → empty', () => {
  const r = parseImagesParam(undefined)
  assert(r.ok)
  if (r.ok) assertEquals(r.images, [])
})

Deno.test('parseImagesParam: null → empty', () => {
  const r = parseImagesParam(null)
  assert(r.ok)
})

Deno.test('parseImagesParam: non-array → error', () => {
  const r = parseImagesParam({ not: 'array' })
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'not_array')
})

Deno.test('parseImagesParam: too many images → error with count', () => {
  const many = Array.from(
    { length: MAX_IMAGES_PER_MESSAGE + 1 },
    () => ({ mime: 'image/png', base64: smallB64 }),
  )
  const r = parseImagesParam(many)
  assert(!r.ok)
  if (!r.ok) {
    assertEquals(r.error.kind, 'too_many')
    if (r.error.kind === 'too_many') {
      assertEquals(r.error.count, MAX_IMAGES_PER_MESSAGE + 1)
    }
  }
})

Deno.test('parseImagesParam: bad shape (not object) → error', () => {
  const r = parseImagesParam(['not-an-object'])
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'bad_shape')
})

Deno.test('parseImagesParam: missing mime → bad_mime error', () => {
  const r = parseImagesParam([{ base64: smallB64 }])
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'bad_mime')
})

Deno.test('parseImagesParam: rejects image/heic (not in allowlist)', () => {
  const r = parseImagesParam([{ mime: 'image/heic', base64: smallB64 }])
  assert(!r.ok)
  if (!r.ok && r.error.kind === 'bad_mime') {
    assertEquals(r.error.value, 'image/heic')
  }
})

Deno.test('parseImagesParam: accepts every allowlisted mime', () => {
  for (const mime of ALLOWED_IMAGE_MIME) {
    const r = parseImagesParam([{ mime, base64: smallB64 }])
    assert(r.ok, `expected ok for ${mime}`)
  }
})

Deno.test('parseImagesParam: rejects data:...;base64, prefix', () => {
  const r = parseImagesParam([{
    mime: 'image/png',
    base64: 'data:image/png;base64,AAAA',
  }])
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'bad_base64')
})

Deno.test('parseImagesParam: rejects whitespace in base64', () => {
  const r = parseImagesParam([{ mime: 'image/png', base64: 'AA AA' }])
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'bad_base64')
})

Deno.test('parseImagesParam: rejects empty base64', () => {
  const r = parseImagesParam([{ mime: 'image/png', base64: '' }])
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'bad_base64')
})

Deno.test('parseImagesParam: rejects per-image over-size', () => {
  const tooBig = 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1)
  const r = parseImagesParam([{ mime: 'image/png', base64: tooBig }])
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'too_large')
})

Deno.test('parseImagesParam: rejects total-over-size across multiple images', () => {
  // Build enough well-formed per-image payloads to exceed the combined cap.
  // Each image is the per-image max (5 MiB of base64); two of those already
  // exceed the 20 MiB combined cap at MAX_IMAGES_PER_MESSAGE=5 only when
  // we try 5 of them. Use 5 to keep the count check satisfied.
  const perImage = 'A'.repeat(MAX_IMAGE_BASE64_BYTES)
  const imgs = Array.from(
    { length: 5 },
    () => ({ mime: 'image/png', base64: perImage }),
  )
  const r = parseImagesParam(imgs)
  assert(!r.ok)
  if (!r.ok) assertEquals(r.error.kind, 'total_too_large')
})

Deno.test('explainImageParseError: each variant produces a non-empty message', () => {
  const variants = [
    { kind: 'not_array' as const },
    { kind: 'too_many' as const, count: 99 },
    { kind: 'bad_shape' as const, index: 0 },
    { kind: 'bad_mime' as const, index: 1, value: 'image/heic' },
    { kind: 'bad_base64' as const, index: 0 },
    { kind: 'too_large' as const, index: 0, bytes: MAX_IMAGE_BASE64_BYTES + 1 },
    { kind: 'total_too_large' as const, bytes: MAX_TOTAL_IMAGES_BASE64_BYTES + 1 },
  ]
  for (const v of variants) {
    const msg = explainImageParseError(v)
    assert(msg.length > 0, `empty msg for ${v.kind}`)
  }
})

Deno.test('messageInputToContent: string input passes through as string', () => {
  assertEquals(messageInputToContent('hello'), 'hello')
})

Deno.test('messageInputToContent: object with no images collapses to text string', () => {
  assertEquals(messageInputToContent({ text: 'hi' }), 'hi')
  assertEquals(messageInputToContent({ text: 'hi', images: [] }), 'hi')
})

Deno.test('messageInputToContent: with images → [text, image...] block array', () => {
  const content = messageInputToContent({
    text: 'describe',
    images: [{ mime: 'image/png', base64: smallB64 }],
  })
  assert(Array.isArray(content))
  if (Array.isArray(content)) {
    assertEquals(content.length, 2)
    assertEquals(content[0], { type: 'text', text: 'describe' })
    assertEquals(content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: smallB64 },
    })
  }
})
