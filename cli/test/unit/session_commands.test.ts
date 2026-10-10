import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import { parse, stringify } from '@std/yaml'

import * as auth from '/lib/userApi/auth.ts'
import {
  findStorageAccessKey,
  isValidApiKey,
  isValidStorageAccessKeyId,
  isValidStorageSecret,
  mergeSlvCredentials,
} from '/lib/getApiKeyFromYml.ts'
import * as logout from '@/login/logout.ts'
import * as check from '@/check/index.ts'
import { aiUsageAction } from '@/ai/usage/usageAction.ts'
import { usageAction as storageUsageAction } from '@/storage/usage/usageAction.ts'
import { statusAction as metalStatusAction } from '@/metal/status/statusAction.ts'
import { uploadAction } from '@/storage/upload/uploadAction.ts'
import { downloadAction } from '@/storage/download/downloadAction.ts'
import { backupAction } from '@/backup/backupAction.ts'
import { listAction as backupListAction } from '@/backup/listAction.ts'
import { dnsCmd } from '@/dns/index.ts'
import { writeLang } from '@/ai/config.ts'
import { executeTool } from '@/ai/console/tools.ts'
import * as session from '/lib/userApi/session.ts'

import {
  ACCESS_TOKEN,
  API_KEY,
  AUTH_TOKEN_URL,
  EXPIRED,
  FAR_FUTURE,
  json,
  loggedIn,
  NEW_ACCESS_TOKEN,
  NEW_REFRESH_TOKEN,
  type RecordedRequest,
  REFRESH_TOKEN,
  runCaptured,
  STORAGE_KEY_ID,
  STORAGE_SECRET,
  withCommandStub,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const USER_API = 'https://user-api.erpc.global'
const REVOKE_URL = 'https://auth-api.erpc.global/oauth/revoke'
const ACCESS_KEYS_URL = `${USER_API}/v3/storage/access-keys`

const OTHER_SECTIONS = {
  ai: { provider: 'slv', model: 'SLV AI' },
  lang: 'ja',
  notifications: { discord_webhook: 'https://example.invalid/hook' },
}

const CREDENTIAL_KEYS = [
  'api_key',
  'access_token',
  'refresh_token',
  'access_token_expires_at',
  'storage_access_key_id',
  'storage_secret',
  'storage_access_key_record_id',
]

const readYml = async (home: string) =>
  parse(await Deno.readTextFile(`${home}/.slv/api.yml`)) as {
    slv: Record<string, unknown>
    [section: string]: unknown
  }

const toUserApi = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.url.startsWith(USER_API))
const toTokenEndpoint = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.url === AUTH_TOKEN_URL)

const rotated = () =>
  json({
    access_token: NEW_ACCESS_TOKEN,
    refresh_token: NEW_REFRESH_TOKEN,
    token_type: 'Bearer',
    expires_in: 3600,
  })

// Generic answers, good enough for the commands below to run to the end.
const answer = (url: string): Response => {
  if (url === AUTH_TOKEN_URL) return rotated()
  if (url.endsWith('/v3/dns/status')) {
    return json({
      default: {
        fqdn: 'u-abc.erpc.global',
        slug: 'u-abc',
        ip: '1.2.3.4',
        proxied: true,
        exists: true,
        updatedAt: null,
      },
      custom: [],
    })
  }
  if (url.endsWith('/v3/baremetal/status')) {
    return json({ success: true, message: [] })
  }
  if (url.endsWith('/v3/storage/usage')) {
    return json({
      usedBytes: 0,
      fileCount: 0,
      egressBytes: 0,
      storageLimitBytes: 1_000_000,
      region: 'eu',
    })
  }
  if (url.endsWith('/v3/storage/presign/upload')) {
    return json({
      url: 'https://files.example.invalid/put',
      method: 'PUT',
      region: 'eu',
      key: 'payload.txt',
      expiresAt: '2100-01-01T00:00:00Z',
    })
  }
  if (url.endsWith('/v3/storage/presign/download')) {
    return json({
      url: 'https://files.example.invalid/get',
      method: 'GET',
      region: 'eu',
      expiresAt: '2100-01-01T00:00:00Z',
    })
  }
  if (url.startsWith('https://files.example.invalid/')) {
    return new Response('hello')
  }
  return json({ message: {} })
}

