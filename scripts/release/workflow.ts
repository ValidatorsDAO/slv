/** Release-event resolution and local release-directory verification.
 * Network mutation remains in the workflow; this module makes its decisions
 * testable without a GitHub credential. */
import { type Asset, hashFile, manifest, payloadSpecs } from './release.ts'

const SHA = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const TAG = /^v(\d{4}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12]\d|3[01])\.\d{4})$/
const PRODUCT_TARGETS = new Set([
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
])
const SELECTED_CARGO_LOCK_SHA256 =
  '09afc50a2481cea2e77e0d27eff26db844362067bfbc51357f3927d49cbf815d'
export type ReleaseState = 'absent' | 'draft' | 'immutable'
export type ReleaseMode = 'ci' | 'main-release' | 'tag-release' | 'tag-recovery'
export type Publication = 'none' | 'initial' | 'recover' | 'verify'
export type Resolution = {
  mode: ReleaseMode
  release_required: boolean
  version: string
  tag: string
  source_sha: string
  source_ref: string
  source_timestamp: string
  publication: Publication
}
export type CommandResult = { code: number; stdout: string; stderr: string }
export type ResolverRuntime = {
  env(name: string): string | undefined
  command(command: string, args: string[]): Promise<CommandResult>
}

const fail = (message: string): never => {
  throw new Error(message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a SHA-256 digest`)
  }
  return value as string
}

function equalJson(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      return `{${
        Object.keys(object).sort().map((key) =>
          `${JSON.stringify(key)}:${stable(object[key])}`
        ).join(',')
      }}`
    }
    return JSON.stringify(value) ?? 'undefined'
  }
  return stable(left) === stable(right)
}

async function regularHash(path: string, label: string): Promise<string> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink) fail(`${label} must be a regular file`)
  return await hashFile(path)
}

async function readJson(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await Deno.readTextFile(path)), label)
  } catch (error) {
    return fail(
      `${label} is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

export type VerifiedBaselineRuntime = {
  runtimePath: string
  baselineDenortSha256: string
  bridgePath: string
  baselineBridgeSha256: string
  sourceSelectedCargoLockSha256: string
  derivedRelinkCargoLockSha256: string
  sourceReceiptSha256: string
  nativeProofSha256: string
  buildReceiptSha256: string
}

/**
 * Admit only the source-built baseline runtime subset to an official product
 * compile. The source proof and its full transport manifest remain the binding
 * record; modified sentinel outputs and an upstream Deno runtime are never
 * candidates here.
 */
export async function verifyBaselineRuntime(
  target: string,
  sourceSha: string,
  sourceReceiptPath: string,
  nativeProofPath: string,
  runtimeDirectory: string,
): Promise<VerifiedBaselineRuntime> {
  if (!PRODUCT_TARGETS.has(target)) {
    fail(`unsupported product target: ${target}`)
  }
  if (!SHA.test(sourceSha)) fail('product runtime source SHA is invalid')

  const entries = new Set<string>()
  for await (const entry of Deno.readDir(runtimeDirectory)) {
    if (entry.isSymlink) fail('product runtime has a symbolic-link entry')
    entries.add(entry.name)
  }
  if (!equalJson([...entries].sort(), ['build-receipt.json', 'transport'])) {
    fail('product runtime has an unexpected top-level inventory')
  }
  const transportDirectory = `${runtimeDirectory}/transport`
  const transportEntries = new Set<string>()
  for await (const entry of Deno.readDir(transportDirectory)) {
    if (entry.isSymlink) {
      fail('product runtime transport has a symbolic-link entry')
    }
    transportEntries.add(entry.name)
  }
  const linuxCompatibilityInputs = target.endsWith('-unknown-linux-gnu')
    ? ['tls-localhost.crt', 'tls-localhost.key', 'tls-root-ca.pem']
    : []
  if (
    !equalJson(
      [...transportEntries].sort(),
      [
        'baseline-denort',
        'baseline-bridge',
        'baseline-derived-relink-Cargo.lock',
        'manifest.json',
        ...linuxCompatibilityInputs,
      ].sort(),
    )
  ) fail('product runtime has an unexpected transport subset')

  const [sourceReceipt, proof, buildReceipt, manifest] = await Promise.all([
    readJson(sourceReceiptPath, 'source materials receipt'),
    readJson(nativeProofPath, 'native target proof'),
    readJson(`${runtimeDirectory}/build-receipt.json`, 'runtime build receipt'),
    readJson(
      `${transportDirectory}/manifest.json`,
      'runtime transport manifest',
    ),
  ])
  const sourceReceiptSha256 = await regularHash(
    sourceReceiptPath,
    'source materials receipt',
  )
  const nativeProofSha256 = await regularHash(
    nativeProofPath,
    'native target proof',
  )
  const buildReceiptSha256 = await regularHash(
    `${runtimeDirectory}/build-receipt.json`,
    'runtime build receipt',
  )
  const manifestSha256 = await regularHash(
    `${transportDirectory}/manifest.json`,
    'runtime transport manifest',
  )
  const baselinePath = `${transportDirectory}/baseline-denort`
  const bridgePath = `${transportDirectory}/baseline-bridge`
  const derivedLockPath =
    `${transportDirectory}/baseline-derived-relink-Cargo.lock`
  const [
    baselineDenortSha256,
    baselineBridgeSha256,
    derivedRelinkCargoLockSha256,
  ] = await Promise
    .all([
      regularHash(baselinePath, 'baseline denort'),
      regularHash(bridgePath, 'baseline bridge'),
      regularHash(derivedLockPath, 'baseline derived relink Cargo.lock'),
    ])

  const runtimeSecurity = record(
    sourceReceipt.runtime_security,
    'runtime security',
  )
  const source = record(sourceReceipt.source, 'source materials source')
  const selected = record(runtimeSecurity.selected, 'selected runtime security')
  const selectedCargo = record(selected.cargo_lock, 'selected Cargo.lock')
  const sourceSelectedCargoLockSha256 = sha256(
    selectedCargo.sha256,
    'selected Cargo.lock',
  )
  if (sourceSelectedCargoLockSha256 !== SELECTED_CARGO_LOCK_SHA256) {
    fail('source receipt selected Cargo.lock is not the reviewed runtime lock')
  }

  const proofArtifacts = record(proof.artifacts, 'native proof artifacts')
  const proofBaseline = record(proofArtifacts.baseline, 'native proof baseline')
  const buildArtifacts = record(
    buildReceipt.artifacts,
    'runtime build artifacts',
  )
  const buildBaseline = record(
    buildArtifacts.baseline,
    'runtime build baseline',
  )
  const manifestEntries = record(manifest.entries, 'runtime transport entries')
  const manifestBaseline = record(
    manifestEntries['baseline-denort'],
    'runtime transport baseline denort',
  )
  const manifestBridge = record(
    manifestEntries['baseline-bridge'],
    'runtime transport baseline bridge',
  )
  const manifestLock = record(
    manifestEntries['baseline-derived-relink-Cargo.lock'],
    'runtime transport derived lock',
  )
  const manifestArtifacts = record(
    manifest.artifacts,
    'runtime transport artifacts',
  )
  const manifestBuildBaseline = record(
    manifestArtifacts.baseline,
    'runtime transport baseline artifacts',
  )
  const buildTransport = record(
    buildReceipt.transport,
    'runtime build transport',
  )
  const bridgeInfo = await Deno.stat(bridgePath)
  if (
    manifestBridge.path !== 'baseline-bridge' ||
    sha256(manifestBridge.sha256, 'manifest baseline bridge') !==
      baselineBridgeSha256 ||
    manifestBridge.size !== bridgeInfo.size
  ) fail('baseline bridge differs from runtime transport manifest')
  for (const name of linuxCompatibilityInputs) {
    const path = `${transportDirectory}/${name}`
    const entry = record(manifestEntries[name], `runtime transport ${name}`)
    const digest = await regularHash(path, `runtime transport ${name}`)
    const info = await Deno.stat(path)
    if (
      entry.path !== name ||
      sha256(entry.sha256, `runtime transport ${name} digest`) !== digest ||
      entry.size !== info.size
    ) fail(`runtime transport manifest does not bind ${name}`)
  }
  if (
    sourceReceipt.schema_version !== 1 ||
    sourceReceipt.kind !== 'slv-source-materials' ||
    source.commit !== sourceSha ||
    proof.schema_version !== 1 ||
    proof.kind !== 'slv-source-target-proof' ||
    proof.status !== 'passed' ||
    proof.target !== target || proof.source_commit !== sourceSha ||
    proof.source_receipt_sha256 !== sourceReceiptSha256 ||
    proof.build_receipt_sha256 !== buildReceiptSha256 ||
    buildReceipt.schema_version !== 1 ||
    buildReceipt.kind !== 'slv-source-build-receipt' ||
    buildReceipt.target !== target ||
    buildReceipt.source_commit !== sourceSha ||
    buildReceipt.source_receipt_sha256 !== sourceReceiptSha256 ||
    buildReceipt.source_selected_cargo_lock_sha256 !==
      sourceSelectedCargoLockSha256 ||
    buildTransport.manifest !== 'transport/manifest.json' ||
    buildTransport.manifest_sha256 !== manifestSha256 ||
    manifest.schema_version !== 1 ||
    manifest.kind !== 'slv-source-native-transport' ||
    manifest.target !== target ||
    manifest.source_receipt_sha256 !== sourceReceiptSha256 ||
    !equalJson(manifest.artifacts, buildReceipt.artifacts) ||
    sha256(
        proof.source_selected_cargo_lock_sha256,
        'proof selected Cargo.lock',
      ) !==
      sourceSelectedCargoLockSha256 ||
    sha256(proofBaseline.denort_sha256, 'proof baseline denort') !==
      baselineDenortSha256 ||
    sha256(buildBaseline.denort_sha256, 'build baseline denort') !==
      baselineDenortSha256 ||
    sha256(manifestBaseline.sha256, 'manifest baseline denort') !==
      baselineDenortSha256 ||
    sha256(manifestBuildBaseline.denort_sha256, 'manifest baseline denort') !==
      baselineDenortSha256 ||
    sha256(proofBaseline.bridge_standalone_sha256, 'proof baseline bridge') !==
      baselineBridgeSha256 ||
    sha256(buildBaseline.bridge_standalone_sha256, 'build baseline bridge') !==
      baselineBridgeSha256 ||
    sha256(
        manifestBuildBaseline.bridge_standalone_sha256,
        'manifest baseline bridge',
      ) !==
      baselineBridgeSha256 ||
    sha256(
        proofBaseline.derived_relink_cargo_lock_sha256,
        'proof derived relink Cargo.lock',
      ) !==
      derivedRelinkCargoLockSha256 ||
    sha256(
        buildBaseline.derived_relink_cargo_lock_sha256,
        'build derived relink Cargo.lock',
      ) !==
      derivedRelinkCargoLockSha256 ||
    sha256(manifestLock.sha256, 'manifest derived relink Cargo.lock') !==
      derivedRelinkCargoLockSha256 ||
    sha256(
        manifestBuildBaseline.derived_relink_cargo_lock_sha256,
        'manifest derived relink Cargo.lock',
      ) !==
      derivedRelinkCargoLockSha256
  ) {
    fail(
      'baseline runtime differs from source receipt, proof, or transport manifest',
    )
  }

  return {
    runtimePath: await Deno.realPath(baselinePath),
    baselineDenortSha256,
    bridgePath: await Deno.realPath(bridgePath),
    baselineBridgeSha256,
    sourceSelectedCargoLockSha256,
    derivedRelinkCargoLockSha256,
    sourceReceiptSha256,
    nativeProofSha256,
    buildReceiptSha256,
  }
}
const calverParts = (version: string): number[] => {
  const match = TAG.exec(`v${version}`)
  if (!match) fail(`invalid CalVer: ${version}`)
  const [year, month, day, time] = version.split('.').map(Number)
  const date = new Date(
    Date.UTC(year, month - 1, day, Math.floor(time / 100), time % 100),
  )
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== Math.floor(time / 100) ||
    date.getUTCMinutes() !== time % 100
  ) fail(`invalid CalVer date: ${version}`)
  return [year, month, day, Math.floor(time / 100), time % 100]
}
const newer = (candidate: string, previous: string): boolean => {
  const next = calverParts(candidate)
  const prior = calverParts(previous)
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] !== prior[i]) return next[i] > prior[i]
  }
  return false
}
const must = async (
  runtime: ResolverRuntime,
  command: string,
  args: string[],
): Promise<string> => {
  const result = await runtime.command(command, args)
  if (result.code !== 0) {
    fail(
      `${command} ${args.join(' ')} failed: ${
        (result.stderr || result.stdout).trim()
      }`,
    )
  }
  return result.stdout.trim()
}
const versionAt = async (
  runtime: ResolverRuntime,
  sha: string,
): Promise<string> => {
  const content = await must(runtime, 'git', [
    'show',
    `${sha}:cmn/constants/version.ts`,
  ])
  const match = /^export const VERSION = '([^']+)'/m.exec(content)
  if (!match) throw new Error(`source ${sha} does not export VERSION`)
  calverParts(match[1])
  return match[1]
}
const timestampAt = (runtime: ResolverRuntime, sha: string) =>
  must(runtime, 'git', ['show', '-s', '--format=%cI', sha])

