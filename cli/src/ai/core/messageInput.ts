/**
 * Shared shape for "one turn of user input" as it flows through
 * Session → driver → provider. Historically this was just a plain
 * string; we widen it to an object so image attachments can ride
 * alongside the text without changing every touchpoint again.
 *
 * Image payloads are validated at the WS boundary (`session.send`
 * handler in `src/gateway/ws/router.ts`) and treated as trusted by
 * every layer below — providers just splice them into the
 * Anthropic-compatible content array and forward.
 */

/**
 * Mime types accepted by Anthropic's vision API (and therefore by
 * the erpc `/v3/ai/chat` proxy). Anything else is a guaranteed 400
 * upstream, so we reject client-side.
 */
export const ALLOWED_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export type ImageMime = typeof ALLOWED_IMAGE_MIME[number]

/** A single image attachment — raw base64, no `data:...` prefix. */
export type ImageInput = {
  mime: ImageMime
  /** Raw base64 string. A 3 MB image decodes from ~4 MB of this. */
  base64: string
}

/**
 * One user turn. `string` stays as a convenience shorthand for the
 * common text-only case; the object form carries optional images.
 */
export type MessageInput = string | {
  text: string
  images?: readonly ImageInput[]
}

/** Narrow helper so callers don't have to re-do the discriminant. */
export const getMessageText = (input: MessageInput): string =>
  typeof input === 'string' ? input : input.text

/** Narrow helper: empty array for the text-only case. */
export const getMessageImages = (input: MessageInput): readonly ImageInput[] =>
  typeof input === 'string' ? [] : (input.images ?? [])

/**
 * Anthropic content-block shape for base64 images. Matches what the
 * erpc proxy (and Anthropic SDK) expect — the proxy validates the
 * same shape on its end so our provider layer just needs to build
 * it correctly here.
 */
export type AnthropicImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    media_type: ImageMime
    data: string
  }
}

export type AnthropicTextBlock = {
  type: 'text'
  text: string
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock

/**
 * Convert a MessageInput into the Anthropic `messages[].content`
 * payload. Text-only input collapses to a string (the simplest form
 * Anthropic accepts); any attached images force an array form with
 * the text as the first block and images as subsequent blocks.
 *
 * Order matters for Anthropic — text-first then images works well
 * for describe-this-image prompts; callers with a different layout
 * requirement can bypass this helper.
 */
export const messageInputToContent = (
  input: MessageInput,
): string | AnthropicContentBlock[] => {
  if (typeof input === 'string') return input
  const images = input.images ?? []
  if (images.length === 0) return input.text
  const blocks: AnthropicContentBlock[] = [
    { type: 'text', text: input.text },
  ]
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mime,
        data: img.base64,
      },
    })
  }
  return blocks
}

/**
 * Conservative per-request caps chosen to match the erpc /v3/ai/chat
 * proxy limits with a small buffer for text + headers:
 *   - MAX_IMAGES_PER_MESSAGE = 5 (erpc allows up to 100 — 5 is plenty
 *     for a human chat UI and keeps base64 payloads small)
 *   - MAX_IMAGE_BASE64_BYTES = 5 MiB (Anthropic's per-image cap —
 *     equivalent to ~3.6 MB of raw image bytes)
 *   - MAX_TOTAL_IMAGES_BASE64_BYTES = 20 MiB (erpc rejects the full
 *     body at 25 MiB; 20 leaves room for text + system prompt)
 */
export const MAX_IMAGES_PER_MESSAGE = 5
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGES_BASE64_BYTES = 20 * 1024 * 1024

const IMAGE_MIME_SET = new Set<string>(ALLOWED_IMAGE_MIME)
// Raw base64 alphabet (no whitespace, no data-URI prefix). `=` padding
// is allowed only at the end; length must be a multiple of 4. The WS
// router validates with this before we ship anything to the provider.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

export type ImageParseError =
  | { kind: 'not_array' }
  | { kind: 'too_many'; count: number }
  | { kind: 'bad_shape'; index: number }
  | { kind: 'bad_mime'; index: number; value: string }
  | { kind: 'bad_base64'; index: number }
  | { kind: 'too_large'; index: number; bytes: number }
  | { kind: 'total_too_large'; bytes: number }

export type ImageParseResult =
  | { ok: true; images: ImageInput[] }
  | { ok: false; error: ImageParseError }

/**
 * Runtime validator for the untrusted `images` field on
 * `session.send`. Returns a structured error (for precise WS error
 * messages) rather than throwing so callers can surface
 * `params.images[2]: bad media_type "image/heic"` verbatim.
 */
export const parseImagesParam = (raw: unknown): ImageParseResult => {
  if (raw === undefined || raw === null) return { ok: true, images: [] }
  if (!Array.isArray(raw)) return { ok: false, error: { kind: 'not_array' } }
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, error: { kind: 'too_many', count: raw.length } }
  }
  const out: ImageInput[] = []
  let total = 0
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== 'object') {
      return { ok: false, error: { kind: 'bad_shape', index: i } }
    }
    const rec = item as Record<string, unknown>
    const mime = typeof rec.mime === 'string' ? rec.mime : ''
    const base64 = typeof rec.base64 === 'string' ? rec.base64 : ''
    if (!IMAGE_MIME_SET.has(mime)) {
      return {
        ok: false,
        error: { kind: 'bad_mime', index: i, value: mime },
      }
    }
    if (base64.length === 0 || !BASE64_RE.test(base64)) {
      return { ok: false, error: { kind: 'bad_base64', index: i } }
    }
    if (base64.length > MAX_IMAGE_BASE64_BYTES) {
      return {
        ok: false,
        error: { kind: 'too_large', index: i, bytes: base64.length },
      }
    }
    total += base64.length
    out.push({ mime: mime as ImageMime, base64 })
  }
  if (total > MAX_TOTAL_IMAGES_BASE64_BYTES) {
    return { ok: false, error: { kind: 'total_too_large', bytes: total } }
  }
  return { ok: true, images: out }
}

/** Human-readable error message for each ImageParseError variant. */
export const explainImageParseError = (e: ImageParseError): string => {
  switch (e.kind) {
    case 'not_array':
      return 'params.images must be an array of { mime, base64 }'
    case 'too_many':
      return `too many images (${e.count}); max ${MAX_IMAGES_PER_MESSAGE} per message`
    case 'bad_shape':
      return `params.images[${e.index}] must be { mime, base64 }`
    case 'bad_mime':
      return `params.images[${e.index}].mime "${e.value}" — allowed: ${
        ALLOWED_IMAGE_MIME.join(', ')
      }`
    case 'bad_base64':
      return `params.images[${e.index}].base64 must be raw base64 (no data:… prefix, no whitespace)`
    case 'too_large': {
      const mb = (e.bytes / (1024 * 1024)).toFixed(1)
      return `params.images[${e.index}] is ${mb} MB; per-image max ${
        Math.round(MAX_IMAGE_BASE64_BYTES / (1024 * 1024))
      } MiB of base64`
    }
    case 'total_too_large': {
      const mb = (e.bytes / (1024 * 1024)).toFixed(1)
      return `images total ${mb} MB; max ${
        Math.round(MAX_TOTAL_IMAGES_BASE64_BYTES / (1024 * 1024))
      } MiB combined`
    }
  }
}