// user-api commands that read the login from ~/.slv/api.yml themselves
const USER_API_COMMANDS: [string, () => Promise<unknown>][] = [
  ['slv ai usage', () => aiUsageAction()],
  ['slv storage usage', () => storageUsageAction({})],
  ['slv metal status', () => metalStatusAction()],
  ['slv dns status', () => dnsCmd.parse(['status'])],
]

const sessionAuth = (home: string) =>
  ({ kind: 'session', home }) as auth.UserApiAuth

Deno.test('r1: an expired access token is refreshed once before the command, and the rotated refresh token is saved', async () => {
  await withHome({ slv: loggedIn(EXPIRED) }, async (home) => {
    const before = Math.floor(Date.now() / 1000)
    await withFetch(answer, async (requests) => {
      const outcome = await runCaptured(() => storageUsageAction({}))
      assertEquals(outcome.error, undefined, outcome.output)
      assertEquals(outcome.exit, null, outcome.output)

      const refreshes = toTokenEndpoint(requests)
      assertEquals(refreshes.length, 1)
      const fields = new URLSearchParams(refreshes[0].body ?? '')
      assertEquals(fields.get('grant_type'), 'refresh_token')
      assertEquals(fields.get('refresh_token'), REFRESH_TOKEN)
      assertEquals(fields.get('client_id'), 'erpc-cli')

      const calls = toUserApi(requests)
      assert(calls.length > 0)
      for (const call of calls) {
        assertEquals(call.authorization, `Bearer ${NEW_ACCESS_TOKEN}`)
      }
      assertFalse(outcome.output.includes(NEW_REFRESH_TOKEN))
    })
    const slv = (await readYml(home)).slv
    assertEquals(slv.access_token, NEW_ACCESS_TOKEN)
    assertEquals(slv.refresh_token, NEW_REFRESH_TOKEN)
    assert(Number(slv.access_token_expires_at) >= before + 3600)
  })
})

Deno.test('r2: two requests that both find the access token expired send one refresh', async () => {
  await withHome({ slv: loggedIn(EXPIRED) }, async (home) => {
    await withFetch(async (url) => {
      // answer late so both callers are waiting on the refresh at once
      await new Promise((resolve) => setTimeout(resolve, 50))
      return answer(url)
    }, async (requests) => {
      const headers = await Promise.all([
        auth.userApiAuthHeader(sessionAuth(home)),
        auth.userApiAuthHeader(sessionAuth(home)),
      ])
      assertEquals(headers, [
        `Bearer ${NEW_ACCESS_TOKEN}`,
        `Bearer ${NEW_ACCESS_TOKEN}`,
      ])
      assertEquals(toTokenEndpoint(requests).length, 1)
    })
    assertEquals((await readYml(home)).slv.refresh_token, NEW_REFRESH_TOKEN)
  })
})

Deno.test('r3: a refresh that finds api.yml already refreshed by another process (after taking the lock) sends nothing', async () => {
  await withHome({ slv: loggedIn(EXPIRED) }, async (home) => {
    await withFetch(answer, async (requests) => {
      // Another process holds the lock while it refreshes.
      const other = await Deno.open(`${home}/.slv/api.yml.lock`, {
        create: true,
        write: true,
      })
      try {
        await other.lock(true)
        let settled = false
        const header = Promise.resolve(
          auth.userApiAuthHeader(sessionAuth(home)),
        ).finally(() => {
          settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 200))
        assertFalse(settled, 'the refresh did not wait for the lock')

        await Deno.writeTextFile(
          `${home}/.slv/api.yml`,
          stringify({
            slv: loggedIn(FAR_FUTURE, {
              access: NEW_ACCESS_TOKEN,
              refresh: NEW_REFRESH_TOKEN,
            }),
          }),
        )
        await other.unlock()
        assertEquals(await header, `Bearer ${NEW_ACCESS_TOKEN}`)
      } finally {
        other.close()
      }
      assertEquals(requests.length, 0)
    })
  })
})

