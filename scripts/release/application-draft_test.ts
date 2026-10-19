import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { join } from 'node:path'
import {
  type ApplicationDraft,
  applicationDraftCommand,
  checkApplicationDraft,
  findApplicationDraft,
} from './application-draft.ts'
import {
  canonicalQualificationBytes,
  githubQualificationAdapter,
  type QualificationRelease,
} from './runtime-qualification.ts'

const TAG = 'v2026.10.19.0750'
const SOURCE = 'a'.repeat(40)
const PREFIX = '/repos/ValidatorsDAO/slv/'
const TAG_PATH = `releases/tags/${TAG}`
const LIST_PATH = 'releases?per_page=100&page='

function fixture(): QualificationRelease {
  return {
    id: 41,
    tag_name: TAG,
    target_commitish: SOURCE,
    draft: true,
    prerelease: false,
    immutable: false,
    assets: [{
      id: 101,
      name: 'release-manifest.json',
      size: 100,
      digest: `sha256:${'b'.repeat(64)}`,
      browser_download_url:
        'https://github.com/ValidatorsDAO/slv/releases/download/untagged-fixture/release-manifest.json',
    }, {
      id: 102,
      name: 'SHA256SUMS',
      size: 50,
      digest: `sha256:${'c'.repeat(64)}`,
      browser_download_url:
        'https://github.com/ValidatorsDAO/slv/releases/download/untagged-fixture/SHA256SUMS',
    }],
  }
}
function direct(value: QualificationRelease | null) {
  return { release: () => Promise.resolve(structuredClone(value)) }
}
function transport(reply: (path: string) => Response) {
  const paths: string[] = []
  const api = githubQualificationAdapter({
    token: 'TEST_TOKEN',
    fetch: (input, init) => {
      const url = new URL(String(input))
      assertEquals(url.origin, 'https://api.github.com')
      assert(url.pathname.startsWith(PREFIX))
      assertEquals(init?.redirect, 'error')
      assert(init?.signal instanceof AbortSignal)
      assert(
        new Headers(init?.headers).get('Authorization')?.endsWith('TEST_TOKEN'),
      )
      const path = url.pathname.slice(PREFIX.length) + url.search
      paths.push(path)
      return Promise.resolve(reply(path))
    },
  })
  return { api, paths }
}
function absent() {
  return new Response(null, { status: 404 })
}
function fullUnrelatedPage() {
  return Array.from({ length: 100 }, (_, index) => ({
    ...fixture(),
    id: 1000 + index,
    tag_name: `unrelated-${index}`,
  }))
}
async function selected() {
  const result = await findApplicationDraft(TAG, SOURCE, direct(fixture()))
  assert(result)
  return result
}

Deno.test('draft lookup uses authenticated inventory after tag 404 and ignores untagged browser URLs', async () => {
  const { api, paths } = transport((path) => {
    if (path === TAG_PATH) return absent()
    assertEquals(path, `${LIST_PATH}1`)
    return Response.json([fixture()])
  })
  const draft = await findApplicationDraft(TAG, SOURCE, api)
  assertEquals(draft, await selected())
  assertEquals(paths, [TAG_PATH, `${LIST_PATH}1`])
  // No Git ref lookup: an absent or existing tag does not establish draft absence.
  assertEquals(draft?.assets.map((row) => row.name), [
    'SHA256SUMS',
    'release-manifest.json',
  ])
  assertEquals(Object.keys(draft!.assets[0]).sort(), [
    'digest',
    'id',
    'name',
    'size',
  ])
})

Deno.test('draft lookup searches later pages and only a completed short page establishes absence', async () => {
  for (const present of [true, false]) {
    const { api, paths } = transport((path) => {
      if (path === TAG_PATH) return absent()
      if (path === `${LIST_PATH}1`) return Response.json(fullUnrelatedPage())
      assertEquals(path, `${LIST_PATH}2`)
      return Response.json(present ? [fixture()] : [])
    })
    assertEquals(
      await findApplicationDraft(TAG, SOURCE, api),
      present ? await selected() : null,
    )
    assertEquals(paths, [TAG_PATH, `${LIST_PATH}1`, `${LIST_PATH}2`])
  }
  const { api, paths } = transport((path) =>
    path === TAG_PATH ? absent() : Response.json(fullUnrelatedPage())
  )
  await assertRejects(
    () => findApplicationDraft(TAG, SOURCE, api),
    Error,
    'bounded lookup',
  )
  assertEquals(paths.length, 21)
  assertEquals(paths.at(-1), `${LIST_PATH}20`)
})

