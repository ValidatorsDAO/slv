import { assertEquals, assertFalse, assertStringIncludes } from '@std/assert'
import { parse } from '@std/yaml'

import * as login from '@/login/index.ts'

import {
  API_KEY,
  AUTH_TOKEN_URL,
  FAR_FUTURE,
  json,
  loggedIn,
  NEW_ACCESS_TOKEN,
  NEW_REFRESH_TOKEN,
  REFRESH_TOKEN,
  runCaptured,
  STORAGE_KEY_ID,
  STORAGE_SECRET,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const DEVICE_AUTHORIZATION_URL =
  'https://auth-api.erpc.global/oauth/device/authorization'
const USER_GET_URL = 'https://user-api.erpc.global/v3/user/get'
const DEVICE_CODE = 'test-device-code-must-stay-in-memory'
const USER_CODE = 'WDJB-MJHT'
const VERIFICATION_URI = 'https://auth-api.erpc.global/oauth/device'
const VERIFICATION_URI_COMPLETE = `${VERIFICATION_URI}?user_code=${USER_CODE}`

const OTHER_SECTIONS = {
  ai: { provider: 'slv', model: 'SLV AI' },
  lang: 'ja',
}

const deviceAuthorization = () =>
  json({
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: VERIFICATION_URI,
    verification_uri_complete: VERIFICATION_URI_COMPLETE,
    expires_in: 900,
    interval: 5,
  })

const tokens = () =>
  json({
    access_token: NEW_ACCESS_TOKEN,
    refresh_token: NEW_REFRESH_TOKEN,
    token_type: 'Bearer',
    expires_in: 3600,
  })

/** A clock that only moves when the login waits. */
const fakeTime = (start: number) => {
  const waits: number[] = []
  const opened: string[] = []
  let clock = start
  return {
    waits,
    opened,
    deps: {
      sleep: (ms: number) => {
        waits.push(ms)
        clock += ms / 1000
        return Promise.resolve()
      },
      now: () => clock,
      openBrowser: (url: string) => {
        opened.push(url)
      },
    },
  }
}

const form = (body: string | null) => new URLSearchParams(body ?? '')

Deno.test('d1: slv login runs the device flow, checks the account with the new token, then saves the session', async () => {
  await withHome({
    slv: {
      api_key: API_KEY,
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    },
    ...OTHER_SECTIONS,
  }, async (home) => {
    const polls = ['authorization_pending', 'slow_down', null]
    const time = fakeTime(1_000_000)
    await withFetch((url) => {
      if (url === DEVICE_AUTHORIZATION_URL) return deviceAuthorization()
      if (url === AUTH_TOKEN_URL) {
        const error = polls.shift()
        return error ? json({ error }, 400) : tokens()
      }
      if (url === USER_GET_URL) return json({ username: 'validator-op' })
      return json({}, 404)
    }, async (requests) => {
      const outcome = await runCaptured(() => login.loginAction(time.deps))
      assertEquals(outcome.error, undefined, outcome.output)
      assertEquals(outcome.exit, null, outcome.output)

      assertEquals(requests.map((r) => `${r.method} ${r.url}`), [
        `POST ${DEVICE_AUTHORIZATION_URL}`,
        `POST ${AUTH_TOKEN_URL}`,
        `POST ${AUTH_TOKEN_URL}`,
        `POST ${AUTH_TOKEN_URL}`,
        `GET ${USER_GET_URL}`,
      ])
      const start = form(requests[0].body)
      assertEquals(start.get('client_id'), 'erpc-cli')
      assertEquals(start.get('scope'), 'openid profile email')
      for (const poll of requests.slice(1, 4)) {
        const fields = form(poll.body)
        assertEquals(
          fields.get('grant_type'),
          'urn:ietf:params:oauth:grant-type:device_code',
        )
        assertEquals(fields.get('client_id'), 'erpc-cli')
        assertEquals(fields.get('device_code'), DEVICE_CODE)
      }
      // interval 5, then slow_down adds 5 seconds before the next poll
      assertEquals(time.waits, [5000, 5000, 10000])
      assertEquals(requests[4].authorization, `Bearer ${NEW_ACCESS_TOKEN}`)

      assertStringIncludes(outcome.output, VERIFICATION_URI_COMPLETE)
      assertStringIncludes(outcome.output, USER_CODE)
      assertStringIncludes(outcome.output, 'validator-op')
      assertFalse(outcome.output.includes(DEVICE_CODE))
      assertFalse(outcome.output.includes(NEW_ACCESS_TOKEN))
      assertFalse(outcome.output.includes(NEW_REFRESH_TOKEN))
      assertEquals(time.opened, [VERIFICATION_URI_COMPLETE])
    })

    const raw = await Deno.readTextFile(`${home}/.slv/api.yml`)
    assertFalse(raw.includes(DEVICE_CODE))
    const yml = parse(raw) as Record<string, unknown>
    assertEquals(yml.slv, {
      api_key: API_KEY,
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
      access_token: NEW_ACCESS_TOKEN,
      refresh_token: NEW_REFRESH_TOKEN,
      // the local clock when the tokens arrived (+20 s of waiting) + expires_in
      access_token_expires_at: 1_000_020 + 3600,
    })
    assertEquals(yml.ai, OTHER_SECTIONS.ai)
    assertEquals(yml.lang, OTHER_SECTIONS.lang)
    const mode = (await Deno.stat(`${home}/.slv/api.yml`)).mode ?? 0
    assertEquals(mode & 0o777, 0o600)
  })
})

Deno.test('d2: a denied or expired device login, or an account user-api does not know, exits 1 and writes nothing', async () => {
  const cases: [string, (url: string) => Response][] = [
    [
      'access_denied',
      (url) =>
        url === AUTH_TOKEN_URL
          ? json({ error: 'access_denied' }, 400)
          : json({ username: 'x' }),
    ],
    [
      'expired_token',
      (url) =>
        url === AUTH_TOKEN_URL
          ? json({ error: 'expired_token' }, 400)
          : json({ username: 'x' }),
    ],
    [
      'user-api 401',
      (url) =>
        url === AUTH_TOKEN_URL
          ? tokens()
          : json({ error: 'unauthorized' }, 401),
    ],
  ]
  for (const [name, answer] of cases) {
    await withHome(
      { slv: { api_key: API_KEY }, ...OTHER_SECTIONS },
      async (home) => {
        const before = await Deno.readTextFile(`${home}/.slv/api.yml`)
        const time = fakeTime(1_000_000)
        await withFetch(
          (url) =>
            url === DEVICE_AUTHORIZATION_URL
              ? deviceAuthorization()
              : answer(url),
          async () => {
            const outcome = await runCaptured(() =>
              login.loginAction(time.deps)
            )
            assertEquals(outcome.error, undefined, `${name}: ${outcome.output}`)
            assertEquals(outcome.exit, 1, `${name}: ${outcome.output}`)
            assertStringIncludes(outcome.output, 'slv login')
            assertFalse(outcome.output.includes(DEVICE_CODE))
          },
        )
        assertEquals(
          await Deno.readTextFile(`${home}/.slv/api.yml`),
          before,
          `${name} changed api.yml`,
        )
      },
    )
  }
})

Deno.test('d3: slv login while signed in saves the new session, then revokes the old refresh token once (a 404 does not stop it)', async () => {
  const REVOKE_URL = 'https://auth-api.erpc.global/oauth/revoke'
  await withHome({
    slv: { api_key: API_KEY, ...loggedIn(FAR_FUTURE) },
  }, async (home) => {
    const time = fakeTime(1_000_000)
    await withFetch((url) => {
      if (url === DEVICE_AUTHORIZATION_URL) return deviceAuthorization()
      if (url === AUTH_TOKEN_URL) return tokens()
      if (url === USER_GET_URL) return json({ username: 'validator-op' })
      if (url === REVOKE_URL) return json({ error: 'not_found' }, 404)
      return json({}, 500)
    }, async (requests) => {
      const outcome = await runCaptured(() => login.loginAction(time.deps))
      assertEquals(outcome.error, undefined, outcome.output)
      assertEquals(outcome.exit, null, outcome.output)
      const revokes = requests.filter((r) => r.url === REVOKE_URL)
      assertEquals(revokes.length, 1)
      assertEquals(revokes[0].method, 'POST')
      assertEquals(
        new URLSearchParams(revokes[0].body ?? '').get('token'),
        REFRESH_TOKEN,
      )
      // after the new session is in place: the revoke is the last request
      assertEquals(requests.at(-1)?.url, REVOKE_URL)
      assertFalse(outcome.output.includes('not_found'))
      assertFalse(outcome.output.includes(REFRESH_TOKEN))
    })
    const slv = (parse(await Deno.readTextFile(`${home}/.slv/api.yml`)) as {
      slv: Record<string, unknown>
    }).slv
    assertEquals(slv.access_token, NEW_ACCESS_TOKEN)
    assertEquals(slv.refresh_token, NEW_REFRESH_TOKEN)
    assertEquals(slv.api_key, API_KEY)
  })
})