Deno.test('r5: another api.yml writer that runs during a refresh does not put the old refresh token back', async () => {
  await withHome({ slv: loggedIn(EXPIRED), lang: 'en' }, async (home) => {
    const apiYml = `${home}/.slv/api.yml`
    const original = {
      writeTextFile: Deno.writeTextFile,
      rename: Deno.rename,
      readTextFile: Deno.readTextFile,
    }
    // A slow disk: a write of api.yml that still holds the old refresh token
    // lands only after the refresh has saved the new one. A writer that read
    // api.yml before the refresh saved (no lock) then puts the old one back.
    let refreshSaved = () => {}
    const saved = new Promise<void>((resolve) => {
      refreshSaved = resolve
    })
    const landLate = async (content: string) => {
      if (content.includes(NEW_REFRESH_TOKEN)) return
      await Promise.race([
        saved,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ])
    }
    const deno = Deno as unknown as Record<string, unknown>
    deno.writeTextFile = async (
      ...args: Parameters<typeof Deno.writeTextFile>
    ) => {
      if (String(args[0]) === apiYml) await landLate(String(args[1]))
      return await original.writeTextFile(...args)
    }
    deno.rename = async (from: string | URL, to: string | URL) => {
      if (String(to) !== apiYml) return await original.rename(from, to)
      const content = await original.readTextFile(from)
      await landLate(content)
      await original.rename(from, to)
      if (content.includes(NEW_REFRESH_TOKEN)) refreshSaved()
    }
    let writer: Promise<void> | null = null
    try {
      await withFetch(async (url) => {
        if (url === AUTH_TOKEN_URL && !writer) {
          // The refresh holds the lock now; another command saves a setting.
          writer = writeLang('ja')
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return answer(url)
      }, async (requests) => {
        assertEquals(
          await auth.userApiAuthHeader(sessionAuth(home)),
          `Bearer ${NEW_ACCESS_TOKEN}`,
        )
        assert(writer, 'the refresh was not sent')
        await writer
        assertEquals(toTokenEndpoint(requests).length, 1)
      })
    } finally {
      deno.writeTextFile = original.writeTextFile
      deno.rename = original.rename
    }
    const yml = await readYml(home)
    assertEquals(yml.slv.refresh_token, NEW_REFRESH_TOKEN)
    assertEquals(yml.slv.access_token, NEW_ACCESS_TOKEN)
    assertEquals(yml.lang, 'ja')
  })
})

Deno.test('r6: the AI console write_file tool does not write api.yml', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    const before = await Deno.readTextFile(`${home}/.slv/api.yml`)
    for (
      const path of [
        `${home}/.slv/api.yml`,
        `${home}/.slv/agent/../api.yml`,
      ]
    ) {
      const result = await executeTool('write_file', {
        path,
        content: 'slv: {}\n',
      })
      assert(result.startsWith('Error'), `${path}: ${result}`)
    }
    assertEquals(await Deno.readTextFile(`${home}/.slv/api.yml`), before)
  })
})

Deno.test('r7: the AI console read_file tool does not read api.yml, its lock or its temporary files', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    await Deno.writeTextFile(`${home}/.slv/api.yml.lock`, '')
    await Deno.writeTextFile(`${home}/.slv/.api.yml.0000.tmp`, 'slv: {}\n')
    const cwd = Deno.cwd()
    try {
      Deno.chdir(`${home}/.slv`)
      for (
        const path of [
          `${home}/.slv/api.yml`,
          `${home}/.slv/agent/../api.yml`,
          'api.yml',
          `${home}/.slv/api.yml.lock`,
          `${home}/.slv/.api.yml.0000.tmp`,
        ]
      ) {
        const result = await executeTool('read_file', { path, refresh: true })
        assert(result.startsWith('Error'), `${path}: ${result}`)
        assertFalse(result.includes(REFRESH_TOKEN), path)
      }
    } finally {
      Deno.chdir(cwd)
    }
  })
})

Deno.test('r4: a refresh token the server rejects ends the command with the login message, no user-api request and nothing changed', async () => {
  await withHome({ slv: loggedIn(EXPIRED) }, async (home) => {
    const before = await Deno.readTextFile(`${home}/.slv/api.yml`)
    await withFetch((url) =>
      url === AUTH_TOKEN_URL
        ? json({
          error: 'invalid_grant',
          error_description: 'server-side detail that is not shown',
        }, 400)
        : answer(url), async (requests) => {
      const outcome = await runCaptured(() => storageUsageAction({}))
      assertEquals(outcome.exit, 1, outcome.output)
      assertStringIncludes(outcome.output, 'slv login')
      assertFalse(outcome.output.includes('server-side detail'))
      assertEquals(toTokenEndpoint(requests).length, 1)
      assertEquals(toUserApi(requests).length, 0)
    })
    assertEquals(await Deno.readTextFile(`${home}/.slv/api.yml`), before)
  })
})

