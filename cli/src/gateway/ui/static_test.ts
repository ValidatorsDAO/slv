import { assert, assertEquals } from '@std/assert'
import { renderChatHtml } from '/src/gateway/ui/static.ts'

Deno.test('rendered gateway update probe accepts a real canonical CalVer', async () => {
  const html = await renderChatHtml({ token: null, mode: 'local' })
  const start = html.indexOf('const validCalVer =')
  const end = html.indexOf('\n  const checkLatest =', start)
  assert(start >= 0 && end > start, 'rendered browser validator was not found')
  const validCalVer = new Function(`${html.slice(start, end)}\nreturn validCalVer`)() as (value: string) => boolean
  assertEquals(validCalVer('2026.10.12.1200'), true)
  assertEquals(validCalVer('2026.10.12.1260'), false)
  assertEquals(validCalVer('2026.010.12.1200'), false)
})