Deno.test('HTTP failures on tag lookup or any inventory page never authorize creating another draft', async () => {
  for (const status of [401, 403, 500]) {
    for (const failurePath of [TAG_PATH, `${LIST_PATH}1`, `${LIST_PATH}2`]) {
      const { api, paths } = transport((path) => {
        if (path === failurePath) return new Response(null, { status })
        if (path === TAG_PATH) return absent()
        return Response.json(fullUnrelatedPage())
      })
      await assertRejects(
        () => findApplicationDraft(TAG, SOURCE, api),
        Error,
        `(${status})`,
      )
      assertEquals(paths.at(-1), failurePath)
    }
  }
  for (
    const reply of [
      absent,
      () => Response.json({ message: 'unavailable' }),
      () => new Response('{'),
    ]
  ) {
    const { api } = transport((path) => path === TAG_PATH ? absent() : reply())
    await assertRejects(() => findApplicationDraft(TAG, SOURCE, api))
  }
})

Deno.test('invalid requested identity fails before reading GitHub', async () => {
  let calls = 0
  const api = {
    release: () => {
      calls++
      return Promise.resolve(null)
    },
  }
  for (
    const tag of [
      'main',
      'v2026.0.19.0750',
      'v2026.13.19.0750',
      'v2026.10.0.0750',
      'v2026.10.19.750',
      42,
      null,
    ]
  ) {
    await assertRejects(
      () => findApplicationDraft(tag as string, SOURCE, api),
      Error,
      'invalid tag or source',
    )
  }
  for (const source of ['main', 'A'.repeat(40), 'a'.repeat(39), 42, null]) {
    await assertRejects(
      () => findApplicationDraft(TAG, source as string, api),
      Error,
      'invalid tag or source',
    )
  }
  assertEquals(calls, 0)
})

Deno.test('draft selection rejects wrong release identity, state, and malformed uploaded assets', async () => {
  const releaseChanges: Record<string, unknown>[] = [
    { id: 0 },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { tag_name: 'v2026.10.19.0751' },
    { target_commitish: 'b'.repeat(40) },
    { target_commitish: 'main' },
    { draft: false },
    { draft: 'true' },
    { prerelease: true },
    { prerelease: undefined },
    { immutable: true },
    { immutable: undefined },
    { assets: null },
    { assets: {} },
    { assets: Array.from({ length: 1025 }, () => fixture().assets[0]) },
  ]
  for (const change of releaseChanges) {
    await assertRejects(() =>
      findApplicationDraft(
        TAG,
        SOURCE,
        direct({ ...fixture(), ...change } as QualificationRelease),
      )
    )
  }
  const assetChanges: Record<string, unknown>[] = [
    { id: 0 },
    { id: 1.5 },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { name: '' },
    { name: 42 },
    { name: null },
    { name: '../payload' },
    { name: '/payload' },
    { name: 'a/b' },
    { name: 'a'.repeat(201) },
    { digest: undefined },
    { digest: 42 },
    { digest: 'b'.repeat(64) },
    { digest: `sha256:${'B'.repeat(64)}` },
    { digest: `sha256:${'b'.repeat(63)}` },
  ]
  for (const change of assetChanges) {
    const release = fixture()
    Object.assign(release.assets[0], change)
    await assertRejects(
      () => findApplicationDraft(TAG, SOURCE, direct(release)),
      Error,
      'uploaded asset identity',
    )
  }
  for (const field of ['id', 'name'] as const) {
    const release = fixture()
    Object.assign(release.assets[1], { [field]: release.assets[0][field] })
    await assertRejects(
      () => findApplicationDraft(TAG, SOURCE, direct(release)),
      Error,
      'uploaded asset identity',
    )
  }
  const release = fixture()
  release.assets[0] = null as unknown as QualificationRelease['assets'][number]
  await assertRejects(
    () => findApplicationDraft(TAG, SOURCE, direct(release)),
    Error,
    'uploaded asset identity',
  )
})

Deno.test('selected draft cannot disappear, be cloned, retargeted, or lose or replace uploaded bytes', async () => {
  const original = await selected()
  const mutations: ((release: QualificationRelease) => void)[] = [
    (r) => {
      r.id++
    },
    (r) => {
      r.target_commitish = 'b'.repeat(40)
    },
    (r) => {
      r.tag_name = 'v2026.10.19.0751'
    },
    (r) => {
      r.draft = false
    },
    (r) => {
      r.assets.pop()
    },
    (r) => {
      r.assets[0].id = 103
    },
    (r) => {
      r.assets[0].digest = `sha256:${'d'.repeat(64)}`
    },
    (r) => {
      r.assets[0].size++
    },
    (r) => {
      r.assets[0].name = 'replacement.json'
    },
    (r) => {
      ;[r.assets[0].id, r.assets[1].id] = [r.assets[1].id, r.assets[0].id]
    },
  ]
  for (const additions of [true, false]) {
    await assertRejects(
      () => checkApplicationDraft(original, additions, direct(null)),
      Error,
      'disappeared',
    )
    for (const mutate of mutations) {
      const release = fixture()
      mutate(release)
      await assertRejects(() =>
        checkApplicationDraft(original, additions, direct(release))
      )
    }
  }
})

