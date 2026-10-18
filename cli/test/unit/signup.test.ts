import { assertEquals, assertFalse, assertStringIncludes } from '@std/assert'
import { signupAction } from '@/signup/index.ts'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'
import {
  runCaptured,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

Deno.test('signup opens account registration and hands off to login without saving credentials or making purchases', async () => {
  await withHome(null, async (home) => {
    const opened: string[] = []
    await withFetch(() => {
      throw new Error('signup must not make an API or payment request')
    }, async (requests) => {
      const outcome = await runCaptured(async () => {
        signupAction({
          openBrowser: (url) => {
            opened.push(url)
          },
        })
      })
      assertEquals(outcome.error, undefined)
      assertEquals(outcome.exit, null)
      assertEquals(requests, [])
      assertEquals(opened, [ERPC_DASHBOARD_URL])
      for (const command of ['slv login', 'slv onboard', 'slv c']) {
        assertStringIncludes(outcome.output, command)
      }
      assertStringIncludes(outcome.output, 'email verification')
      assertFalse(outcome.output.includes('€5'))
      assertFalse(outcome.output.includes('activate your API key'))
    })
    assertEquals(
      await Deno.stat(`${home}/.slv/api.yml`).then(() => true).catch(() =>
        false
      ),
      false,
    )
  })
})
