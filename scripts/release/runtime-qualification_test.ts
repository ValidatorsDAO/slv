import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from 'jsr:@std/assert@1'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPromotionContext,
  assertQualificationManifest,
  canonicalQualificationBytes,
  extractQualificationSourceMembers,
  extractQualificationZip,
  githubQualificationAdapter,
  QUALIFICATION_MANIFEST,
  QUALIFICATION_REPOSITORY,
  QUALIFICATION_WORKFLOW,
  qualificationIdentity,
  qualificationTag,
  readQualificationManifest,
  stageQualificationEvidenceFile,
  verifyCandidateProvenance,
  verifyPromotionDraft,
  verifyPublishedQualification as verifyPublishedQualificationProduction,
  verifyQualificationArchiveBindings,
  verifyQualificationAttestationResult,
  verifyQualificationDirectory,
  verifyQualificationDraft as verifyQualificationDraftProduction,
  verifyQualificationTagForPromotion,
} from './runtime-qualification.ts'
import type {
  PromotionContext,
  QualificationGitHub,
  QualificationManifest,
  QualificationRelease,
} from './runtime-qualification.ts'
import { SOURCE_PROOF_TARGETS } from './source-materials.ts'
const allowPolicy = {
  fetch: () =>
    Promise.resolve(
      Response.json({ schema_version: 1, revoked_identities: [] }),
    ),
}
const verifyPublishedQualification = (
  m: QualificationManifest,
  github: QualificationGitHub,
  assets?: string[],
) => verifyPublishedQualificationProduction(m, github, assets, allowPolicy)
const verifyQualificationDraft = (
  m: QualificationManifest,
  release: QualificationRelease,
  source: string,
  github: QualificationGitHub,
  complete = false,
) =>
  verifyQualificationDraftProduction(
    m,
    release,
    source,
    github,
    complete,
    allowPolicy,
  )