Deno.test('staging can extend inventory but final verification rejects even valid additions', async () => {
  const original = await selected()
  const release = fixture()
  release.assets.push({
    ...release.assets[0],
    id: 103,
    name: 'release-manifest.json.intoto.jsonl',
  })
  const extended = await checkApplicationDraft(original, true, direct(release))
  assertEquals(extended.assets.length, 3)
  assertEquals(original.assets.length, 2)
  await assertRejects(
    () => checkApplicationDraft(original, false, direct(release)),
    Error,
    'inventory changed',
  )
  assertEquals(
    await checkApplicationDraft(extended, false, direct(release)),
    extended,
  )
})

Deno.test('live asset order and irrelevant browser metadata do not invalidate an unchanged selection', async () => {
  const original = await selected()
  const release = fixture()
  release.assets.reverse()
  for (const asset of release.assets) {
    asset.browser_download_url =
      'https://github.com/ValidatorsDAO/slv/releases/download/untagged-another/unused'
    Object.assign(asset, {
      label: 'irrelevant display label',
      download_count: 12,
    })
  }
  Object.assign(release, { body: 'edited release notes', html_url: 'unused' })
  assertEquals(
    await checkApplicationDraft(original, false, direct(release)),
    original,
  )
  const reorderedKeys = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as ApplicationDraft
  assertEquals(
    await checkApplicationDraft(reorderedKeys, false, direct(release)),
    original,
  )
  await assertRejects(
    () =>
      checkApplicationDraft(
        { ...original, unexpected: true } as ApplicationDraft,
        false,
        direct(release),
      ),
    Error,
    'invalid saved draft snapshot',
  )
})

Deno.test('command routes persist and extend the same numeric draft and verify a serialized full snapshot', async () => {
  const directory = await Deno.makeTempDir({
    prefix: 'application-draft-test-',
  })
  const path = join(directory, 'draft snapshot.json')
  try {
    const initial = await applicationDraftCommand(
      ['find', TAG, SOURCE],
      direct(fixture()),
    )
    assert(initial)
    assertEquals(
      await applicationDraftCommand(
        ['require', TAG, SOURCE],
        direct(fixture()),
      ),
      initial,
    )
    await Deno.writeFile(path, canonicalQualificationBytes(initial), {
      mode: 0o600,
    })
    const release = fixture()
    release.assets.push({
      ...release.assets[0],
      id: 103,
      name: 'provenance.jsonl',
    })
    const extended = await applicationDraftCommand(
      ['extend', path],
      direct(release),
    )
    assertEquals(extended?.id, initial.id)
    assertEquals(extended?.assets.length, 3)
    await Deno.writeFile(path, canonicalQualificationBytes(extended))
    release.assets.reverse()
    assertEquals(
      await applicationDraftCommand(['verify', path], direct(release)),
      extended,
    )
    release.assets[0].digest = `sha256:${'d'.repeat(64)}`
    await assertRejects(
      () => applicationDraftCommand(['verify', path], direct(release)),
      Error,
      'uploaded asset changed',
    )
    assertEquals(
      await applicationDraftCommand(['find', TAG, SOURCE], direct(null)),
      null,
    )
    await assertRejects(
      () => applicationDraftCommand(['require', TAG, SOURCE], direct(null)),
      Error,
      'created draft was not found',
    )
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test('command rejects malformed, nonregular, oversized, and noncanonical saved snapshots before API lookup', async () => {
  const directory = await Deno.makeTempDir({
    prefix: 'application-draft-test-',
  })
  const path = join(directory, 'snapshot.json')
  let calls = 0
  const api = {
    release: () => {
      calls++
      return Promise.resolve(fixture())
    },
  }
  try {
    for (
      const content of [
        '{',
        'null',
        '[]',
        '42',
        JSON.stringify({ ...await selected(), unexpected: true }),
        ' '.repeat(1024 * 1024 + 1),
      ]
    ) {
      await Deno.writeTextFile(path, content)
      for (const action of ['extend', 'verify']) {
        await assertRejects(() => applicationDraftCommand([action, path], api))
      }
    }
    await Deno.writeFile(path, canonicalQualificationBytes(await selected()))
    const symlink = join(directory, 'link.json')
    await Deno.symlink(path, symlink)
    for (
      const invalidPath of [directory, symlink, join(directory, 'missing.json')]
    ) {
      await assertRejects(() =>
        applicationDraftCommand(['verify', invalidPath], api)
      )
    }
    for (
      const args of [
        [],
        ['unknown'],
        ['find', TAG],
        ['require', TAG, SOURCE, 'extra'],
        ['extend'],
        ['verify', path, 'extra'],
      ]
    ) {
      await assertRejects(
        () => applicationDraftCommand(args, api),
        Error,
        'usage:',
      )
    }
    assertEquals(calls, 0)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