Deno.test('k1: user-api never sees the API key — without a login nothing is sent, with one the access token is sent', async () => {
  await withHome({ slv: { api_key: API_KEY } }, async () => {
    for (const [name, run] of USER_API_COMMANDS) {
      await withFetch(answer, async (requests) => {
        const outcome = await runCaptured(run)
        assertEquals(requests.length, 0, `${name} sent a request`)
        assertEquals(outcome.exit, 1, `${name} did not exit with 1`)
        assertStringIncludes(outcome.output, 'slv login')
      })
    }
  })
  await withHome({
    slv: { api_key: API_KEY, ...loggedIn(FAR_FUTURE) },
  }, async () => {
    for (const [name, run] of USER_API_COMMANDS) {
      await withFetch(answer, async (requests) => {
        const outcome = await runCaptured(run)
        assertEquals(outcome.error, undefined, `${name}: ${outcome.output}`)
        assert(requests.length > 0, `${name} sent no request`)
        for (const req of requests) {
          assertEquals(
            req.authorization,
            `Bearer ${ACCESS_TOKEN}`,
            `${name} -> ${req.url}`,
          )
          assertFalse(
            `${req.url} ${req.body ?? ''}`.includes(API_KEY),
            `${name} sent the API key to ${req.url}`,
          )
        }
      })
    }
  })
  // The user-api auth value only takes the JWT shape.
  assertThrows(() => auth.userApiAuthFromAccessToken(API_KEY))
  assertThrows(() =>
    auth.userApiAuthFromAccessToken(`erpcat_${'A1b2C3d4E5'.repeat(4)}abc`)
  )
})

Deno.test('s1: slv backup create --restic issues a read_write storage access key once, saves it, and connects restic with it', async () => {
  await withHome({
    slv: { api_key: API_KEY, ...loggedIn(FAR_FUTURE) },
  }, async (home) => {
    await Deno.writeTextFile(`${home}/.slv/restic-password`, 'test-password\n')
    await withCommandStub(
      (call) => ({ stdout: call.command === 'hostname' ? 'node-1\n' : '' }),
      async (calls) => {
        await withFetch((url) =>
          url === ACCESS_KEYS_URL
            ? json({
              id: 42,
              accessKeyId: STORAGE_KEY_ID,
              secret: STORAGE_SECRET,
              permission: 'read_write',
              label: 'slv-node-1',
              createdAt: '2026-01-01T00:00:00Z',
              resticUrl: `${USER_API}/v3/storage/restic`,
            }, 201)
            : json({}, 404), async (requests) => {
          const outcome = await runCaptured(() =>
            backupAction({ restic: true, yes: true, region: 'eu' })
          )
          assertEquals(outcome.error, undefined, outcome.output)
          assertEquals(outcome.exit, null, outcome.output)
          assertEquals(requests.length, 1)
          assertEquals(requests[0].method, 'POST')
          assertEquals(requests[0].url, ACCESS_KEYS_URL)
          assertEquals(requests[0].authorization, `Bearer ${ACCESS_TOKEN}`)
          const body = JSON.parse(requests[0].body ?? '{}')
          assertEquals(body.permission, 'read_write')
          assert(String(body.label).startsWith('slv-'), body.label)
          assert(String(body.label).length <= 64)
          assertFalse(outcome.output.includes(STORAGE_SECRET))
        })
        const restic = calls.find((c) => c.command === 'restic')
        assert(restic, 'restic was not started')
        assertEquals(
          restic.env.RESTIC_REPOSITORY,
          `rest:https://${STORAGE_KEY_ID}:${STORAGE_SECRET}@user-api.erpc.global/v3/storage/restic?region=eu`,
        )
      },
    )
    const slv = (await readYml(home)).slv
    assertEquals(slv.storage_access_key_id, STORAGE_KEY_ID)
    assertEquals(slv.storage_secret, STORAGE_SECRET)
    assertEquals(slv.storage_access_key_record_id, 42)
    assertEquals(slv.api_key, API_KEY)
  })

  const refusals: [number, unknown, string][] = [
    [409, { error: 'conflict' }, 'revoke'],
    [
      400,
      { message: 'Complete the payment authorization first.' },
      'Complete the payment authorization first.',
    ],
  ]
  for (const [status, reply, expected] of refusals) {
    await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
      await Deno.writeTextFile(
        `${home}/.slv/restic-password`,
        'test-password\n',
      )
      await withCommandStub(() => ({}), async (calls) => {
        await withFetch(() => json(reply, status), async () => {
          const outcome = await runCaptured(() =>
            backupAction({ restic: true, yes: true })
          )
          assertEquals(outcome.exit, 1, `${status}: ${outcome.output}`)
          assertStringIncludes(outcome.output, expected)
        })
        assertEquals(
          calls.filter((c) => c.command === 'restic').length,
          0,
          `restic was started after HTTP ${status}`,
        )
      })
      assertEquals(await findStorageAccessKey(home), null)
    })
  }
})

