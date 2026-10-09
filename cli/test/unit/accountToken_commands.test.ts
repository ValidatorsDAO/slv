import { assert, assertEquals, assertStringIncludes } from '@std/assert'

import { aiUsageAction } from '@/ai/usage/usageAction.ts'
import { usageAction as storageUsageAction } from '@/storage/usage/usageAction.ts'
import { statusAction as metalStatusAction } from '@/metal/status/statusAction.ts'
import { uploadAction } from '@/storage/upload/uploadAction.ts'
import { downloadAction } from '@/storage/download/downloadAction.ts'
import { backupAction } from '@/backup/backupAction.ts'
import { importAction } from '@/backup/importAction.ts'
import { listAction as backupListAction } from '@/backup/listAction.ts'
import { dnsCmd } from '@/dns/index.ts'

import {
  ACCESS_TOKEN,
  API_KEY,
  runCaptured,
  STORAGE_KEY_ID,
  STORAGE_SECRET,
  withCommandStub,
  withFetch,
  withHome,
} from '/test/unit/_credentialFixtures.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

// Generic answers, good enough for the commands below to run to the end.
const answer = (url: string): Response => {
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
      storageLimitBytes: 1000,
      region: 'eu',
    })
  }
  return json({ message: {} })
}

// user-api commands that read the credential from ~/.slv/api.yml themselves
const USER_API_COMMANDS: [string, () => Promise<unknown>][] = [
  ['slv ai usage', () => aiUsageAction()],
  ['slv storage usage', () => storageUsageAction({})],
  ['slv metal status', () => metalStatusAction()],
  ['slv dns status', () => dnsCmd.parse(['status'])],
]

Deno.test('f1: user-api commands send the account access token, not the API key', async () => {
  await withHome({
    slv: { api_key: API_KEY, access_token: ACCESS_TOKEN },
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
        }
      })
    }
  })
})

Deno.test('f2: without slv.access_token a user-api command sends nothing and points to `slv login`', async () => {
  await withHome({ slv: { api_key: API_KEY } }, async () => {
    for (const [name, run] of USER_API_COMMANDS) {
      await withFetch(answer, async (requests) => {
        const outcome = await runCaptured(run)
        assertEquals(requests.length, 0, `${name} sent a request`)
        assertEquals(outcome.exit, 1, `${name} did not exit with 1`)
        assertStringIncludes(outcome.output, 'slv login')
        assertStringIncludes(outcome.output, 'account access token')
      })
    }
  })
})

Deno.test('f3: restic connects with the storage access key (id as username, secret as password)', async () => {
  await withHome({
    slv: {
      api_key: API_KEY,
      access_token: ACCESS_TOKEN,
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

Deno.test('f3: without a storage access key restic is not started', async () => {
  await withHome({
    slv: { api_key: API_KEY, access_token: ACCESS_TOKEN },
  }, async (home) => {
    await Deno.writeTextFile(`${home}/.slv/restic-password`, 'test-password\n')
    await withCommandStub(() => ({}), async (calls) => {
      const outcome = await runCaptured(() =>
        backupListAction({ restic: true })
      )
      assertEquals(
        calls.filter((c) => c.command === 'restic').length,
        0,
        'restic was started',
      )
      assertEquals(outcome.exit, 1)
      assertStringIncludes(outcome.output, 'storage access key')
      assertStringIncludes(outcome.output, 'slv login')
    })
  })
})

const TRANSFER_UNAVAILABLE =
  'File upload and download are currently not available with an account access token. For backups, use `slv backup create --restic` with a storage access key (save one with `slv login`).'

Deno.test('f4: upload and download of files are refused before any request is sent', async () => {
  await withHome({
    slv: { api_key: API_KEY, access_token: ACCESS_TOKEN },
  }, async (home) => {
    const file = `${home}/payload.txt`
    await Deno.writeTextFile(file, 'hello')
    const transfers: [string, () => Promise<unknown>][] = [
      [
        'slv storage upload',
        () => uploadAction(file, { path: 'payload.txt', region: 'eu' }),
      ],
      [
        'slv storage download',
        () => downloadAction('payload.txt', { region: 'eu' }),
      ],
      [
        'slv backup restore <cloud archive>',
        () =>
          importAction(
            { region: 'eu', yes: true },
            'backups/backup-host-20260101-000000.tar.zst',
          ),
      ],
    ]
    for (const [name, run] of transfers) {
      await withFetch(() => json({}, 401), async (requests) => {
        const outcome = await runCaptured(run)
        assertEquals(requests.length, 0, `${name} sent a request`)
        assertEquals(outcome.exit, 1, `${name} did not fail`)
        assertStringIncludes(outcome.output, TRANSFER_UNAVAILABLE)
      })
    }
  })
})

Deno.test('f4: slv backup create --upload is refused before the archive is created', async () => {
  await withHome({
    slv: { api_key: API_KEY, access_token: ACCESS_TOKEN },
  }, async (home) => {
    await withCommandStub(() => {
      throw new Error('no process may start before the upload is refused')
    }, async (calls) => {
      await withFetch(() => json({}, 401), async (requests) => {
        const outcome = await runCaptured(() =>
          backupAction({
            upload: true,
            yes: true,
            output: `${home}/backup.tar.gz`,
          })
        )
        assertEquals(outcome.error, undefined)
        assertEquals(requests.length, 0)
        assertEquals(calls.length, 0)
        assertEquals(outcome.exit, 1)
        assertStringIncludes(outcome.output, TRANSFER_UNAVAILABLE)
      })
    })
  })
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
