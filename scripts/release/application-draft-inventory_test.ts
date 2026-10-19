import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import {
  applicationDraftCommand,
  checkApplicationDraft,
  completeApplicationDraft,
  findApplicationDraft,
} from './application-draft.ts'
import type { QualificationRelease } from './runtime-qualification.ts'

const source = 'a'.repeat(40), tag = 'v2026.10.19.0750', digest = 'b'.repeat(64)
const manifest = {
  schema_version: 2,
  version: tag.slice(1),
  source: { commit: source },
  assets: [{ name: 'payload', size: 12, sha256: digest }],
}
const names = ['payload', 'release-manifest.json', 'SHA256SUMS']
function draft(): QualificationRelease {
  return {
    id: 17,
    tag_name: tag,
    target_commitish: source,
    draft: true,
    prerelease: false,
    immutable: false,
    assets: [...names, ...names.map((name) => `${name}.intoto.jsonl`)].map((
      name,
      i,
    ) => ({
      id: i + 1,
      name,
      size: 12,
      digest: `sha256:${digest}`,
      browser_download_url: 'https://example.invalid/unused',
    })),
  }
}
async function setup() {
  const state: { remote: QualificationRelease } = {
    remote: { ...draft(), assets: [] },
  }
  const api = { release: () => Promise.resolve(structuredClone(state.remote)) }
  const selected = (await findApplicationDraft(tag, source, api))!
  state.remote = draft()
  return { state, api, selected }
}

Deno.test('complete staged application inventory covers exactly every subject and bundle', async () => {
  const { state, api, selected } = await setup()
  const full = await completeApplicationDraft(selected, manifest, api)
  assertEquals(full.assets.length, 6)
  await checkApplicationDraft(full, false, api)
  state.remote.assets.push({
    ...state.remote.assets[0],
    id: 100,
    name: 'unattested-extra',
  })
  await assertRejects(
    () => checkApplicationDraft(full, false, api),
    Error,
    'inventory changed',
  )
})

Deno.test('an extra file added after initial recovery cannot enter the completed publication snapshot', async () => {
  const { state, api, selected } = await setup()
  state.remote.assets.push({
    ...state.remote.assets[0],
    id: 100,
    name: 'unattested-extra',
  })
  assertEquals(
    (await checkApplicationDraft(selected, true, api)).assets.length,
    7,
  )
  await assertRejects(
    () => completeApplicationDraft(selected, manifest, api),
    Error,
    'inventory differs',
  )
  for (
    const missing of [
      ...names,
      ...names.map((name) => `${name}.intoto.jsonl`),
    ]
  ) {
    state.remote = draft()
    state.remote.assets = state.remote.assets.filter((row) =>
      row.name !== missing
    )
    await assertRejects(
      () => completeApplicationDraft(selected, manifest, api),
      Error,
      'inventory differs',
    )
  }
})

Deno.test('complete inventory binds manifest source and payload metadata', async () => {
  const { state, api, selected } = await setup()
  for (
    const changed of [
      { ...manifest, schema_version: 1 },
      { ...manifest, unsigned: true },
      { ...manifest, source: { commit: 'c'.repeat(40) } },
      { ...manifest, version: '2026.10.18.1610' },
      { ...manifest, assets: [manifest.assets[0], manifest.assets[0]] },
      { ...manifest, assets: [{ ...manifest.assets[0], name: 'SHA256SUMS' }] },
      {
        ...manifest,
        assets: [{ ...manifest.assets[0], name: 'payload.intoto.jsonl' }],
      },
    ]
  ) await assertRejects(() => completeApplicationDraft(selected, changed, api))
  for (const field of ['digest', 'size'] as const) {
    state.remote = draft()
    if (field === 'digest') {
      state.remote.assets[0].digest = `sha256:${'c'.repeat(64)}`
    } else state.remote.assets[0].size++
    await assertRejects(
      () => completeApplicationDraft(selected, manifest, api),
      Error,
      'metadata differs',
    )
  }
})

Deno.test('complete CLI reads saved draft and manifest and rejects unverified staging additions', async () => {
  const { state, api, selected } = await setup(),
    root = await Deno.makeTempDir()
  try {
    const snapshot = `${root}/snapshot.json`, input = `${root}/manifest.json`
    await Deno.writeTextFile(snapshot, JSON.stringify(selected))
    await Deno.writeTextFile(input, JSON.stringify(manifest))
    const complete = await applicationDraftCommand([
      'complete',
      snapshot,
      input,
    ], api)
    assertEquals(complete?.assets.length, 6)
    state.remote.assets.push({
      ...state.remote.assets[0],
      id: 100,
      name: 'unattested-extra',
    })
    await assertRejects(
      () => applicationDraftCommand(['complete', snapshot, input], api),
      Error,
      'inventory differs',
    )
    await Deno.symlink(input, `${root}/link.json`)
    await assertRejects(
      () =>
        applicationDraftCommand(
          ['complete', snapshot, `${root}/link.json`],
          api,
        ),
      Error,
      'manifest file',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