Deno.test('f3: a saved storage access key is used as is — no request, id as username and secret as password', async () => {
  await withHome({
    slv: {
      ...loggedIn(FAR_FUTURE),
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    },
  }, async (home) => {
    await Deno.writeTextFile(`${home}/.slv/restic-password`, 'test-password\n')
    await withCommandStub(
      (call) => ({ stdout: call.command === 'restic' ? '[]' : '' }),
      async (calls) => {
        await withFetch(answer, async (requests) => {
          const outcome = await runCaptured(() =>
            backupListAction({ restic: true, region: 'eu' })
          )
          assertEquals(outcome.error, undefined, outcome.output)
          assertEquals(requests.length, 0)
        })
        const restic = calls.find((c) => c.command === 'restic')
        assert(restic, 'restic was not started')
        assertEquals(
          restic.env.RESTIC_REPOSITORY,
          `rest:https://${STORAGE_KEY_ID}:${STORAGE_SECRET}@user-api.erpc.global/v3/storage/restic?region=eu`,
        )
      },
    )
  })
})

Deno.test('s2: slv storage upload and download request their presigned URLs with the access token', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    const file = `${home}/payload.txt`
    await Deno.writeTextFile(file, 'hello')
    await withFetch(answer, async (requests) => {
      const uploaded = await runCaptured(() =>
        uploadAction(file, { path: 'payload.txt', region: 'eu' })
      )
      assertEquals(uploaded.error, undefined, uploaded.output)
      const presignUpload = requests.find((r) =>
        r.url === `${USER_API}/v3/storage/presign/upload`
      )
      assert(presignUpload, `no presign upload request: ${uploaded.output}`)
      assertEquals(presignUpload.authorization, `Bearer ${ACCESS_TOKEN}`)

      const downloaded = await runCaptured(() =>
        downloadAction('payload.txt', {
          region: 'eu',
          output: `${home}/downloaded.txt`,
        })
      )
      assertEquals(downloaded.error, undefined, downloaded.output)
      const presignDownload = requests.find((r) =>
        r.url === `${USER_API}/v3/storage/presign/download`
      )
      assert(
        presignDownload,
        `no presign download request: ${downloaded.output}`,
      )
      assertEquals(presignDownload.authorization, `Bearer ${ACCESS_TOKEN}`)
    })
    assertEquals(await Deno.readTextFile(`${home}/downloaded.txt`), 'hello')
  })
})

Deno.test("o1: slv logout revokes this machine's storage access key, then removes every credential and keeps the other sections", async () => {
  for (const status of [200, 500]) {
    await withHome({
      slv: {
        api_key: API_KEY,
        ...loggedIn(FAR_FUTURE),
        storage_access_key_id: STORAGE_KEY_ID,
        storage_secret: STORAGE_SECRET,
        storage_access_key_record_id: 42,
      },
      ...OTHER_SECTIONS,
    }, async (home) => {
      await withFetch(() => json({}, status), async (requests) => {
        const outcome = await runCaptured(() => logout.logoutAction())
        assertEquals(outcome.error, undefined, outcome.output)
        assertEquals(outcome.exit, null, outcome.output)
        assertEquals(
          requests.map((r) => `${r.method} ${r.url} ${r.authorization}`),
          [
            `DELETE ${ACCESS_KEYS_URL}/42 Bearer ${ACCESS_TOKEN}`,
            `POST ${REVOKE_URL} null`,
          ],
        )
        if (status === 500) {
          assertStringIncludes(outcome.output, 'revoke')
        }
      })
      const yml = await readYml(home)
      for (const key of CREDENTIAL_KEYS) {
        assertEquals(yml.slv[key] ?? null, null, `${key} was kept`)
      }
      assertEquals(yml.ai, OTHER_SECTIONS.ai)
      assertEquals(yml.lang, OTHER_SECTIONS.lang)
      assertEquals(yml.notifications, OTHER_SECTIONS.notifications)
    })
  }
})

