import { assertEquals, assertStringIncludes } from '@std/assert'

import { formatLink, wrapText } from '@/ai/rendering.ts'

Deno.test('wrapText still wraps prose to the available width', () => {
  const wrapped = wrapText(
    'This description should wrap nicely without breaking the overall responsive layout.',
    32,
    '  ',
    '  ',
  )

  assertEquals(wrapped, [
    '  This description should wrap',
    '  nicely without breaking the',
    '  overall responsive layout.',
  ].join('\n'))
})

Deno.test('formatLink keeps actionable URLs on their own intact line', () => {
  const url =
    'https://example.com/checkout/session/abc123/authorize?token=very-long-token-value&plan=premium'

  const formatted = formatLink('Purchase', url, 40)
  const lines = formatted.split('\n')

  assertEquals(lines.length, 2)
  // Label may contain ANSI colour codes; strip them before checking
  const plain = lines[0].replace(/\x1b\[[0-9;]*m/g, '')
  assertStringIncludes(plain, 'Purchase:')
  assertEquals(lines[1], `    ${url}`)
})