export function publicationFor(
  state: ReleaseState,
): { releaseRequired: boolean; publication: Publication } {
  return state === 'immutable'
    ? { releaseRequired: false, publication: 'verify' }
    : state === 'draft'
    ? { releaseRequired: true, publication: 'recover' }
    : { releaseRequired: true, publication: 'initial' }
}

export async function resolveRelease(
  runtime: ResolverRuntime,
  state: ReleaseState,
): Promise<Resolution> {
  const event = runtime.env('EVENT') ?? ''
  const ref = runtime.env('REF') ?? ''
  const githubSha = runtime.env('GITHUB_SHA') ?? ''
  const before = runtime.env('BEFORE') ?? ''
  const after = runtime.env('AFTER') ?? ''
  const inputVersion = runtime.env('INPUT_VERSION') ?? ''
  if (event === 'push' && ref === 'refs/heads/main') {
    if (!SHA.test(before) || !SHA.test(after) || githubSha !== after) {
      fail('main push requires matching usable before, after, and GITHUB_SHA')
    }
    const previous = await versionAt(runtime, before)
    const version = await versionAt(runtime, after)
    const sourceTimestamp = await timestampAt(runtime, after)
    if (version === previous) {
      return {
        mode: 'ci',
        release_required: false,
        version: '',
        tag: '',
        source_sha: after,
        source_ref: 'refs/heads/main',
        source_timestamp: sourceTimestamp,
        publication: 'none',
      }
    }
    if (!newer(version, previous)) {
      fail(`main version must advance: ${previous} -> ${version}`)
    }
    const action = publicationFor(state)
    return {
      mode: 'main-release',
      release_required: action.releaseRequired,
      version,
      tag: `v${version}`,
      source_sha: after,
      source_ref: 'refs/heads/main',
      source_timestamp: sourceTimestamp,
      publication: action.publication,
    }
  }
  if (event === 'push' && ref.startsWith('refs/tags/v')) {
    const tag = ref.slice('refs/tags/'.length)
    const tagMatch = TAG.exec(tag)
    if (!tagMatch) throw new Error('tag ref is not strict CalVer')
    // Resolve both forms. An annotated tag's ref names its tag object while
    // the Actions push context identifies the commit; a lightweight tag has the
    // same SHA for both. Requiring the peeled commit binds the event to source.
    const refSha = await must(runtime, 'git', ['rev-parse', ref])
    const sourceSha = await must(runtime, 'git', ['rev-parse', `${ref}^{}`])
    if (!SHA.test(refSha) || githubSha !== sourceSha || !SHA.test(sourceSha)) {
      fail('tag event does not match the exact pushed tag commit')
    }
    if (await versionAt(runtime, sourceSha) !== tagMatch[1]) {
      fail('tag version does not match tagged source')
    }
    await must(runtime, 'git', [
      'merge-base',
      '--is-ancestor',
      sourceSha,
      'origin/main',
    ])
    const action = publicationFor(state)
    return {
      mode: 'tag-release',
      release_required: action.releaseRequired,
      version: tagMatch[1],
      tag,
      source_sha: sourceSha,
      source_ref: ref,
      source_timestamp: await timestampAt(runtime, sourceSha),
      publication: action.publication,
    }
  }
  if (event === 'workflow_dispatch') {
    const tag = `v${inputVersion}`
    const tagMatch = TAG.exec(tag)
    if (!tagMatch || ref !== `refs/tags/${tag}`) {
      throw new Error(
        'manual recovery must run from the selected exact release tag',
      )
    }
    const sourceSha = await must(runtime, 'git', ['rev-parse', `${ref}^{}`])
    if (githubSha !== sourceSha || !SHA.test(sourceSha)) {
      fail('manual recovery GITHUB_SHA must equal the selected tag peeled SHA')
    }
    if (await versionAt(runtime, sourceSha) !== inputVersion) {
      fail('manual recovery version does not match tag source')
    }
    await must(runtime, 'git', [
      'merge-base',
      '--is-ancestor',
      sourceSha,
      'origin/main',
    ])
    const action = publicationFor(state)
    return {
      mode: 'tag-recovery',
      release_required: action.releaseRequired,
      version: inputVersion,
      tag,
      source_sha: sourceSha,
      source_ref: ref,
      source_timestamp: await timestampAt(runtime, sourceSha),
      publication: action.publication,
    }
  }
  if (event === 'pull_request') {
    if (!/^refs\/pull\/[1-9]\d*\/merge$/.test(ref) || !SHA.test(githubSha)) {
      fail('pull request requires its checked-out merge ref and SHA')
    }
    const sourceSha = await must(runtime, 'git', ['rev-parse', 'HEAD'])
    if (!SHA.test(sourceSha) || sourceSha !== githubSha) {
      fail('pull request GITHUB_SHA must equal the checked-out merge commit')
    }
    return {
      mode: 'ci',
      release_required: false,
      version: await versionAt(runtime, sourceSha),
      tag: '',
      source_sha: sourceSha,
      source_ref: ref,
      source_timestamp: await timestampAt(runtime, sourceSha),
      publication: 'none',
    }
  }
  return fail(`unsupported release event/ref: ${event} ${ref}`)
}

