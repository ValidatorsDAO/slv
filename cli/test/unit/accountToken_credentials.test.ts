import { assert, assertEquals, assertFalse } from '@std/assert'
import { parse } from '@std/yaml'

import {
  clearSlvCredentials,
  findStorageAccessKey,
  findUserApiAuth,
  isValidAccessToken,
  isValidApiKey,
  isValidStorageAccessKeyId,
  isValidStorageSecret,
} from '/lib/getApiKeyFromYml.ts'
import { userApiAuthHeader } from '/lib/userApi/auth.ts'
import { saveLogin } from '@/login/index.ts'

import {
  ACCESS_TOKEN,
  API_KEY,
  STORAGE_KEY_ID,
  STORAGE_SECRET,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const readYml = async (home: string) =>
  parse(await Deno.readTextFile(`${home}/.slv/api.yml`)) as {
    slv: Record<string, unknown>
    ai?: unknown
    lang?: unknown
    notifications?: unknown
  }

const userGetOk = (url: string) =>
  url.endsWith('/v3/user/get')
    ? new Response('{"id":"u"}', { status: 200 })
    : new Response('{}', { status: 404 })

const OTHER_SECTIONS = {
  ai: { provider: 'slv', model: 'SLV AI' },
  lang: 'ja',
  notifications: { discord_webhook: 'https://example.invalid/hook' },
}

Deno.test('f5: slv login saves into slv: and keeps the stored API key and every other section', async () => {
  await withHome(
    { slv: { api_key: API_KEY }, ...OTHER_SECTIONS },
    async (home) => {
      await withFetch(userGetOk, async (requests) => {
        const result = await saveLogin({ accessToken: ACCESS_TOKEN })
        assertEquals(result.ok, true)
        // the token is checked against user-api before it is written
        assertEquals(requests.length, 1)
        assertEquals(requests[0].authorization, `Bearer ${ACCESS_TOKEN}`)
      })
      const yml = await readYml(home)
      assertEquals(yml.slv.api_key, API_KEY)
      assertEquals(yml.slv.access_token, ACCESS_TOKEN)
      assertEquals(yml.ai, OTHER_SECTIONS.ai)
      assertEquals(yml.lang, 'ja')
      assertEquals(yml.notifications, OTHER_SECTIONS.notifications)
      const mode = (await Deno.stat(`${home}/.slv/api.yml`)).mode ?? 0
      assertEquals(mode & 0o777, 0o600)
    },
  )
})

Deno.test('f5: slv login keeps the stored values when a prompt is left empty and saves all four when given', async () => {
  await withHome({
    slv: { api_key: API_KEY, access_token: ACCESS_TOKEN },
  }, async (home) => {
    await withFetch(userGetOk, async () => {
      const result = await saveLogin({
        storageAccessKeyId: STORAGE_KEY_ID,
        storageSecret: STORAGE_SECRET,
      })
      assertEquals(result.ok, true)
    })
    const yml = await readYml(home)
    assertEquals(yml.slv, {
      api_key: API_KEY,
      access_token: ACCESS_TOKEN,
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    })
  })
})

Deno.test('f5: slv login writes nothing when the token is rejected or a value has the wrong shape', async () => {
  const before = { slv: { api_key: API_KEY }, ...OTHER_SECTIONS }
  await withHome(before, async (home) => {
    const original = await Deno.readTextFile(`${home}/.slv/api.yml`)

    await withFetch(() => new Response('{}', { status: 401 }), async () => {
      const rejected = await saveLogin({
        accessToken: ACCESS_TOKEN,
        apiKey: API_KEY,
      })
      assertEquals(rejected.ok, false)
    })

    await withFetch(userGetOk, async (requests) => {
      const badToken = await saveLogin({ accessToken: 'erpcat_short' })
      assertEquals(badToken.ok, false)
      // a storage key needs both halves
      const halfPair = await saveLogin({ storageAccessKeyId: STORAGE_KEY_ID })
      assertEquals(halfPair.ok, false)
      const badSecret = await saveLogin({
        storageAccessKeyId: STORAGE_KEY_ID,
        storageSecret: 'too short',
      })
      assertEquals(badSecret.ok, false)
      assertEquals(requests.length, 0, 'a malformed value reached user-api')
    })

    assertEquals(await Deno.readTextFile(`${home}/.slv/api.yml`), original)
  })
})

Deno.test('slv logout removes every credential in slv: and keeps the other sections', async () => {
  await withHome({
    slv: {
      api_key: API_KEY,
      access_token: ACCESS_TOKEN,
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    },
    ...OTHER_SECTIONS,
  }, async (home) => {
    await clearSlvCredentials()
    const yml = await readYml(home)
    assertEquals(yml.slv.api_key ?? null, null)
    assertEquals(yml.slv.access_token ?? null, null)
    assertEquals(yml.slv.storage_access_key_id ?? null, null)
    assertEquals(yml.slv.storage_secret ?? null, null)
    assertEquals(yml.ai, OTHER_SECTIONS.ai)
    assertEquals(yml.lang, 'ja')
    assertEquals(await findUserApiAuth(), null)
    assertEquals(await findStorageAccessKey(), null)
  })
})

Deno.test('the stored token and storage key are read back; the API key is never used as the user-api credential', async () => {
  await withHome({ slv: { api_key: API_KEY } }, async () => {
    assertEquals(await findUserApiAuth(), null)
  })
  await withHome({
    slv: {
      api_key: API_KEY,
      access_token: ACCESS_TOKEN,
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    },
  }, async () => {
    const auth = await findUserApiAuth()
    assert(auth)
    assertEquals(userApiAuthHeader(auth), `Bearer ${ACCESS_TOKEN}`)
    assertEquals(await findStorageAccessKey(), {
      id: STORAGE_KEY_ID,
      secret: STORAGE_SECRET,
    })
  })
  // a value of the wrong shape counts as not stored
  await withHome({
    slv: { access_token: API_KEY, storage_access_key_id: STORAGE_KEY_ID },
  }, async () => {
    assertEquals(await findUserApiAuth(), null)
    assertEquals(await findStorageAccessKey(), null)
  })
})

Deno.test('credential shapes match what the servers issue', () => {
  assert(isValidApiKey(API_KEY))
  assertFalse(isValidApiKey(ACCESS_TOKEN))

  assert(isValidAccessToken(ACCESS_TOKEN))
  assertFalse(isValidAccessToken(API_KEY))
  assertFalse(isValidAccessToken(ACCESS_TOKEN.slice(0, -1)))
  assertFalse(isValidAccessToken(`${ACCESS_TOKEN}A`))
  assertFalse(isValidAccessToken(ACCESS_TOKEN.replace('erpcat_', 'erpcsk_')))
  assertFalse(isValidAccessToken(`${ACCESS_TOKEN.slice(0, -1)}+`))

  assert(isValidStorageAccessKeyId(STORAGE_KEY_ID))
  assertFalse(isValidStorageAccessKeyId(STORAGE_KEY_ID.slice(0, -1)))
  assertFalse(isValidStorageAccessKeyId(STORAGE_KEY_ID.toUpperCase()))
  assertFalse(isValidStorageAccessKeyId('erpcsk_abcdefghij234561')) // 1 is not base32

  assert(isValidStorageSecret(STORAGE_SECRET))
  assertFalse(isValidStorageSecret(STORAGE_SECRET.slice(1)))
  assertFalse(isValidStorageSecret(`${STORAGE_SECRET.slice(1)}=`))
})