Deno.test('o2: slv logout revokes the refresh token once, and a 404 from the revoke endpoint still removes the credentials', async () => {
  await withHome({
    slv: { api_key: API_KEY, ...loggedIn(FAR_FUTURE) },
    ...OTHER_SECTIONS,
  }, async (home) => {
    await withFetch(
      (url) =>
        url === REVOKE_URL ? json({ error: 'not_found' }, 404) : json({}, 500),
      async (requests) => {
        const outcome = await runCaptured(() => logout.logoutAction())
        assertEquals(outcome.error, undefined, outcome.output)
        assertEquals(outcome.exit, null, outcome.output)
        const revokes = requests.filter((r) => r.url === REVOKE_URL)
        assertEquals(revokes.length, 1)
        assertEquals(revokes[0].method, 'POST')
        assertEquals(revokes[0].authorization, null)
        const fields = new URLSearchParams(revokes[0].body ?? '')
        assertEquals(fields.get('token'), REFRESH_TOKEN)
        assertEquals(fields.get('token_type_hint'), 'refresh_token')
        assertEquals(fields.get('client_id'), 'erpc-cli')
        assertFalse(outcome.output.includes(REFRESH_TOKEN))
        assertFalse(outcome.output.includes('not_found'))
      },
    )
    const yml = await readYml(home)
    for (const key of CREDENTIAL_KEYS) {
      assertEquals(yml.slv[key] ?? null, null, `${key} was kept`)
    }
    assertEquals(yml.ai, OTHER_SECTIONS.ai)
  })
})

Deno.test('b1: a backup that cannot get the ERPC login or a storage access key posts the failure to its webhook, then exits 1', async () => {
  const WEBHOOK = 'https://hooks.example.invalid/backup'
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['--upload, refresh refused', loggedIn(EXPIRED), { upload: true }],
    ['--restic, never signed in', { api_key: API_KEY }, { restic: true }],
  ]
  for (const [name, slv, mode] of cases) {
    await withHome({ slv }, async (home) => {
      await Deno.writeTextFile(
        `${home}/.slv/restic-password`,
        'test-password\n',
      )
      await withCommandStub(
        (call) => ({ stdout: call.command === 'hostname' ? 'node-1\n' : '' }),
        async (calls) => {
          await withFetch((url) => {
            if (url === AUTH_TOKEN_URL) {
              return json({ error: 'invalid_grant' }, 400)
            }
            if (url === WEBHOOK) return new Response(null, { status: 204 })
            return json({}, 500)
          }, async (requests) => {
            const outcome = await runCaptured(() =>
              backupAction({
                ...mode,
                yes: true,
                webhook: WEBHOOK,
                output: `${home}/backup.tar.gz`,
              })
            )
            assertEquals(outcome.exit, 1, `${name}: ${outcome.output}`)
            const posts = requests.filter((r) => r.url === WEBHOOK)
            assertEquals(posts.length, 1, `${name}: webhook posts`)
            assertStringIncludes(posts[0].body ?? '', 'slv login')
            assertEquals(toUserApi(requests).length, 0, name)
          })
          assertEquals(
            calls.filter((c) => c.command === 'restic').length,
            0,
            `${name}: restic was started`,
          )
        },
      )
    })
  }
})

Deno.test('w1: a writer stops without changing api.yml when it cannot read it or it is not valid YAML', async () => {
  const writers: [string, (home: string) => Promise<unknown>][] = [
    ['writeLang', () => writeLang('ja')],
    [
      'mergeSlvCredentials',
      (home) => mergeSlvCredentials({ api_key: API_KEY }, home),
    ],
  ]
  const unreadable = Deno.uid() !== 0 // root reads a mode 000 file anyway
  for (const [name, write] of writers) {
    if (unreadable) {
      await withHome({
        slv: loggedIn(FAR_FUTURE),
        ...OTHER_SECTIONS,
      }, async (home) => {
        const path = `${home}/.slv/api.yml`
        const before = await Deno.readTextFile(path)
        await Deno.chmod(path, 0o000)
        try {
          await assertRejects(() => write(home), session.ApiYmlUnreadableError)
        } finally {
          await Deno.chmod(path, 0o600)
        }
        assertEquals(await Deno.readTextFile(path), before, `${name}: mode 000`)
      })
    }
    await withHome(null, async (home) => {
      const path = `${home}/.slv/api.yml`
      const broken = 'slv:\n  api_key: [unclosed\nai: {provider: slv\n'
      await Deno.writeTextFile(path, broken)
      await assertRejects(() => write(home), session.ApiYmlUnreadableError)
      assertEquals(
        await Deno.readTextFile(path),
        broken,
        `${name}: broken YAML`,
      )
    })
  }
})