export type DraftAsset = { name: string; sha256?: string }
/** Drafts may be completed, but a pre-existing payload can never be replaced. */
export function planDraftRecovery(
  state: ReleaseState,
  existing: DraftAsset[],
  staged: Map<string, string>,
) {
  if (state === 'immutable') {
    return { action: 'verify' as const, upload: [] as string[] }
  }
  const allowed = new Set([
    ...staged.keys(),
    'release-manifest.json',
    'SHA256SUMS',
    ...[...staged.keys(), 'release-manifest.json', 'SHA256SUMS'].map((name) =>
      `${name}.intoto.jsonl`
    ),
  ])
  for (const asset of existing) {
    if (!allowed.has(asset.name)) {
      fail(`existing draft contains unexpected asset ${asset.name}`)
    }
    const expected = staged.get(asset.name)
    if (expected && asset.sha256 && expected !== asset.sha256) {
      fail(`existing draft payload differs: ${asset.name}`)
    }
  }
  const names = new Set(existing.map((asset) => asset.name))
  return {
    action: state === 'draft' ? 'recover' as const : 'create' as const,
    upload: [...allowed].filter((name) => !names.has(name)).sort(),
  }
}

export type VerifiedRelease = {
  sourceRef: string
  subjects: string[]
}
type StrictManifest = ReturnType<typeof manifest>