const bytes = new TextEncoder().encode('fixture bytes\n')
const file = {
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
}
const commit = 'a'.repeat(40)
function fixture(): QualificationManifest {
  const m: QualificationManifest = {
    schema_version: 1,
    kind: 'slv-runtime-qualification',
    producer: {
      repository: QUALIFICATION_REPOSITORY,
      workflow_path: QUALIFICATION_WORKFLOW,
      workflow_source_commit: commit,
      reviewed_main_equivalent: {
        commit,
        tree_sha: commit,
        parents: [commit, 'b'.repeat(40)],
        pull_request: 1,
      },
      workflow_ref: 'refs/pull/1/merge',
      source_commit: commit,
      api_head_sha: 'b'.repeat(40),
      run_id: 42,
      run_attempt: 1,
    },
    compatibility: {
      deno_version: '2.9.3',
      deno_commit: commit,
      libsui_version: '0.8.0',
      frontend: {
        'x86_64-unknown-linux-gnu': file,
        'aarch64-unknown-linux-gnu': file,
      },
      runtime_inputs: {
        'source-materials/pins.json': file.sha256,
        'source-rebuild/tool-prereqs.json': file.sha256,
        'scripts/release/runtime-notices/evidence/deno/selected-Cargo.lock':
          file.sha256,
      },
      embedding_recipe_sha256: file.sha256,
    },
    producer_recipe: { 'source-rebuild/build-baseline.sh': file.sha256 },
    assets: {
      'slv-source.tar.gz': file,
      'deno-source.tar.gz': file,
      'deno-cargo-vendor.tar.gz': file,
      receipt: file,
      pins: file,
      tools: file,
      notice: file,
      lock: file,
      recipe: file,
    },
    source: {
      receipt: 'receipt',
      pins: 'pins',
      tool_prereqs: 'tools',
      notice: 'notice',
      selected_lock: 'lock',
      archives: {
        'slv-source.tar.gz': 'slv-source.tar.gz',
        'deno-source.tar.gz': 'deno-source.tar.gz',
        'deno-cargo-vendor.tar.gz': 'deno-cargo-vendor.tar.gz',
      },
      members: {
        'slv-source/source-rebuild/build-baseline.sh': 'recipe',
        'slv-source/source-materials/pins.json': 'pins',
        'slv-source/source-rebuild/tool-prereqs.json': 'tools',
        'slv-source/THIRD_PARTY_NOTICES': 'notice',
        'slv-source/selected-Cargo.lock': 'lock',
      },
    },
    artifacts: [],
    targets: [],
    policy: {
      version: 1,
      upstream_fallback: false,
      retention: 'while-referenced',
      native_evidence: 'original-runtime-only',
    },
  }
  for (let i = 0; i < 9; i++) {
    m.assets[`zip-${i}`] = file
    m.assets[`member-${i}`] = file
    m.artifacts.push({
      id: i + 1,
      name: `artifact-${i}`,
      asset: `zip-${i}`,
      members: { [`member-${i}`]: `member-${i}` },
    })
  }
  for (const target of SOURCE_PROOF_TARGETS) {
    const names = {
      runtime: `${target}-runtime`,
      derived_lock: `${target}-lock`,
      proof: `${target}-proof`,
      build_receipt: `${target}-build`,
      execution_receipt: `${target}-execution`,
      tool_pins: `${target}-tools`,
      transport_manifest: `${target}-transport`,
    }
    for (const name of Object.values(names)) m.assets[name] = file
    m.targets.push({
      target,
      ...names,
      abi: {
        format: target.includes('darwin') ? 'macho' : 'elf',
        arch: target.startsWith('x86') ? 'x86_64' : 'aarch64',
        minimum_os: target.includes('darwin') ? '11.0' : 'glibc-2.31',
      },
    })
  }
  return m
}
function published(m: QualificationManifest): QualificationRelease {
  const tag = qualificationTag(m)
  return {
    id: 1,
    tag_name: tag,
    draft: false,
    prerelease: true,
    immutable: true,
    target_commitish: commit,
    assets: [...Object.entries(m.assets), [QUALIFICATION_MANIFEST, {
      sha256: qualificationIdentity(m),
      size: canonicalQualificationBytes(m).length,
    }], [`${QUALIFICATION_MANIFEST}.intoto.jsonl`, file]].map((
      [name, f],
      i,
    ) => ({
      id: i + 1,
      name: name as string,
      ...(f as typeof file),
      digest: `sha256:${(f as typeof file).sha256}`,
      browser_download_url:
        `https://github.com/${QUALIFICATION_REPOSITORY}/releases/download/${tag}/${name}`,
    })),
  }
}
function adapter(m: QualificationManifest): QualificationGitHub {
  return {
    release: () => Promise.resolve(published(m)),
    download: async (url, path) => {
      await Deno.writeFile(
        path,
        url.endsWith(`/${QUALIFICATION_MANIFEST}`)
          ? canonicalQualificationBytes(m)
          : bytes,
        { createNew: true },
      )
    },
    verifyAttestation: async (subject, bundle, source) => {
      assertEquals(source, commit)
      assertEquals(JSON.parse(await Deno.readTextFile(subject)).kind, m.kind)
      assertEquals(await Deno.readFile(bundle), bytes)
    },
    verifyTagProtection: () =>
      Promise.resolve({ bypass_visibility: 'not-visible' }),
    verifyOriginalLineage: () => Promise.resolve(),
    verifyMainAncestor: () => Promise.resolve(),
    tagCommit: () => Promise.resolve(commit),
    artifact: (id) => {
      const row = m.artifacts.find((x) => x.id === id)!
      return Promise.resolve({
        id,
        name: row.name,
        expired: false,
        size_in_bytes: file.size,
        digest: `sha256:${file.sha256}`,
        workflow_run: {
          id: 42,
          head_sha: m.producer.api_head_sha,
          repository_id: 99,
          head_repository_id: 99,
        },
      })
    },
    run: () =>
      Promise.resolve({
        id: 42,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
        head_sha: m.producer.api_head_sha,
        path: QUALIFICATION_WORKFLOW,
        repository: { id: 99, full_name: QUALIFICATION_REPOSITORY },
        head_repository: { full_name: QUALIFICATION_REPOSITORY },
      }),
    downloadReleaseAsset: async (id, path) => {
      const row = published(m).assets.find((x) => x.id === id)!
      await Deno.writeFile(
        path,
        row.name === QUALIFICATION_MANIFEST
          ? canonicalQualificationBytes(m)
          : bytes,
        { createNew: true },
      )
    },
    downloadArtifact: () => Promise.reject(new Error('not used')),
  }
}
Deno.test('qualification identity is canonical, complete, and sensitive to runtime/security/frontend/source inputs', () => {
  const m = fixture()
  assertQualificationManifest(m)
  const reordered = Object.fromEntries(
    Object.entries(m).reverse(),
  ) as QualificationManifest
  assertEquals(qualificationIdentity(m), qualificationIdentity(reordered))
  for (
    const change of [
      (x: QualificationManifest) =>
        x.compatibility.frontend['x86_64-unknown-linux-gnu'].sha256 = 'f'
          .repeat(
            64,
          ),
      (x: QualificationManifest) => {
        x.producer.source_commit = 'c'.repeat(40)
        x.producer.workflow_source_commit = 'c'.repeat(40)
      },
      (x: QualificationManifest) =>
        x.compatibility.runtime_inputs['source-materials/pins.json'] = 'f'
          .repeat(
            64,
          ),
      (x: QualificationManifest) =>
        x.assets[x.targets[0].runtime].sha256 = 'f'.repeat(64),
    ]
  ) {
    const altered = structuredClone(m)
    change(altered)
    assertNotEquals(qualificationIdentity(m), qualificationIdentity(altered))
  }
  for (
    const change of [
      (x: any) => x.state = 'final-qualified',
      (x: any) => x.targets.pop(),
      (x: any) => x.targets[0].abi.arch = 'aarch64',
      (x: any) => x.producer.repository = 'other/repo',
      (x: any) => x.assets['../escape'] = file,
      (x: any) => x.artifacts[0].members['../escape'] = 'pins',
      (x: any) => x.compatibility.frontend.extra = file,
    ]
  ) {
    const altered = structuredClone(m)
    change(altered)
    assertThrows(() => assertQualificationManifest(altered))
  }
})
Deno.test('canonical manifest reader rejects unknown keys, duplicate JSON keys, and a rewritten pinned source', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  try {
    const path = join(root, 'manifest.json'),
      m = fixture(),
      identity = qualificationIdentity(m)
    await Deno.writeFile(path, canonicalQualificationBytes(m))
    await readQualificationManifest(path, identity)
    await Deno.writeTextFile(path, JSON.stringify(m))
    await assertRejects(
      () => readQualificationManifest(path, identity),
      Error,
      'canonical',
    )
    m.producer.source_commit = 'c'.repeat(40)
    m.producer.workflow_source_commit = 'c'.repeat(40)
    await Deno.writeFile(path, canonicalQualificationBytes(m))
    await assertRejects(
      () => readQualificationManifest(path, identity),
      Error,
      'pinned',
    )
    await Deno.writeTextFile(
      path,
      new TextDecoder().decode(canonicalQualificationBytes(m)).replace(
        '{',
        '{"schema_version":1,',
      ),
    )
    await assertRejects(
      () => readQualificationManifest(path),
      Error,
      'canonical',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
Deno.test('candidate provenance rejects wrong original run, attempt, publisher, artifact bytes and expiration', async () => {
  const m = fixture()
  await verifyCandidateProvenance(m, adapter(m))
  for (
    const delta of [
      { conclusion: 'failure' },
      { run_attempt: 2 },
      { head_sha: 'c'.repeat(40) },
      { repository: { full_name: 'other/repo' } },
      { path: '.github/workflows/other.yml' },
    ]
  ) {
    const api = adapter(m), run = await api.run(42, 1)
    api.run = () => Promise.resolve({ ...run, ...delta })
    await assertRejects(
      () => verifyCandidateProvenance(m, api),
      Error,
      'provenance',
    )
  }
  for (
    const delta of [{ expired: true }, { digest: `sha256:${'f'.repeat(64)}` }, {
      workflow_run: { id: 43 },
    }]
  ) {
    const api = adapter(m), original = api.artifact
    api.artifact = async (id) => ({ ...await original(id), ...delta })
    await assertRejects(
      () => verifyCandidateProvenance(m, api),
      Error,
      'provenance',
    )
  }
})
Deno.test('final verification requires actual immutable public bytes, matching peeled tag and hosted attestation', async () => {
  const m = fixture()
  await verifyPublishedQualification(m, adapter(m))
  for (
    const delta of [{ draft: true }, { immutable: false }, {
      prerelease: false,
    }, { target_commitish: 'main' }]
  ) {
    const api = adapter(m)
    api.release = () => Promise.resolve({ ...published(m), ...delta })
    await assertRejects(
      () => verifyPublishedQualification(m, api),
      Error,
      'immutable',
    )
  }
  const absent = adapter(m)
  absent.release = () => Promise.resolve(null)
  await assertRejects(
    () => verifyPublishedQualification(m, absent),
    Error,
    'does not exist',
  )
  const moved = adapter(m)
  moved.tagCommit = () => Promise.resolve('d'.repeat(40))
  await assertRejects(
    () => verifyPublishedQualification(m, moved),
    Error,
    'tag differs',
  )
  const unsigned = adapter(m)
  unsigned.verifyAttestation = () => Promise.reject(new Error('bad signature'))
  await assertRejects(
    () => verifyPublishedQualification(m, unsigned),
    Error,
    'bad signature',
  )
  const corrupt = adapter(m)
  corrupt.download = async (_url, path) => {
    await Deno.writeTextFile(path, 'corrupted')
  }
  await assertRejects(() => verifyPublishedQualification(m, corrupt))
  const missing = adapter(m)
  const release = published(m)
  release.assets.pop()
  missing.release = () => Promise.resolve(release)
  await assertRejects(
    () => verifyPublishedQualification(m, missing),
    Error,
    'attestation',
  )
  const changed = adapter(m)
  const changedRelease = published(m)
  changedRelease.assets[0].digest = `sha256:${'f'.repeat(64)}`
  changed.release = () => Promise.resolve(changedRelease)
  await assertRejects(
    () => verifyPublishedQualification(m, changed),
    Error,
    'digest',
  )
})
Deno.test('payload verifier rejects runtime, proof, receipt, lock and source substitution before qualification', async () => {
  const m = fixture(), root = await Deno.realPath(await Deno.makeTempDir())
  try {
    await Deno.mkdir(join(root, 'source-materials'))
    await Deno.writeTextFile(
      join(root, 'source-materials/runtime-revocations.json'),
      '{"schema_version":1,"revoked_identities":[]}',
    )
    for (const name of Object.keys(m.assets)) {
      await Deno.writeFile(join(root, name), bytes)
    }
    for (
      const name of [
        m.targets[0].runtime,
        m.targets[0].proof,
        m.targets[0].build_receipt,
        m.source.selected_lock,
        m.source.archives['deno-source.tar.gz'],
      ]
    ) {
      await Deno.writeTextFile(join(root, name), 'substituted bytes')
      await assertRejects(
        () => verifyQualificationDirectory(m, root, root),
        Error,
        'payload digest/size mismatch',
      )
      await Deno.writeFile(join(root, name), bytes)
    }
    await Deno.remove(join(root, 'lock'))
    await Deno.symlink(join(root, 'pins'), join(root, 'lock'))
    await assertRejects(
      () => verifyQualificationDirectory(m, root, root),
      Error,
      'symlink',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
Deno.test('promotion rejects PR, tag, stale workflow/source and self-hosted context before side effects', () => {
  const ctx: PromotionContext = {
    repository: QUALIFICATION_REPOSITORY,
    event: 'push',
    ref: 'refs/heads/main',
    source_sha: commit,
    workflow_sha: commit,
    workflow_ref:
      `${QUALIFICATION_REPOSITORY}/${QUALIFICATION_WORKFLOW}@refs/heads/main`,
    operation: 'release',
    runner_environment: 'github-hosted',
  }
  assertPromotionContext(ctx)
  for (
    const delta of [
      { event: 'pull_request' },
      { ref: 'refs/tags/v1' },
      { workflow_sha: 'b'.repeat(40) },
      { runner_environment: 'self-hosted' },
      { operation: 'release-build-validation' },
      { repository: 'fork/repo' },
    ]
  ) {
    assertThrows(
      () => assertPromotionContext({ ...ctx, ...delta }),
      Error,
      'trusted hosted main',
    )
  }
})
Deno.test('ZIP extraction rejects traversal, symlinks, duplicate members, and file ancestors', async () => {
  const root = await Deno.realPath(await Deno.makeTempDir())
  try {
    const script =
      `import zipfile,sys,stat\np=sys.argv[1]\nfor case in ['good','traversal','symlink','duplicate','ancestor']:\n with zipfile.ZipFile(p+'/'+case+'.zip','w') as z:\n  if case=='good': z.writestr('folder/member','ok')\n  if case=='traversal': z.writestr('../member','bad')\n  if case=='duplicate': z.writestr('member','a'); z.writestr('member','b')\n  if case=='ancestor': z.writestr('folder','a'); z.writestr('folder/member','b')\n  if case=='symlink':\n   i=zipfile.ZipInfo('member'); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'outside')\n`
    const made = await new Deno.Command('python3', {
      args: ['-c', script, root],
      stdout: 'null',
      stderr: 'null',
    }).output()
    assertEquals(made.code, 0)
    await extractQualificationZip(join(root, 'good.zip'), {
      'folder/member': 'output',
    }, root)
    assertEquals(await Deno.readTextFile(join(root, 'output')), 'ok')
    for (const name of ['traversal', 'symlink', 'duplicate', 'ancestor']) {
      await assertRejects(
        () =>
          extractQualificationZip(join(root, `${name}.zip`), {
            member: `output-${name}`,
          }, root),
        Error,
        'verification failed',
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('future main-origin qualification cannot counterfeit historical PR evidence', () => {
  const m = fixture()
  m.producer.reviewed_main_equivalent = null
  assertThrows(() => assertQualificationManifest(m), Error, 'main-origin')
  m.producer.workflow_ref = 'refs/heads/main'
  assertThrows(() => assertQualificationManifest(m), Error, 'main-origin')
  m.producer.api_head_sha = m.producer.source_commit
  assertQualificationManifest(m)
  m.producer.workflow_source_commit = 'd'.repeat(40)
  assertThrows(() => assertQualificationManifest(m), Error, 'original source')
})
Deno.test('verified attestation JSON binds exactly the runtime manifest subject', () => {
  const value = [{
    verificationResult: {
      statement: {
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{
          name: QUALIFICATION_MANIFEST,
          digest: { sha256: file.sha256 },
        }],
      },
    },
  }]
  verifyQualificationAttestationResult(value, file.sha256)
  for (
    const change of [
      (x: any) =>
        x[0].verificationResult.statement.subject[0].digest.sha256 = 'f'.repeat(
          64,
        ),
      (x: any) =>
        x[0].verificationResult.statement.subject[0].name = 'application.json',
      (x: any) => x[0].verificationResult.statement.predicateType = 'other',
      (x: any) =>
        x[0].verificationResult.statement.subject.push(
          x[0].verificationResult.statement.subject[0],
        ),
    ]
  ) {
    const bad = structuredClone(value)
    change(bad)
    assertThrows(
      () => verifyQualificationAttestationResult(bad, file.sha256),
      Error,
      'subject differs',
    )
  }
})
Deno.test('draft resume validates present bytes and original attestation, returns only missing assets', async () => {
  const m = fixture(),
    api = adapter(m),
    full = { ...published(m), draft: true, immutable: false }
  const complete = await verifyQualificationDraft(m, full, commit, api, true)
  assertEquals(complete.missing_assets, [])
  assertEquals(complete.needs_attestation, false)
  assertEquals(complete.current_main_policy?.outcome, 'allow')
  const partial = {
    ...full,
    assets: full.assets.filter((x) =>
      x.name !== QUALIFICATION_MANIFEST && x.name !== 'zip-0'
    ),
  }
  assertEquals(await verifyQualificationDraft(m, partial, commit, api), {
    missing_assets: [QUALIFICATION_MANIFEST, 'zip-0'].sort(),
    needs_attestation: false,
    current_main_policy: null,
  })
  await assertRejects(
    () => verifyQualificationDraft(m, partial, commit, api, true),
    Error,
    'incomplete',
  )
  const empty = { ...full, assets: [] }
  const pending = await verifyQualificationDraft(m, empty, commit, api)
  assertEquals(pending.needs_attestation, true)
  assertEquals(pending.missing_assets.length, Object.keys(m.assets).length + 1)
  for (
    const delta of [{ target_commitish: 'd'.repeat(40) }, { draft: false }, {
      prerelease: false,
    }, { immutable: true }]
  ) {
    await assertRejects(
      () => verifyQualificationDraft(m, { ...full, ...delta }, commit, api),
      Error,
      'conflicts',
    )
  }
  const unknown = {
    ...full,
    assets: [...full.assets, { ...full.assets[0], name: 'unknown' }],
  }
  await assertRejects(
    () => verifyQualificationDraft(m, unknown, commit, api),
    Error,
    'unknown',
  )
  const mismatch = structuredClone(full)
  mismatch.assets[0].digest = 'sha256:' + 'f'.repeat(64)
  await assertRejects(
    () => verifyQualificationDraft(m, mismatch, commit, api),
    Error,
    'conflicts',
  )
  const corrupt = adapter(m)
  corrupt.downloadReleaseAsset = async (_id, path) => {
    await Deno.writeTextFile(path, 'tampered')
  }
  await assertRejects(
    () => verifyQualificationDraft(m, full, commit, corrupt),
    Error,
    'digest/size',
  )
  const wrongSigner = adapter(m)
  wrongSigner.verifyAttestation = () =>
    Promise.reject(new Error('wrong signer'))
  await assertRejects(
    () => verifyQualificationDraft(m, full, commit, wrongSigner),
    Error,
    'wrong signer',
  )
})

Deno.test('draft preview URLs never select transport and published URLs remain exact', async () => {
  const m = fixture(), api = adapter(m)
  const draft = { ...published(m), draft: true, immutable: false }
  for (const row of draft.assets) {
    row.browser_download_url =
      `https://github.com/${QUALIFICATION_REPOSITORY}/releases/download/untagged-0123456789abcdefabcd/${row.name}`
  }
  const ids: number[] = [], read = api.downloadReleaseAsset
  api.download = () => {
    throw new Error('must not fetch browser URL')
  }
  api.downloadReleaseAsset = async (id, path) => {
    ids.push(id)
    await read(id, path)
  }
  const result = await verifyQualificationDraft(m, draft, commit, api, true)
  assertEquals(result.missing_assets, [])
  assertEquals(ids, draft.assets.map((row) => row.id))
  // Even untrusted informational metadata cannot redirect the fixed API read.
  draft.assets[0].browser_download_url = 'https://example.invalid/ignored'
  await verifyQualificationDraft(m, draft, commit, api, true)
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = structuredClone(draft)
    bad.assets[0].id = id
    await assertRejects(
      () => verifyQualificationDraft(m, bad, commit, api),
      Error,
      'invalid release asset ID',
    )
  }
  const duplicate = structuredClone(draft)
  duplicate.assets[1].id = duplicate.assets[0].id
  await assertRejects(
    () => verifyQualificationDraft(m, duplicate, commit, api),
    Error,
    'duplicate',
  )
  api.release = () =>
    Promise.resolve({ ...draft, draft: false, immutable: true })
  await assertRejects(
    () => verifyPublishedQualification(m, api),
    Error,
    'asset',
  )
})

function promotionContext(source = commit): PromotionContext {
  return {
    repository: QUALIFICATION_REPOSITORY,
    event: 'push',
    ref: 'refs/heads/main',
    source_sha: source,
    workflow_sha: source,
    workflow_ref:
      `${QUALIFICATION_REPOSITORY}/${QUALIFICATION_WORKFLOW}@refs/heads/main`,
    operation: 'release',
    runner_environment: 'github-hosted',
  }
}

Deno.test('later hosted main can finish only a complete draft with its original ancestor signature', async () => {
  const m = fixture(), full = { ...published(m), draft: true, immutable: false }
  const current = 'c'.repeat(40), context = promotionContext(current)
  const api = adapter(m), ancestry: [string, string | undefined][] = []
  api.verifyMainAncestor = (source, descendant) => {
    ancestry.push([source, descendant])
    return Promise.resolve()
  }
  const before = structuredClone(full)
  const result = await verifyPromotionDraft(
    m,
    full,
    context,
    api,
    false,
    allowPolicy,
  )
  assertEquals(result.recovery_mode, 'complete-attested-ancestor')
  assertEquals(result.source_sha, current)
  assertEquals(result.attested_source_sha, commit)
  assertEquals(result.missing_assets, [])
  assertEquals(result.needs_attestation, false)
  assertEquals(result.current_main_policy?.outcome, 'allow')
  assertEquals(ancestry, [[current, undefined], [commit, current]])
  assertEquals(full, before)

  for (const name of ['zip-0', `${QUALIFICATION_MANIFEST}.intoto.jsonl`]) {
    const partial = {
      ...full,
      assets: full.assets.filter((row) => row.name !== name),
    }
    await assertRejects(
      () => verifyPromotionDraft(m, partial, context, api, false, allowPolicy),
      Error,
      'incomplete',
    )
    const same = await verifyPromotionDraft(
      m,
      partial,
      promotionContext(),
      api,
      false,
      allowPolicy,
    )
    assertEquals(same.recovery_mode, 'same-source')
    assertEquals(same.source_sha, commit)
    assertEquals(same.attested_source_sha, commit)
    assertEquals(same.current_main_policy, null)
  }
  for (const failure of ['ancestry', 'signature', 'bytes', 'tag']) {
    const bad = adapter(m)
    let downloads = 0
    const read = bad.downloadReleaseAsset
    bad.downloadReleaseAsset = async (id, path) => {
      downloads++
      await read(id, path)
    }
    if (failure === 'ancestry') {
      bad.verifyMainAncestor = (_source, descendant) =>
        descendant
          ? Promise.reject(new Error('not executor ancestor'))
          : Promise.resolve()
    }
    if (failure === 'signature') {
      bad.verifyAttestation = () =>
        Promise.reject(new Error('wrong original signer'))
    }
    if (failure === 'bytes') {
      bad.downloadReleaseAsset = (_id, path) =>
        Deno.writeTextFile(path, 'changed')
    }
    if (failure === 'tag') bad.tagCommit = () => Promise.resolve(current)
    await assertRejects(() =>
      verifyPromotionDraft(m, full, context, bad, false, allowPolicy)
    )
    if (failure === 'ancestry' || failure === 'tag') assertEquals(downloads, 0)
  }
  for (
    const change of [
      { event: 'pull_request' },
      { runner_environment: 'self-hosted' },
      { workflow_sha: commit },
      { ref: 'refs/tags/example' },
    ]
  ) {
    const bad = adapter(m)
    bad.verifyMainAncestor = () => {
      throw new Error('context must reject before API')
    }
    await assertRejects(
      () =>
        verifyPromotionDraft(
          m,
          full,
          { ...context, ...change },
          bad,
          false,
          allowPolicy,
        ),
      Error,
      'trusted hosted main',
    )
  }
  await assertRejects(
    () =>
      verifyPromotionDraft(m, full, context, api, true, {
        fetch: () =>
          Promise.resolve(
            Response.json({
              schema_version: 1,
              revoked_identities: [qualificationIdentity(m)],
            }),
          ),
      }),
    Error,
    'revoked',
  )
})

Deno.test('ancestor adapter binds an earlier producer to the exact executor commit', async () => {
  const current = 'c'.repeat(40), calls: string[] = []
  const api = githubQualificationAdapter({
    token: null,
    fetch: (input) => {
      calls.push(String(input))
      return Promise.resolve(
        Response.json({ status: 'ahead', merge_base_commit: { sha: commit } }),
      )
    },
  })
  await api.verifyMainAncestor(commit, current)
  assertEquals(calls, [
    `https://api.github.com/repos/${QUALIFICATION_REPOSITORY}/compare/${commit}...${current}`,
  ])
  for (const value of ['main', '../main', current + '?page=1']) {
    await assertRejects(
      () => api.verifyMainAncestor(commit, value),
      Error,
      'invalid promotion executor source',
    )
  }
  for (
    const response of [
      { status: 'behind', merge_base_commit: { sha: commit } },
      { status: 'diverged', merge_base_commit: { sha: commit } },
      { status: 'ahead', merge_base_commit: { sha: current } },
    ]
  ) {
    const bad = githubQualificationAdapter({
      token: null,
      fetch: () => Promise.resolve(Response.json(response)),
    })
    await assertRejects(
      () => bad.verifyMainAncestor(commit, current),
      Error,
      'not on main',
    )
  }
})

Deno.test('public adapter uses bounded credential-free HTTPS without gh configuration', async () => {
  const calls: { url: string; authorization: string | null }[] = []
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input), headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') })
    assertEquals(init?.redirect, 'error')
    assertEquals(init?.signal instanceof AbortSignal, true)
    if (url.endsWith('/git/ref/tags/runtime-test')) {
      return Promise.resolve(
        Response.json({ object: { type: 'commit', sha: commit } }),
      )
    }
    if (url.endsWith(`/compare/${commit}...main`)) {
      return Promise.resolve(
        Response.json({ status: 'ahead', merge_base_commit: { sha: commit } }),
      )
    }
    if (url.endsWith('/releases/tags/runtime-test')) {
      return Promise.resolve(Response.json({ tag_name: 'runtime-test' }))
    }
    throw new Error('unexpected metadata request')
  }
  // No subprocess permission or host configuration is used in these calls.
  const api = githubQualificationAdapter({ fetch: fetcher, token: null })
  await api.release('runtime-test')
  assertEquals(await api.tagCommit('runtime-test'), commit)
  await api.verifyMainAncestor(commit)
  assertEquals(calls.length, 3)
  for (const call of calls) {
    assertEquals(new URL(call.url).hostname, 'api.github.com')
    assertEquals(call.authorization, null)
  }
  for (const status of [401, 403, 429, 500]) {
    const failed = githubQualificationAdapter({
      fetch: () =>
        Promise.resolve(new Response('body must not be logged', { status })),
      token: null,
    })
    await assertRejects(
      () => failed.release('runtime-test'),
      Error,
      `(${status})`,
    )
  }
  let absentCalls = 0
  const absent = githubQualificationAdapter({
    token: null,
    fetch: () =>
      Promise.resolve(
        ++absentCalls === 1
          ? new Response('', { status: 404 })
          : Response.json([]),
      ),
  })
  assertEquals(await absent.release('runtime-test'), null)
  assertEquals(absentCalls, 2)
  for (
    const response of [
      new Response('x', {
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
      }),
      new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    ]
  ) {
    const oversized = githubQualificationAdapter({
      token: null,
      fetch: () => Promise.resolve(response),
    })
    await assertRejects(
      () => oversized.release('runtime-test'),
      Error,
      'size bound',
    )
  }
  const malformed = githubQualificationAdapter({
    token: null,
    fetch: () => Promise.resolve(new Response('{bad-json')),
  })
  await assertRejects(
    () => malformed.release('runtime-test'),
    Error,
    'invalid GitHub metadata JSON',
  )
})

Deno.test('promotion never adopts or overwrites a conflicting preexisting tag', async () => {
  const m = fixture(), tag = qualificationTag(m), api = adapter(m)
  assertEquals(
    await verifyQualificationTagForPromotion(tag, commit, api),
    'matching',
  )
  api.tagCommit = () => Promise.resolve(null)
  assertEquals(
    await verifyQualificationTagForPromotion(tag, commit, api),
    'absent',
  )
  api.tagCommit = () => Promise.resolve('d'.repeat(40))
  await assertRejects(
    () => verifyQualificationTagForPromotion(tag, commit, api),
    Error,
    'tag conflicts',
  )
  api.tagCommit = () => Promise.reject(new Error('tag lookup unavailable'))
  await assertRejects(
    () => verifyQualificationTagForPromotion(tag, commit, api),
    Error,
    'lookup unavailable',
  )
  const draft = { ...published(m), draft: true, immutable: false }
  const absent = adapter(m)
  absent.tagCommit = () => Promise.resolve(null)
  assertEquals(
    (await verifyQualificationDraft(m, draft, commit, absent, true))
      .missing_assets,
    [],
  )
  const wrong = adapter(m)
  wrong.tagCommit = () => Promise.resolve('d'.repeat(40))
  let downloaded = 0
  wrong.downloadReleaseAsset = () => {
    downloaded++
    throw new Error('must not download')
  }
  await assertRejects(
    () => verifyQualificationDraft(m, draft, commit, wrong, true),
    Error,
    'tag conflicts',
  )
  assertEquals(downloaded, 0)
  const raced = adapter(m)
  let reads = 0
  raced.tagCommit = () =>
    Promise.resolve(++reads === 1 ? commit : 'd'.repeat(40))
  await assertRejects(
    () => verifyQualificationDraft(m, draft, commit, raced, true),
    Error,
    'tag conflicts',
  )
  assertEquals(reads, 2)
})
Deno.test('tag adapter distinguishes exact 404 absence from metadata and annotated-object errors', async () => {
  const missing = githubQualificationAdapter({
    token: null,
    fetch: () => Promise.resolve(new Response('', { status: 404 })),
  })
  assertEquals(await missing.tagCommit('runtime-test'), null)
  for (const status of [401, 403, 429, 500]) {
    const failed = githubQualificationAdapter({
      token: null,
      fetch: () => Promise.resolve(new Response('not absence', { status })),
    })
    await assertRejects(
      () => failed.tagCommit('runtime-test'),
      Error,
      `(${status})`,
    )
  }
  const malformed = githubQualificationAdapter({
    token: null,
    fetch: () =>
      Promise.resolve(Response.json({ object: { type: 'blob', sha: commit } })),
  })
  await assertRejects(
    () => malformed.tagCommit('runtime-test'),
    Error,
    'does not identify a commit',
  )
  let calls = 0
  const broken = githubQualificationAdapter({
    token: null,
    fetch: () =>
      Promise.resolve(
        ++calls === 1
          ? Response.json({ object: { type: 'tag', sha: commit } })
          : new Response('', { status: 404 }),
      ),
  })
  await assertRejects(
    () => broken.tagCommit('runtime-test'),
    Error,
    'annotated tag object is missing',
  )
})

Deno.test('published qualification survives expired CI and unavailable original PR objects', async () => {
  const m = fixture(), api = adapter(m)
  let originalReads = 0
  api.verifyOriginalLineage = () => {
    originalReads++
    return Promise.reject(new Error('original PR object no longer available'))
  }
  api.run = () => {
    originalReads++
    return Promise.reject(new Error('original run unavailable'))
  }
  api.artifact = () => {
    originalReads++
    return Promise.reject(new Error('original artifact expired'))
  }
  // Independently fetched immutable assets and hosted attestation remain the
  // final trust boundary. No original Actions/PR endpoint may be consulted.
  await verifyPublishedQualification(m, api)
  assertEquals(originalReads, 0)
  await assertRejects(
    () => verifyCandidateProvenance(m, api),
    Error,
    'original PR object no longer available',
  )
  assertEquals(originalReads, 1)
  const expired = adapter(m)
  const originalArtifact = expired.artifact
  expired.artifact = async (id) => ({
    ...await originalArtifact(id),
    expired: true,
  })
  await assertRejects(
    () => verifyCandidateProvenance(m, expired),
    Error,
    'expired',
  )
})

Deno.test('fresh main revocation added after an earlier acceptance prevents final qualification and publication', async () => {
  const m = fixture(), api = adapter(m), selected = qualificationIdentity(m)
  await verifyPublishedQualificationProduction(m, api, [], allowPolicy)
  const newlyRevoked = {
    fetch: () =>
      Promise.resolve(
        Response.json({ schema_version: 1, revoked_identities: [selected] }),
      ),
  }
  await assertRejects(
    () => verifyPublishedQualificationProduction(m, api, [], newlyRevoked),
    Error,
    'revoked',
  )
  const fullDraft = { ...published(m), draft: true, immutable: false }
  await assertRejects(
    () =>
      verifyQualificationDraftProduction(
        m,
        fullDraft,
        commit,
        api,
        true,
        newlyRevoked,
      ),
    Error,
    'revoked',
  )
  const unrelatedPolicy = {
    fetch: () =>
      Promise.resolve(
        Response.json({
          schema_version: 1,
          revoked_identities: ['f'.repeat(64)],
        }),
      ),
  }
  await verifyPublishedQualificationProduction(m, api, [], unrelatedPolicy)
})

const workflowQualificationDirectory =
  'dist/release-inputs/runtime-qualification'
async function withQualificationArchiveFixture(
  action: (
    fixture: { root: string; manifest: QualificationManifest },
  ) => Promise<void>,
  unsafe: 'none' | 'traversal' | 'symlink' = 'none',
): Promise<void> {
  const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: 'slv-qualification-path-test-' }),
    ),
    previous = Deno.cwd(),
    m = fixture()
  try {
    await Deno.mkdir(join(root, workflowQualificationDirectory), {
      recursive: true,
    })
    const script = String.raw`
import io,json,os,sys,tarfile,zipfile
root,members,artifacts,unsafe=sys.argv[1:]
content=b'fixture bytes\n'
for row in json.loads(artifacts):
 with zipfile.ZipFile(os.path.join(root,'dist','release-inputs','runtime-qualification',row['asset']),'w') as z:
  for member in row['members']: z.writestr(member,content)
for name in ['slv-source','deno-source','deno-cargo-vendor']:
 with tarfile.open(os.path.join(root,'dist','release-inputs','runtime-qualification',name+'.tar.gz'),'w:gz') as tar:
  directory=tarfile.TarInfo(name);directory.type=tarfile.DIRTYPE;tar.addfile(directory)
  paths=list(json.loads(members)) if name=='slv-source' else [name+'/file.txt']
  for path in paths:
   item=tarfile.TarInfo(path);item.size=len(content);tar.addfile(item,io.BytesIO(content))
  if name=='slv-source' and unsafe=='traversal':
   item=tarfile.TarInfo('slv-source/../escape');item.size=len(content);tar.addfile(item,io.BytesIO(content))
  if name=='slv-source' and unsafe=='symlink':
   item=tarfile.TarInfo('slv-source/escape');item.type=tarfile.SYMTYPE;item.linkname='../../outside';tar.addfile(item)
`
    const made = await new Deno.Command('python3', {
      args: [
        '-c',
        script,
        root,
        JSON.stringify(m.source.members),
        JSON.stringify(m.artifacts),
        unsafe,
      ],
      stdin: 'null',
      stdout: 'null',
      stderr: 'piped',
    }).output()
    if (!made.success) throw new Error('cannot prepare archive fixture')
    Deno.chdir(root)
    await action({ root, manifest: m })
  } finally {
    Deno.chdir(previous)
    await Deno.remove(root, { recursive: true })
  }
}
for (const relative of [false, true]) {
  Deno.test(`source extraction accepts safe ${relative ? 'relative' : 'absolute'} payload paths across scanner cwd`, () =>
    withQualificationArchiveFixture(async ({ root, manifest }) => {
      const directory = relative
        ? workflowQualificationDirectory
        : join(root, workflowQualificationDirectory)
      await extractQualificationSourceMembers(manifest, directory)
      for (const name of Object.values(manifest.source.members)) {
        assertEquals(
          await Deno.readFile(join(root, workflowQualificationDirectory, name)),
          bytes,
        )
      }
    }))
  Deno.test(`archive binding accepts safe ${relative ? 'relative' : 'absolute'} payload paths across scanner cwd`, () =>
    withQualificationArchiveFixture(async ({ root, manifest }) => {
      await verifyQualificationArchiveBindings(
        manifest,
        relative
          ? workflowQualificationDirectory
          : join(root, workflowQualificationDirectory),
      )
    }))
}
for (const unsafe of ['traversal', 'symlink'] as const) {
  Deno.test(`relative qualification archives still reject ${unsafe} before extraction`, () =>
    withQualificationArchiveFixture(async ({ root, manifest }) => {
      await assertRejects(() =>
        extractQualificationSourceMembers(
          manifest,
          workflowQualificationDirectory,
        )
      )
      await assertRejects(
        () => Deno.stat(join(root, workflowQualificationDirectory, 'recipe')),
        Deno.errors.NotFound,
      )
      await assertRejects(() =>
        verifyQualificationArchiveBindings(
          manifest,
          workflowQualificationDirectory,
        )
      )
      await assertRejects(
        () => Deno.stat(join(root, 'escape')),
        Deno.errors.NotFound,
      )
    }, unsafe))
}

Deno.test('qualification evidence keeps same-filesystem hardlinks and rejects existing destinations', async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'slv-qualification-link-test-' }),
  )
  try {
    const source = join(root, 'source'), destination = join(root, 'staged')
    await Deno.writeFile(source, bytes)
    assertEquals((await Deno.stat(source)).dev, (await Deno.stat(root)).dev)
    assertEquals(
      await stageQualificationEvidenceFile(source, destination),
      'hardlink',
    )
    assertEquals(
      (await Deno.stat(source)).ino,
      (await Deno.stat(destination)).ino,
    )
    assertEquals(await Deno.readFile(destination), bytes)
    await assertRejects(() =>
      stageQualificationEvidenceFile(source, destination)
    )
    assertEquals(await Deno.readFile(destination), bytes)
    const linked = join(root, 'source-link')
    await Deno.symlink(source, linked)
    await assertRejects(
      () => stageQualificationEvidenceFile(linked, join(root, 'unsafe')),
      Error,
      'symlink',
    )
    await assertRejects(() =>
      stageQualificationEvidenceFile(
        source,
        join(root, 'missing-parent', 'file'),
      )
    )
    await assertRejects(
      () => Deno.stat(join(root, 'missing-parent')),
      Deno.errors.NotFound,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
const mountedEvidenceFixture = fileURLToPath(
  new URL('./runtime-qualification.ts', import.meta.url),
)
const hasSeparateMountedFilesystem = Deno.build.os === 'linux' &&
  (await Deno.stat(mountedEvidenceFixture)).dev !==
    (await Deno.stat('/tmp')).dev
Deno.test({
  name:
    'qualification evidence copies exclusively from a separate mounted filesystem',
  ignore: !hasSeparateMountedFilesystem,
  fn: async () => {
    const source = mountedEvidenceFixture
    const scratch = await Deno.realPath(
      await Deno.makeTempDir({
        dir: '/tmp',
        prefix: 'slv-qualification-scratch-',
      }),
    )
    try {
      const destination = join(scratch, 'staged'),
        content = await Deno.readFile(source)
      const sourceInfo = await Deno.stat(source),
        scratchInfo = await Deno.stat(scratch)
      if (sourceInfo.dev === scratchInfo.dev) {
        throw new Error('test requires actual distinct st_dev values')
      }
      assertEquals(
        await stageQualificationEvidenceFile(source, destination),
        'copy',
      )
      assertEquals(await Deno.readFile(destination), content)
      assertEquals(await Deno.readFile(source), content)
      assertEquals((await Deno.stat(source)).mode, sourceInfo.mode)
      await assertRejects(() =>
        stageQualificationEvidenceFile(source, destination)
      )
      assertEquals(await Deno.readFile(destination), content)
      const marker = join(scratch, 'marker'),
        collision = join(scratch, 'symlink-collision')
      await Deno.writeTextFile(marker, 'preserve')
      await Deno.symlink(marker, collision)
      await assertRejects(() =>
        stageQualificationEvidenceFile(source, collision)
      )
      assertEquals(await Deno.readTextFile(marker), 'preserve')
      assertEquals((await Deno.lstat(collision)).isSymlink, true)
    } finally {
      await Deno.remove(scratch, { recursive: true })
    }
  },
})