Deno.test('c1: slv check asks for the API key when none is saved, saves it, and puts it in the geyserbench config', async () => {
  await withHome({ slv: loggedIn(FAR_FUTURE) }, async (home) => {
    const configPath = await check.ensureGeyserbenchConfig({
      kind: 'rpc',
      region: 'frankfurt',
      endpoints: ['https://a.example.invalid', 'https://b.example.invalid'],
      transactions: 10,
    }, {
      askApiKey: () => Promise.resolve(API_KEY),
      isTerminal: () => true,
    })
    assert(configPath.startsWith(home), configPath)
    assertStringIncludes(
      await Deno.readTextFile(configPath),
      `erpc_api_key = "${API_KEY}"`,
    )
    const slv = (await readYml(home)).slv
    assertEquals(slv.api_key, API_KEY)
    assertEquals(slv.access_token, ACCESS_TOKEN)
  })
})

Deno.test('saving into slv: keeps the other keys and sections and leaves api.yml at mode 600', async () => {
  await withHome({
    slv: { api_key: API_KEY, ...loggedIn(FAR_FUTURE) },
    ...OTHER_SECTIONS,
  }, async (home) => {
    await mergeSlvCredentials({
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    }, home)
    const yml = await readYml(home)
    assertEquals(yml.slv, {
      api_key: API_KEY,
      ...loggedIn(FAR_FUTURE),
      storage_access_key_id: STORAGE_KEY_ID,
      storage_secret: STORAGE_SECRET,
    })
    assertEquals(yml.ai, OTHER_SECTIONS.ai)
    assertEquals(yml.lang, OTHER_SECTIONS.lang)
    assertEquals(yml.notifications, OTHER_SECTIONS.notifications)
    const mode = (await Deno.stat(`${home}/.slv/api.yml`)).mode ?? 0
    assertEquals(mode & 0o777, 0o600)
  })
})

Deno.test('credential shapes match what the servers issue', () => {
  assert(isValidApiKey(API_KEY))
  assertFalse(isValidApiKey(ACCESS_TOKEN))

  assert(isValidStorageAccessKeyId(STORAGE_KEY_ID))
  assertFalse(isValidStorageAccessKeyId(STORAGE_KEY_ID.slice(0, -1)))
  assertFalse(isValidStorageAccessKeyId(STORAGE_KEY_ID.toUpperCase()))
  assertFalse(isValidStorageAccessKeyId('erpcsk_abcdefghij234561')) // 1 is not base32

  assert(isValidStorageSecret(STORAGE_SECRET))
  assertFalse(isValidStorageSecret(STORAGE_SECRET.slice(1)))
  assertFalse(isValidStorageSecret(`${STORAGE_SECRET.slice(1)}=`))
})

// The only place that turns a credential into an Authorization header for
// user-api is lib/userApi/auth.ts; the one other `Bearer` in the CLI is the
// model-list check against the OpenAI API in `slv auth`.
Deno.test('f1: no source file builds a Bearer header by hand outside lib/userApi/auth.ts', async () => {
  const root = new URL('../../', import.meta.url)
  const allowed = new Set(['lib/userApi/auth.ts', 'src/auth/index.ts'])
  const offenders: string[] = []
  const walk = async (dir: URL) => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir)
      if (entry.isDirectory) {
        await walk(child)
      } else if (entry.name.endsWith('.ts')) {
        const rel = child.pathname.slice(root.pathname.length)
        if (allowed.has(rel)) continue
        const text = await Deno.readTextFile(child)
        if (text.includes('Bearer ${')) offenders.push(rel)
      }
    }
  }
  await walk(new URL('src/', root))
  await walk(new URL('lib/', root))
  assertEquals(offenders, [])
  assertStringIncludes(
    await Deno.readTextFile(new URL('lib/userApi/auth.ts', root)),
    'Bearer ${',
  )
})