function strictManifest(value: unknown): StrictManifest {
  if (!value || typeof value !== 'object') {
    fail('invalid published release manifest')
  }
  const source = value as {
    version?: unknown
    source?: { commit?: unknown; ref?: unknown }
    workflow?: { run_id?: unknown; run_attempt?: unknown }
    assets?: unknown
  }
  const version = source.version
  const identity = source.source
  const workflow = source.workflow
  const assets = source.assets
  if (
    typeof version !== 'string' || typeof identity?.commit !== 'string' ||
    typeof identity.ref !== 'string' || typeof workflow?.run_id !== 'string' ||
    typeof workflow.run_attempt !== 'number' || !Array.isArray(assets)
  ) fail('invalid published release manifest')
  const normalized = manifest(
    version as string,
    (identity as { commit: string }).commit,
    (identity as { ref: string }).ref,
    (workflow as { run_id: string }).run_id,
    String((workflow as { run_attempt: number }).run_attempt),
    assets as Asset[],
  )
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    fail('published release manifest has unknown fields or invalid inventory')
  }
  return normalized
}

/**
 * Ensure a draft manifest can only be reused from the same original package.
 * A whole-workflow retry has a new run attempt in its manifest, so it must not
 * replace a signed/draft manifest; re-run the failed publisher while its
 * retained package artifact exists instead.
 */
export async function guardDraftManifest(
  existingPath: string,
  stagedPath: string,
): Promise<void> {
  const existing = strictManifest(
    JSON.parse(await Deno.readTextFile(existingPath)),
  )
  const staged = strictManifest(JSON.parse(await Deno.readTextFile(stagedPath)))
  if (
    existing.version !== staged.version || existing.tag !== staged.tag ||
    existing.source.commit !== staged.source.commit ||
    existing.source.ref !== staged.source.ref ||
    JSON.stringify(existing.assets) !== JSON.stringify(staged.assets)
  ) fail('draft manifest source or payload inventory differs')
  if (
    existing.workflow.run_id !== staged.workflow.run_id ||
    existing.workflow.run_attempt !== staged.workflow.run_attempt
  ) {
    fail(
      'draft manifest belongs to another workflow attempt; re-run the failed publish job with its retained original package artifact, or require maintainer review after retention expiry; it will not be overwritten',
    )
  }
}

export async function verifyReleaseDirectory(
  directory: string,
  version: string,
  sourceSha: string,
  allowedSourceRefs: readonly string[],
): Promise<VerifiedRelease> {
  if (!allowedSourceRefs.length) {
    fail('at least one trusted source ref is required')
  }
  const source = strictManifest(
    JSON.parse(await Deno.readTextFile(`${directory}/release-manifest.json`)),
  )
  if (
    source.repository !== 'ValidatorsDAO/slv' || source.version !== version ||
    source.tag !== `v${version}` || source.source.commit !== sourceSha
  ) fail('invalid published release manifest identity')
  if (!allowedSourceRefs.includes(source.source.ref)) {
    fail('published manifest source ref is not trusted for this recovery event')
  }
  const assets = source.assets as Asset[]
  const expectedChecksums: string[] = []
  for (const asset of assets) {
    const info = await Deno.stat(`${directory}/${asset.name}`)
    if (
      !info.isFile || info.size !== asset.size ||
      await hashFile(`${directory}/${asset.name}`) !== asset.sha256
    ) fail(`published payload differs: ${asset.name}`)
    expectedChecksums.push(`${asset.sha256}  ${asset.name}`)
  }
  if (
    (await Deno.readTextFile(`${directory}/SHA256SUMS`)) !==
      `${expectedChecksums.join('\n')}\n`
  ) fail('published SHA256SUMS differs')
  const subjects = [
    ...assets.map((asset) => asset.name),
    'release-manifest.json',
    'SHA256SUMS',
  ]
  for (const subject of subjects) {
    let info: Deno.FileInfo
    try {
      info = await Deno.stat(`${directory}/${subject}.intoto.jsonl`)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        fail(`missing attestation bundle ${subject}`)
      }
      throw error
    }
    if (!info.isFile || info.size <= 0) {
      fail(`missing attestation bundle ${subject}`)
    }
  }
  return { sourceRef: source.source.ref, subjects }
}

const shellRuntime: ResolverRuntime = {
  env: Deno.env.get,
  async command(command, args) {
    const output = await new Deno.Command(command, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    }
  },
}
async function currentReleaseState(
  runtime: ResolverRuntime,
  tag: string,
): Promise<ReleaseState> {
  const repository = runtime.env('GH_REPO')
  if (!repository) fail('GH_REPO must be explicit')
  const result = await runtime.command('gh', [
    'api',
    `repos/${repository}/releases/tags/${tag}`,
  ])
  if (result.code !== 0) {
    if (/404/.test(result.stderr)) return 'absent'
    fail(`unable to inspect existing release ${tag}: ${result.stderr.trim()}`)
  }
  const release = JSON.parse(result.stdout) as {
    draft?: unknown
    immutable?: unknown
  }
  if (release.draft === true) return 'draft'
  if (release.draft === false && release.immutable === true) return 'immutable'
  return fail(`existing release ${tag} is published but not immutable`)
}
if (import.meta.main) {
  const [command, ...args] = Deno.args
  if (command === 'resolve') {
    const provisional = await resolveRelease(shellRuntime, 'absent')
    const resolution = provisional.mode === 'ci'
      ? provisional
      : await resolveRelease(
        shellRuntime,
        await currentReleaseState(shellRuntime, provisional.tag),
      )
    const output = shellRuntime.env('GITHUB_OUTPUT')
    if (!output) throw new Error('GITHUB_OUTPUT is required')
    await Deno.writeTextFile(
      output,
      Object.entries(resolution).map(([key, value]) => `${key}=${value}`).join(
        '\n',
      ) + '\n',
      { append: true },
    )
  } else if (command === 'verify-directory' && args.length >= 4) {
    const verified = await verifyReleaseDirectory(
      args[0],
      args[1],
      args[2],
      args.slice(3),
    )
    console.log(`source_ref=${verified.sourceRef}`)
    for (const subject of verified.subjects) console.log(subject)
  } else if (command === 'guard-draft-manifest' && args.length === 2) {
    await guardDraftManifest(args[0], args[1])
  } else if (command === 'verify-baseline-runtime' && args.length === 5) {
    const verified = await verifyBaselineRuntime(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
    )
    for (
      const [key, value] of Object.entries({
        runtime_path: verified.runtimePath,
        baseline_denort_sha256: verified.baselineDenortSha256,
        bridge_path: verified.bridgePath,
        baseline_bridge_sha256: verified.baselineBridgeSha256,
        source_selected_cargo_lock_sha256:
          verified.sourceSelectedCargoLockSha256,
        derived_relink_cargo_lock_sha256: verified.derivedRelinkCargoLockSha256,
        source_receipt_sha256: verified.sourceReceiptSha256,
        native_proof_sha256: verified.nativeProofSha256,
        build_receipt_sha256: verified.buildReceiptSha256,
      })
    ) console.log(`${key}=${value}`)
  } else {
    fail(
      'usage: workflow.ts resolve | verify-directory DIR VERSION SOURCE_SHA SOURCE_REF [SOURCE_REF...] | guard-draft-manifest EXISTING STAGED | verify-baseline-runtime TARGET SOURCE_SHA SOURCE_RECEIPT NATIVE_PROOF RUNTIME_DIR',
    )
  }
}
