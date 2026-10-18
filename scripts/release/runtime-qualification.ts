/** Immutable runtime evidence is separate from each freshly compiled application. */
import {
  checkFreshRuntimeRevocation,
  checkReviewedRuntimeRevocation,
  type RuntimeRevocationObservation,
  type RuntimeRevocationTransport,
} from './runtime-revocations.ts'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, link as linkFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scanArchiveForUnsafeMembers } from '../../source-rebuild/verify-native.ts'
import { canonicalTargetDescriptorBytes } from '../../source-rebuild/prepare-tools.ts'
import {
  sha256,
  SOURCE_PROOF_TARGETS,
  verifyNativeSourceRebuildProof,
  verifySourceMaterialsReceipt,
  verifySourceProofSet,
} from './source-materials.ts'

export const QUALIFICATION_REPOSITORY = 'ValidatorsDAO/slv'
export const QUALIFICATION_WORKFLOW = '.github/workflows/slv-remote-build.yml'
export const QUALIFICATION_MANIFEST = 'runtime-qualification.json'
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const MAX_BYTES = 2 * 1024 ** 3
const SOURCE_NAMES = [
  'slv-source.tar.gz',
  'deno-source.tar.gz',
  'deno-cargo-vendor.tar.gz',
] as const
export type QualificationTarget = typeof SOURCE_PROOF_TARGETS[number]
export type QualificationState = 'candidate-validation' | 'final-qualified'
export type QualificationAsset = { sha256: string; size: number }
export type QualificationArtifact = {
  id: number
  name: string
  asset: string
  members: Record<string, string>
}
export type QualificationManifest = {
  schema_version: 1
  kind: 'slv-runtime-qualification'
  producer: {
    repository: typeof QUALIFICATION_REPOSITORY
    workflow_path: typeof QUALIFICATION_WORKFLOW
    workflow_source_commit: string
    reviewed_main_equivalent: {
      commit: string
      tree_sha: string
      parents: [string, string]
      pull_request: number
    } | null
    workflow_ref: string
    source_commit: string
    api_head_sha: string
    run_id: number
    run_attempt: number
  }
  compatibility: {
    deno_version: string
    deno_commit: string
    libsui_version: string
    frontend: Record<
      'x86_64-unknown-linux-gnu' | 'aarch64-unknown-linux-gnu',
      QualificationAsset
    >
    runtime_inputs: Record<string, string>
    embedding_recipe_sha256: string
  }
  producer_recipe: Record<string, string>
  assets: Record<string, QualificationAsset>
  artifacts: QualificationArtifact[]
  source: {
    receipt: string
    pins: string
    tool_prereqs: string
    notice: string
    selected_lock: string
    archives: Record<typeof SOURCE_NAMES[number], string>
    /** Exact original slv-source archive members, copied without modification. */
    members: Record<string, string>
  }
  targets: {
    target: QualificationTarget
    runtime: string
    derived_lock: string
    proof: string
    build_receipt: string
    execution_receipt: string
    tool_pins: string
    transport_manifest: string
    abi: {
      format: 'elf' | 'macho'
      arch: 'x86_64' | 'aarch64'
      minimum_os: string
    }
  }[]
  policy: {
    version: 1
    upstream_fallback: false
    retention: 'while-referenced'
    native_evidence: 'original-runtime-only'
  }
}
export type QualificationBinding = {
  identity: string
  tag: string
  state: QualificationState
  target: QualificationTarget
  runtime: QualificationAsset & { path: string }
  derivedLock: QualificationAsset & { path: string }
  selectedLock: QualificationAsset & { path: string }
  proof: QualificationAsset & { path: string }
  buildReceipt: QualificationAsset & { path: string }
  sourceReceipt: QualificationAsset & { path: string }
  abi: QualificationManifest['targets'][number]['abi']
  manifest: QualificationManifest
  revocation: {
    reviewed_checkout_policy: RuntimeRevocationObservation
    current_main_policy: RuntimeRevocationObservation | null
  }
}
function fail(message: string): never {
  throw new Error(`runtime qualification: ${message}`)
}
function object(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has missing or unknown fields`)
  }
  return row
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length === 0
  ) fail(`${label} must be a nonempty map`)
  return value as Record<string, unknown>
}
function string(
  value: unknown,
  pattern: RegExp,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`invalid ${label}`)
  }
}
function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`invalid ${label}`)
  }
}
function safePath(value: string): string {
  if (
    !value || value.includes('\\') || value.includes('\0') ||
    value.split('/').some((x) => !x || x === '.' || x === '..')
  ) fail('unsafe member path')
  return value
}
function asset(value: unknown): asserts value is QualificationAsset {
  const row = object(value, ['sha256', 'size'], 'asset')
  string(row.sha256, SHA, 'asset digest')
  positive(row.size, 'asset size')
  if (row.size >= MAX_BYTES) fail('asset exceeds bound')
}
export function canonicalQualificationBytes(value: unknown): Uint8Array {
  function stable(item: unknown): string {
    if (
      item === null || typeof item === 'string' || typeof item === 'boolean'
    ) return JSON.stringify(item)
    if (typeof item === 'number' && Number.isSafeInteger(item)) {
      return String(item)
    }
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`
    if (item && typeof item === 'object') {
      return `{${
        Object.keys(item).sort().map((key) =>
          `${JSON.stringify(key)}:${
            stable((item as Record<string, unknown>)[key])
          }`
        ).join(',')
      }}`
    }
    return fail('noncanonical JSON value')
  }
  return new TextEncoder().encode(stable(value) + '\n')
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function same(a: unknown, b: unknown): boolean {
  return digest(canonicalQualificationBytes(a)) ===
    digest(canonicalQualificationBytes(b))
}
export function qualificationIdentity(value: QualificationManifest): string {
  assertQualificationManifest(value)
  return digest(canonicalQualificationBytes(value))
}
export function qualificationTag(value: QualificationManifest): string {
  return `runtime-deno-v${value.compatibility.deno_version}-${
    qualificationIdentity(value)
  }`
}
export function assertQualificationManifest(
  value: unknown,
): asserts value is QualificationManifest {
  const m = object(value, [
    'schema_version',
    'kind',
    'producer',
    'compatibility',
    'producer_recipe',
    'assets',
    'artifacts',
    'source',
    'targets',
    'policy',
  ], 'manifest')
  if (m.schema_version !== 1 || m.kind !== 'slv-runtime-qualification') {
    fail('unsupported manifest')
  }
  const p = object(m.producer, [
    'repository',
    'workflow_path',
    'workflow_source_commit',
    'reviewed_main_equivalent',
    'workflow_ref',
    'source_commit',
    'api_head_sha',
    'run_id',
    'run_attempt',
  ], 'producer')
  if (
    p.repository !== QUALIFICATION_REPOSITORY ||
    p.workflow_path !== QUALIFICATION_WORKFLOW
  ) fail('untrusted original producer')
  for (
    const key of ['workflow_source_commit', 'source_commit', 'api_head_sha']
  ) {
    string(p[key], COMMIT, key)
  }
  string(
    p.workflow_ref,
    /^refs\/(heads\/[A-Za-z0-9._/-]+|pull\/[1-9][0-9]*\/merge)$/,
    'workflow ref',
  )
  if (p.workflow_source_commit !== p.source_commit) {
    fail('workflow recipe is not from original source')
  }
  if (p.reviewed_main_equivalent === null) {
    if (
      p.workflow_ref !== 'refs/heads/main' || p.api_head_sha !== p.source_commit
    ) fail('main-origin qualification requires exact source/ref identity')
  } else {
    const equivalent = object(p.reviewed_main_equivalent, [
      'commit',
      'tree_sha',
      'parents',
      'pull_request',
    ], 'reviewed main equivalent')
    string(equivalent.commit, COMMIT, 'reviewed main commit')
    string(equivalent.tree_sha, COMMIT, 'reviewed Git tree')
    positive(equivalent.pull_request, 'original pull request')
    if (
      !Array.isArray(equivalent.parents) || equivalent.parents.length !== 2 ||
      equivalent.parents.some((x) =>
        typeof x !== 'string' || !COMMIT.test(x)
      ) || equivalent.parents[1] !== p.api_head_sha ||
      p.workflow_ref !== `refs/pull/${equivalent.pull_request}/merge`
    ) fail('original merge lineage is incomplete')
  }
  positive(p.run_id, 'run ID')
  positive(p.run_attempt, 'run attempt')
  const c = object(m.compatibility, [
    'deno_version',
    'deno_commit',
    'libsui_version',
    'frontend',
    'runtime_inputs',
    'embedding_recipe_sha256',
  ], 'compatibility')
  string(c.deno_version, /^\d+\.\d+\.\d+$/, 'Deno version')
  string(c.deno_commit, COMMIT, 'Deno commit')
  string(c.libsui_version, /^\d+\.\d+\.\d+$/, 'libsui version')
  string(c.embedding_recipe_sha256, SHA, 'embedding recipe')
  const front = object(c.frontend, [
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
  ], 'frontends')
  Object.values(front).forEach(asset)
  for (
    const map of [
      record(c.runtime_inputs, 'runtime inputs'),
      record(m.producer_recipe, 'producer recipe'),
    ]
  ) {
    for (const [path, hash] of Object.entries(map)) {
      safePath(path)
      string(hash, SHA, 'input digest')
    }
  }
  for (
    const path of [
      'source-materials/pins.json',
      'source-rebuild/tool-prereqs.json',
      'scripts/release/runtime-notices/evidence/deno/selected-Cargo.lock',
    ]
  ) {
    if (!(path in record(c.runtime_inputs, 'runtime inputs'))) {
      fail(`missing runtime input ${path}`)
    }
  }
  const assets = record(m.assets, 'assets')
  for (const [name, entry] of Object.entries(assets)) {
    string(name, NAME, 'asset name')
    asset(entry)
  }
  const ref = (name: unknown): void => {
    string(name, NAME, 'asset reference')
    if (!(name in assets)) fail('unknown asset reference')
  }
  const s = object(m.source, [
    'receipt',
    'pins',
    'tool_prereqs',
    'notice',
    'selected_lock',
    'archives',
    'members',
  ], 'source')
  for (
    const key of ['receipt', 'pins', 'tool_prereqs', 'notice', 'selected_lock']
  ) ref(s[key])
  Object.values(object(s.archives, [...SOURCE_NAMES], 'source archives'))
    .forEach(ref)
  const members = record(s.members, 'source members')
  for (const [path, name] of Object.entries(members)) {
    safePath(path)
    if (!path.startsWith('slv-source/')) fail('source member root')
    ref(name)
  }
  if (
    !Array.isArray(m.artifacts) || m.artifacts.length < 9 ||
    m.artifacts.length > 16
  ) fail('incomplete artifact evidence')
  const ids = new Set<number>(), memberAssets = new Set<string>()
  for (const entry of m.artifacts) {
    const a = object(entry, ['id', 'name', 'asset', 'members'], 'artifact')
    positive(a.id, 'artifact ID')
    string(a.name, NAME, 'artifact name')
    ref(a.asset)
    if (ids.has(a.id)) fail('duplicate artifact ID')
    ids.add(a.id)
    for (
      const [path, name] of Object.entries(
        record(a.members, 'artifact members'),
      )
    ) {
      safePath(path)
      ref(name)
      if (memberAssets.has(name as string)) fail('duplicate artifact output')
      memberAssets.add(name as string)
    }
  }
  if (!Array.isArray(m.targets) || m.targets.length !== 4) {
    fail('qualification requires four targets')
  }
  const targets = new Set<string>()
  for (const entry of m.targets) {
    const t = object(entry, [
      'target',
      'runtime',
      'derived_lock',
      'proof',
      'build_receipt',
      'execution_receipt',
      'tool_pins',
      'transport_manifest',
      'abi',
    ], 'target')
    if (
      !SOURCE_PROOF_TARGETS.includes(t.target as QualificationTarget) ||
      targets.has(String(t.target))
    ) fail('wrong or duplicate target')
    targets.add(String(t.target))
    for (
      const key of [
        'runtime',
        'derived_lock',
        'proof',
        'build_receipt',
        'execution_receipt',
        'tool_pins',
        'transport_manifest',
      ]
    ) ref(t[key])
    const abi = object(t.abi, ['format', 'arch', 'minimum_os'], 'ABI')
    if (
      abi.format !== (String(t.target).includes('darwin') ? 'macho' : 'elf') ||
      abi.arch !==
        (String(t.target).startsWith('x86_64') ? 'x86_64' : 'aarch64')
    ) fail('target ABI mismatch')
    string(abi.minimum_os, /^[A-Za-z0-9._-]{1,64}$/, 'minimum OS')
  }
  const policy = object(m.policy, [
    'version',
    'upstream_fallback',
    'retention',
    'native_evidence',
  ], 'policy')
  if (
    policy.version !== 1 || policy.upstream_fallback !== false ||
    policy.retention !== 'while-referenced' ||
    policy.native_evidence !== 'original-runtime-only'
  ) fail('unsupported qualification policy')
}
async function regular(path: string): Promise<Deno.FileInfo> {
  const absolute = resolve(path)
  let prefix = '/'
  for (const part of absolute.split('/').filter(Boolean)) {
    prefix = join(prefix, part)
    const info = await Deno.lstat(prefix)
    if (info.isSymlink) fail('symlink in payload path')
  }
  const info = await Deno.lstat(absolute)
  if (!info.isFile) fail('payload is not a regular file')
  return info
}
async function verifyFile(
  path: string,
  expected: QualificationAsset,
): Promise<void> {
  if (
    (await regular(path)).size !== expected.size ||
    await sha256(path) !== expected.sha256
  ) fail(`payload digest/size mismatch: ${path.split('/').pop()}`)
}
export async function readQualificationManifest(
  path: string,
  expectedIdentity?: string,
): Promise<QualificationManifest> {
  if ((await regular(path)).size > 1024 * 1024) {
    fail('manifest exceeds size bound')
  }
  const bytes = await Deno.readFile(path)
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  )
  assertQualificationManifest(value)
  if (digest(bytes) !== qualificationIdentity(value)) {
    fail('manifest bytes are not canonical')
  }
  if (
    expectedIdentity !== undefined &&
    (expectedIdentity !== qualificationIdentity(value) ||
      !SHA.test(expectedIdentity))
  ) fail('manifest differs from pinned identity')
  return value
}

/** No extractall: validate the entire ZIP namespace, then copy selected regular members. */
export async function extractQualificationZip(
  path: string,
  members: Record<string, string>,
  directory: string,
): Promise<void> {
  for (const [member, name] of Object.entries(members)) {
    safePath(member)
    string(name, NAME, 'asset name')
  }
  const script = String.raw`
import json,sys,zipfile,stat,os,shutil
archive, destination = sys.argv[1:]
wanted=json.load(sys.stdin)
with zipfile.ZipFile(archive) as z:
 seen=set(); total=0
 for i in z.infolist():
  n=i.filename[:-1] if i.is_dir() else i.filename
  if not n or '\\' in n or '\x00' in n or any(x in ('','.','..') for x in n.split('/')) or n in seen: raise ValueError('unsafe ZIP member')
  seen.add(n); mode=i.external_attr>>16
  if stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR) or i.flag_bits&1: raise ValueError('unsupported ZIP member')
  total+=i.file_size
  if i.file_size>=2147483648 or total>8589934592: raise ValueError('ZIP expansion bound')
 for n in seen:
  parts=n.split('/')
  for k in range(1,len(parts)):
   p='/'.join(parts[:k])
   if p in seen and not z.getinfo(p+'/').is_dir(): raise ValueError('ZIP file ancestor')
 for member,name in wanted.items():
  i=z.getinfo(member)
  if i.is_dir(): raise ValueError('directory selected as asset')
  with z.open(i) as src, open(os.path.join(destination,name),'xb') as out: shutil.copyfileobj(src,out,1024*1024)
`
  await command(
    'python3',
    ['-c', script, path, directory],
    JSON.stringify(members),
  )
}
async function command(
  program: string,
  args: string[],
  input?: string,
): Promise<Uint8Array> {
  const child = new Deno.Command(program, {
    args,
    stdin: input === undefined ? 'null' : 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch { /* exited */ }
  }, 180_000)
  try {
    if (input !== undefined) {
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode(input))
      await writer.close()
    }
    const result = await child.output()
    if (!result.success) fail(`${program} verification failed (${result.code})`)
    return result.stdout
  } finally {
    clearTimeout(timer)
  }
}
async function json(path: string): Promise<Record<string, any>> { // Evidence structures are validated by the original proof parser below.
  await regular(path)
  return JSON.parse(await Deno.readTextFile(path))
}
/** Stage verified input without requiring scratch storage on its filesystem.
 * The downstream proof verifier rechecks the staged source/receipt hashes.
 */
export async function stageQualificationEvidenceFile(
  source: string,
  destination: string,
): Promise<'hardlink' | 'copy'> {
  await regular(source)
  try {
    await linkFile(source, destination)
    return 'hardlink'
  } catch (error) {
    if (
      !error || typeof error !== 'object' || !('code' in error) ||
      error.code !== 'EXDEV'
    ) throw error
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
    return 'copy'
  }
}

async function verifyOriginalEvidence(
  m: QualificationManifest,
  directory: string,
): Promise<void> {
  const path = (name: string) => join(directory, name)
  const source = verifySourceMaterialsReceipt(
    await json(path(m.source.receipt)),
    {
      sourceCommit: m.producer.source_commit,
      canonicalNoticeSha256: m.assets[m.source.notice].sha256,
    },
  )
  if (
    source.pins.sha256 !== m.assets[m.source.pins].sha256 ||
    source.runtime_security.selected.cargo_lock.sha256 !==
      m.assets[m.source.selected_lock].sha256 ||
    source.pins.deno.commit !== m.compatibility.deno_commit ||
    source.pins.deno.version !== m.compatibility.deno_version
  ) fail('source/runtime input binding differs')
  for (const row of source.assets) {
    if (
      !same(
        { sha256: row.sha256, size: row.size },
        m.assets[m.source.archives[row.name]],
      )
    ) fail('source archive differs from original receipt')
  }
  const selectedLock = await Deno.readTextFile(path(m.source.selected_lock))
  const libsui = [
    ...selectedLock.matchAll(
      /\[\[package\]\]\s+name = "libsui"\s+version = "([^"]+)"/g,
    ),
  ]
  if (libsui.length !== 1 || libsui[0][1] !== m.compatibility.libsui_version) {
    fail('libsui compatibility differs from selected lock')
  }
  const pins = await json(path(m.source.tool_prereqs))
  for (const row of m.targets) {
    const proof = await json(path(row.proof))
    verifyNativeSourceRebuildProof(proof)
    const runtimeAbi = proof.checks.baseline_build.runtime_abi
    const minimum = row.abi.format === 'macho'
      ? runtimeAbi.minimum_os
      : `glibc-${
        [...runtimeAbi.glibc_versions].sort((a: string, b: string) => {
          const x = a.split('.').map(Number), y = b.split('.').map(Number)
          return x[0] - y[0] || x[1] - y[1] || (x[2] ?? 0) - (y[2] ?? 0)
        }).at(-1)
      }`
    if (row.abi.minimum_os !== minimum) {
      fail('ABI differs from original runtime proof')
    }

    const build = await json(path(row.build_receipt)),
      execution = await json(path(row.execution_receipt)),
      transport = await json(path(row.transport_manifest))
    if (build.split_build) {
      const producers = [
        build.split_build.join_producer,
        build.split_build.baseline?.receipt?.producer,
        build.split_build.modified?.receipt?.producer,
      ]
      for (const p of producers) {
        if (
          p?.kind !== 'slv-native-producer-context' ||
          p.repository !== m.producer.repository ||
          p.workflow !==
            `${m.producer.repository}/${m.producer.workflow_path}@${m.producer.workflow_ref}` ||
          p.run_id !== String(m.producer.run_id) ||
          p.run_attempt !== String(m.producer.run_attempt)
        ) fail('original build producer context differs')
      }
    }
    if (
      proof.target !== row.target ||
      proof.source_commit !== m.producer.source_commit ||
      proof.source_receipt_sha256 !== m.assets[m.source.receipt].sha256 ||
      proof.source_selected_cargo_lock_sha256 !==
        m.assets[m.source.selected_lock].sha256 ||
      proof.source_pin_sha256 !== m.assets[m.source.pins].sha256 ||
      proof.tool_pin_sha256 !== m.assets[row.tool_pins].sha256 ||
      proof.build_receipt_sha256 !== m.assets[row.build_receipt].sha256 ||
      proof.execution_receipt_sha256 !== m.assets[row.execution_receipt].sha256
    ) fail('original proof identity differs')
    if (
      proof.artifacts.baseline.denort_sha256 !== m.assets[row.runtime].sha256 ||
      proof.artifacts.modified.denort_sha256 === m.assets[row.runtime].sha256 ||
      proof.artifacts.baseline.derived_relink_cargo_lock_sha256 !==
        m.assets[row.derived_lock].sha256
    ) fail('baseline runtime/lock mismatch or sentinel substitution')
    if (
      transport.kind !== 'slv-source-native-transport' ||
      transport.target !== row.target ||
      transport.source_receipt_sha256 !== proof.source_receipt_sha256 ||
      !same(transport.artifacts, proof.artifacts) ||
      transport.entries['baseline-denort'].sha256 !==
        m.assets[row.runtime].sha256 ||
      transport.entries['baseline-denort'].size !== m.assets[row.runtime].size
    ) fail('runtime transport differs')
    if (
      build.source_commit !== proof.source_commit ||
      build.target !== row.target || !same(build.artifacts, proof.artifacts) ||
      execution.build_receipt_sha256 !== proof.build_receipt_sha256 ||
      !same(execution.artifacts, proof.artifacts)
    ) fail('phase receipt differs')
    if (
      digest(canonicalTargetDescriptorBytes(pins, row.target)) !==
        m.assets[row.tool_pins].sha256
    ) fail('tool descriptor differs')
  }
  // The existing verifier checks full build/execution checks, toolchain descriptors,
  // source inventory identities and canonical original notices together.
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'slv-qualification-' }),
  )
  try {
    await Deno.mkdir(join(temporary, 'source'))
    await Deno.mkdir(join(temporary, 'proof'))
    await Deno.mkdir(join(temporary, 'tools'))
    for (const name of SOURCE_NAMES) {
      await stageQualificationEvidenceFile(
        path(m.source.archives[name]),
        join(temporary, 'source', name),
      )
    }
    for (const row of m.targets) {
      const folder = join(temporary, 'proof', row.target)
      await Deno.mkdir(folder)
      for (
        const [key, name] of [['proof', 'native-proof.json'], [
          'build_receipt',
          'build-receipt.json',
        ], ['execution_receipt', 'execution-receipt.json']] as const
      ) await stageQualificationEvidenceFile(path(row[key]), join(folder, name))
      await stageQualificationEvidenceFile(
        path(row.tool_pins),
        join(temporary, 'tools', `${row.target}.json`),
      )
    }
    await verifySourceProofSet({
      sourceReceiptPath: path(m.source.receipt),
      sourceDirectory: join(temporary, 'source'),
      proofDirectory: join(temporary, 'proof'),
      sourceCommit: m.producer.source_commit,
      sourcePinsPath: path(m.source.pins),
      toolPinsDirectory: join(temporary, 'tools'),
      canonicalNoticePath: path(m.source.notice),
      reviewedToolPinsPath: path(m.source.tool_prereqs),
    })
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
}
/** Compare selected payloads to their original ZIP/tar bytes without extraction. */
export async function verifyQualificationArchiveBindings(
  m: QualificationManifest,
  directory: string,
): Promise<void> {
  const spec = {
    zips: m.artifacts.map((row) => ({
      path: join(directory, row.asset),
      members: Object.fromEntries(
        Object.entries(row.members).map((
          [member, name],
        ) => [member, m.assets[name]]),
      ),
    })),
    tar: {
      path: join(directory, m.source.archives['slv-source.tar.gz']),
      members: Object.fromEntries(
        Object.entries(m.source.members).map((
          [member, name],
        ) => [member, m.assets[name]]),
      ),
    },
  }
  const script = String.raw`
import hashlib,json,sys,tarfile,zipfile,stat
spec=json.load(sys.stdin)
def check(stream,expected,size):
 if size!=expected['size']: raise ValueError('original member size differs')
 h=hashlib.sha256()
 for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
 if h.hexdigest()!=expected['sha256']: raise ValueError('original member digest differs')
for row in spec['zips']:
 with zipfile.ZipFile(row['path']) as z:
  seen={};total=0
  for i in z.infolist():
   n=i.filename[:-1] if i.is_dir() else i.filename
   if not n or chr(92) in n or chr(0) in n or any(p in ('','.','..') for p in n.split('/')) or n in seen: raise ValueError('unsafe ZIP member')
   mode=i.external_attr>>16
   if stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR) or i.flag_bits&1: raise ValueError('unsupported ZIP member')
   seen[n]=i;total+=i.file_size
   if i.file_size>=2147483648 or total>8589934592: raise ValueError('ZIP bound')
  for n in seen:
   parts=n.split('/')
   for k in range(1,len(parts)):
    p='/'.join(parts[:k])
    if p in seen and not seen[p].is_dir(): raise ValueError('ZIP file ancestor')
  for member,expected in row['members'].items():
   i=z.getinfo(member)
   if i.is_dir(): raise ValueError('nonregular selected ZIP member')
   with z.open(i) as src:check(src,expected,i.file_size)
with tarfile.open(spec['tar']['path'],'r:gz') as t:
 seen=set()
 for i in t.getmembers():
  n=i.name[:-1] if i.name.endswith('/') else i.name
  if not n or chr(92) in n or chr(0) in n or any(p in ('','.','..') for p in n.split('/')) or n in seen: raise ValueError('unsafe tar member')
  seen.add(n)
  if not (i.isfile() or i.isdir() or i.issym()): raise ValueError('unsupported tar member')
 for member,expected in spec['tar']['members'].items():
  i=t.getmember(member)
  if not i.isfile(): raise ValueError('nonregular selected source member')
  with t.extractfile(i) as src:check(src,expected,i.size)
`
  await command('python3', ['-c', script], JSON.stringify(spec))
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'slv-qualification-archive-scan-' }),
  )
  try {
    for (const name of SOURCE_NAMES) {
      await scanArchiveForUnsafeMembers(
        resolve(directory, m.source.archives[name]),
        name.slice(0, -'.tar.gz'.length),
        temporary,
        join(temporary, `${name}.scan.log`),
      )
    }
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
}

export async function verifyQualificationDirectory(
  m: QualificationManifest,
  directory: string,
  repositoryRoot: string,
): Promise<RuntimeRevocationObservation> {
  assertQualificationManifest(m)
  const reviewedPolicy = await checkReviewedRuntimeRevocation(
    qualificationIdentity(m),
    repositoryRoot,
  )
  for (const [name, expected] of Object.entries(m.assets)) {
    await verifyFile(join(directory, name), expected)
  }
  for (
    const [path, expected] of Object.entries(m.compatibility.runtime_inputs)
  ) {
    if (await sha256(join(repositoryRoot, path)) !== expected) {
      fail(
        `runtime inputs changed: ${path}`,
      )
    }
  }
  if (
    m.compatibility.runtime_inputs['source-materials/pins.json'] !==
      m.assets[m.source.pins].sha256 ||
    m.compatibility.runtime_inputs['source-rebuild/tool-prereqs.json'] !==
      m.assets[m.source.tool_prereqs].sha256 ||
    m.compatibility
        .runtime_inputs[
          'scripts/release/runtime-notices/evidence/deno/selected-Cargo.lock'
        ] !== m.assets[m.source.selected_lock].sha256
  ) fail('runtime input manifest differs from original sources')
  for (
    const [inputPath, expected] of Object.entries(
      m.compatibility.runtime_inputs,
    )
  ) {
    const name = m.source.members[`slv-source/${inputPath}`]
    if (!name || m.assets[name].sha256 !== expected) {
      fail('runtime input is not identical to original qualified source')
    }
  }
  if (!m.producer_recipe[m.producer.workflow_path]) {
    fail('original workflow recipe is missing')
  }
  for (const [recipePath, expected] of Object.entries(m.producer_recipe)) {
    const name = m.source.members[`slv-source/${recipePath}`]
    if (!name || m.assets[name].sha256 !== expected) {
      fail('producer recipe does not bind original source archive')
    }
  }
  for (
    const key of ['pins', 'tool_prereqs', 'notice', 'selected_lock'] as const
  ) {
    if (!Object.values(m.source.members).includes(m.source[key])) {
      fail('source input is not preserved from original source archive')
    }
  }
  await verifyQualificationArchiveBindings(m, directory)
  await verifyOriginalEvidence(m, directory)
  return reviewedPolicy
}

export type QualificationRelease = {
  id: number
  tag_name: string
  draft: boolean
  prerelease: boolean
  immutable: boolean
  target_commitish: string
  assets: {
    id: number
    name: string
    size: number
    digest: string
    browser_download_url: string
  }[]
}
/** Explicit adapter seam: only the production adapter performs GitHub I/O. */
export interface QualificationGitHub {
  release(tag: string): Promise<QualificationRelease | null>
  download(url: string, destination: string): Promise<void>
  verifyAttestation(
    subject: string,
    bundle: string,
    sourceCommit: string,
  ): Promise<void>
  verifyTagProtection(
    tag: string,
  ): Promise<{ bypass_visibility: 'visible-empty' | 'not-visible' }>
  verifyOriginalLineage(
    producer: QualificationManifest['producer'],
  ): Promise<void>
  verifyMainAncestor(commit: string, descendant?: string): Promise<void>
  tagCommit(tag: string): Promise<string | null>
  artifact(id: number): Promise<Record<string, any>>
  run(id: number, attempt: number): Promise<Record<string, any>>
  downloadArtifact(id: number, destination: string): Promise<void>
  downloadReleaseAsset(id: number, destination: string): Promise<void>
}
export function githubQualificationAdapter(options: {
  /** Test seam for public HTTP; does not replace provenance verification. */
  fetch?: typeof globalThis.fetch
  /** null explicitly selects the unauthenticated worker/public-reader route. */
  token?: string | null
} = {}): QualificationGitHub {
  const fetchPublic = options.fetch ?? globalThis.fetch

  const api = async (path: string): Promise<any> => {
    const token = options.token === undefined
      ? Deno.env.get('GH_TOKEN')
      : options.token
    const response = await fetchPublic(
      `https://api.github.com/repos/${QUALIFICATION_REPOSITORY}/${path}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      },
    )
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      fail(`GitHub metadata request failed (${response.status})`)
    }
    const limit = 8 * 1024 * 1024
    const length = response.headers.get('content-length')
    if (
      length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)
    ) {
      await response.body?.cancel()
      fail('GitHub metadata exceeds size bound')
    }
    if (!response.body) fail('empty GitHub metadata response')
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > limit) fail('GitHub metadata exceeds size bound')
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return fail('invalid GitHub metadata JSON')
    }
  }
  return {
    async release(tag) {
      const published = await api(`releases/tags/${encodeURIComponent(tag)}`)
      if (published) return published
      // Draft tags may not yet have a Git ref. Enumerate visible releases to
      // avoid treating an interrupted draft upload as a new publication.
      for (let page = 1; page <= 20; page++) {
        const rows = await api(`releases?per_page=100&page=${page}`)
        if (!Array.isArray(rows)) fail('release inventory unavailable')
        const found = rows.find((row: QualificationRelease) =>
          row.tag_name === tag
        )
        if (found) return found
        if (rows.length < 100) return null
      }
      return fail('release inventory exceeds bounded lookup')
    },
    async download(url, destination) {
      const parsed = new URL(url)
      if (
        parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' ||
        !parsed.pathname.startsWith(
          `/${QUALIFICATION_REPOSITORY}/releases/download/`,
        )
      ) fail('unexpected public asset URL')
      const response = await fetchPublic(url, {
        signal: AbortSignal.timeout(180_000),
      })
      if (!response.ok || !response.body) fail('public asset download failed')
      const file = await Deno.open(destination, {
        createNew: true,
        write: true,
      })
      let count = 0
      try {
        for await (const chunk of response.body) {
          count += chunk.length
          if (count >= MAX_BYTES) fail('download exceeds bound')
          let offset = 0
          while (offset < chunk.length) {
            offset += await file.write(chunk.subarray(offset))
          }
        }
      } finally {
        file.close()
      }
    },
    async verifyAttestation(subject, bundle, sourceCommit) {
      const verified = await command('gh', [
        'attestation',
        'verify',
        subject,
        '--bundle',
        bundle,
        '--repo',
        QUALIFICATION_REPOSITORY,
        '--signer-workflow',
        `${QUALIFICATION_REPOSITORY}/${QUALIFICATION_WORKFLOW}`,
        '--source-ref',
        'refs/heads/main',
        '--source-digest',
        sourceCommit,
        '--signer-digest',
        sourceCommit,
        '--deny-self-hosted-runners',
        '--format',
        'json',
      ])
      verifyQualificationAttestationResult(
        JSON.parse(new TextDecoder().decode(verified)),
        await sha256(subject),
      )
    },
    async verifyTagProtection(tag) {
      const rulesets = await api(
        'rulesets?targets=tag&includes_parents=true&per_page=100',
      )
      if (!Array.isArray(rulesets) || rulesets.length === 100) {
        fail('tag ruleset inventory is incomplete')
      }
      let covered = false
      let bypass_visibility: 'visible-empty' | 'not-visible' = 'not-visible'
      for (const summary of rulesets) {
        if (summary.target !== 'tag' || summary.enforcement !== 'active') {
          continue
        }
        const row = await api(`rulesets/${summary.id}`)
        const conditions = row.conditions?.ref_name
        if (
          !conditions || !Array.isArray(conditions.include) ||
          !Array.isArray(conditions.exclude) || conditions.exclude.length
        ) continue
        const exactPatterns = [
          `refs/tags/${tag}`,
          'refs/tags/runtime-deno-v*',
          `refs/tags/runtime-deno-v${tag.split('-')[2].slice(1)}-*`,
        ]
        if (
          !conditions.include.some((pattern: string) =>
            exactPatterns.includes(pattern)
          )
        ) continue
        if (
          !['update', 'deletion'].every((type) =>
            row.rules?.some((rule: any) => rule.type === type)
          )
        ) continue
        if (
          Array.isArray(row.bypass_actors)
            ? row.bypass_actors.length > 0
            : false
        ) fail('tag bypass policy is not verified')
        if (Array.isArray(row.bypass_actors)) {
          bypass_visibility = 'visible-empty'
        }
        covered = true
      }
      if (!covered) {
        fail('qualification tag lacks dedicated update/delete protection')
      }
      return { bypass_visibility }
    },
    async verifyOriginalLineage(p) {
      if (p.reviewed_main_equivalent === null) {
        if (
          p.workflow_ref !== 'refs/heads/main' ||
          p.api_head_sha !== p.source_commit ||
          p.workflow_source_commit !== p.source_commit
        ) fail('main-origin source binding differs')
        const ancestry = await api(`compare/${p.source_commit}...main`)
        if (
          !['ahead', 'identical'].includes(ancestry?.status) ||
          ancestry.merge_base_commit?.sha !== p.source_commit
        ) fail('qualification source is not on reviewed main')
        return
      }
      const [original, equivalent, pr] = await Promise.all([
        api(`git/commits/${p.source_commit}`),
        api(`git/commits/${p.reviewed_main_equivalent.commit}`),
        api(`pulls/${p.reviewed_main_equivalent.pull_request}`),
      ])
      const expected = p.reviewed_main_equivalent
      for (const row of [original, equivalent]) {
        if (
          !row || row.tree?.sha !== expected.tree_sha ||
          !same(row.parents?.map((x: any) => x.sha), expected.parents)
        ) fail('historical source tree or parent lineage differs')
      }
      if (
        pr?.merged !== true || pr.head?.sha !== p.api_head_sha ||
        pr.merge_commit_sha !== expected.commit || pr.base?.ref !== 'main' ||
        pr.base?.repo?.full_name !== p.repository
      ) fail('historical reviewed pull request differs')
      const ancestry = await api(`compare/${expected.commit}...main`)
      if (
        !['ahead', 'identical'].includes(ancestry?.status) ||
        ancestry.merge_base_commit?.sha !== expected.commit
      ) fail('reviewed equivalent is not on main')
    },
    async tagCommit(tag) {
      const reference = await api(`git/ref/tags/${encodeURIComponent(tag)}`)
      if (reference === null) return null
      let item = reference.object
      const seen = new Set<string>()
      while (item?.type === 'tag') {
        string(item.sha, COMMIT, 'tag object')
        if (seen.has(item.sha) || seen.size >= 8) fail('tag peel cycle')
        seen.add(item.sha)
        const tagObject = await api(`git/tags/${item.sha}`)
        if (!tagObject) fail('qualification annotated tag object is missing')
        item = tagObject.object
      }
      if (item?.type !== 'commit') {
        fail('qualification tag does not identify a commit')
      }
      string(item.sha, COMMIT, 'tag commit')
      return item.sha
    },
    async verifyMainAncestor(commit, descendant) {
      string(commit, COMMIT, 'promotion source')
      if (descendant !== undefined) {
        string(descendant, COMMIT, 'promotion executor source')
      }
      const comparison = await api(
        `compare/${commit}...${descendant ?? 'main'}`,
      )
      if (
        !['ahead', 'identical'].includes(comparison.status) ||
        comparison.merge_base_commit?.sha !== commit
      ) fail('promotion source is not on main')
    },
    async downloadReleaseAsset(id, destination) {
      positive(id, 'release asset ID')
      const output = await Deno.open(destination, {
        createNew: true,
        write: true,
      })
      const child = new Deno.Command('gh', {
        args: [
          'api',
          '-H',
          'Accept: application/octet-stream',
          `repos/${QUALIFICATION_REPOSITORY}/releases/assets/${id}`,
        ],
        stdout: 'piped',
        stderr: 'null',
      }).spawn()
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch { /* exited */ }
      }, 180_000)
      try {
        await child.stdout.pipeTo(output.writable)
        if (!(await child.status).success) fail('draft asset download failed')
      } finally {
        clearTimeout(timer)
        try {
          output.close()
        } catch { /* pipe closed */ }
      }
    },
    async downloadArtifact(id, destination) {
      positive(id, 'artifact ID')
      const output = await Deno.open(destination, {
        createNew: true,
        write: true,
      })
      const child = new Deno.Command('gh', {
        args: [
          'api',
          `repos/${QUALIFICATION_REPOSITORY}/actions/artifacts/${id}/zip`,
        ],
        stdout: 'piped',
        stderr: 'null',
      }).spawn()
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch { /* exited */ }
      }, 180_000)
      try {
        await child.stdout.pipeTo(output.writable)
        if (!(await child.status).success) fail('artifact download failed')
      } finally {
        clearTimeout(timer)
        try {
          output.close()
        } catch { /* pipe closed */ }
      }
    },
    artifact: (id) => api(`actions/artifacts/${id}`),
    run: (id, attempt) => api(`actions/runs/${id}/attempts/${attempt}`),
  }
}
export async function verifyCandidateProvenance(
  m: QualificationManifest,
  github: QualificationGitHub,
): Promise<void> {
  assertQualificationManifest(m)
  await github.verifyOriginalLineage(m.producer)
  const p = m.producer, run = await github.run(p.run_id, p.run_attempt)
  if (
    run.id !== p.run_id || run.run_attempt !== p.run_attempt ||
    run.status !== 'completed' || run.conclusion !== 'success' ||
    run.head_sha !== p.api_head_sha || run.path !== p.workflow_path ||
    run.repository?.full_name !== p.repository ||
    run.head_repository?.full_name !== p.repository
  ) fail('original run provenance differs')
  for (const row of m.artifacts) {
    const api = await github.artifact(row.id), expected = m.assets[row.asset]
    if (
      api.id !== row.id || api.name !== row.name || api.expired !== false ||
      api.size_in_bytes !== expected.size ||
      api.digest !== `sha256:${expected.sha256}` ||
      api.workflow_run?.id !== p.run_id ||
      api.workflow_run?.head_sha !== p.api_head_sha ||
      api.workflow_run?.repository_id !== run.repository.id ||
      api.workflow_run?.head_repository_id !== run.repository.id
    ) fail('original artifact provenance differs or expired')
  }
}
function assertPublishedRelease(
  m: QualificationManifest,
  release: QualificationRelease,
): void {
  const tag = qualificationTag(m)
  if (
    !release || release.tag_name !== tag || release.draft !== false ||
    release.prerelease !== true || release.immutable !== true ||
    !COMMIT.test(release.target_commitish)
  ) fail('qualification release is not an immutable prerelease')
  const expected = {
    ...m.assets,
    [QUALIFICATION_MANIFEST]: {
      sha256: qualificationIdentity(m),
      size: canonicalQualificationBytes(m).length,
    },
  }
  const bundle = release.assets.find((x) =>
    x.name === `${QUALIFICATION_MANIFEST}.intoto.jsonl`
  )
  if (
    !bundle || bundle.size <= 0 || bundle.size > 16 * 1024 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(bundle.digest) ||
    bundle.browser_download_url !==
      `https://github.com/${QUALIFICATION_REPOSITORY}/releases/download/${tag}/${QUALIFICATION_MANIFEST}.intoto.jsonl`
  ) fail('invalid public attestation asset')
  const names = release.assets.map((x) => x.name)
  if (
    new Set(names).size !== names.length ||
    names.length !== Object.keys(expected).length + 1 ||
    !names.includes(`${QUALIFICATION_MANIFEST}.intoto.jsonl`)
  ) fail('published asset inventory differs')
  for (const [name, file] of Object.entries(expected)) {
    const row = release.assets.find((x) => x.name === name)
    if (
      !row || row.size !== file.size ||
      row.digest !== `sha256:${file.sha256}` ||
      row.browser_download_url !==
        `https://github.com/${QUALIFICATION_REPOSITORY}/releases/download/${tag}/${name}`
    ) fail('published asset digest differs')
  }
}
export async function verifyPublishedQualification(
  m: QualificationManifest,
  github: QualificationGitHub,
  selectedAssets?: string[],
  revocationTransport: RuntimeRevocationTransport = {},
): Promise<RuntimeRevocationObservation> {
  assertQualificationManifest(m)
  const release = await github.release(qualificationTag(m))
  if (!release) fail('final qualification does not exist')
  assertPublishedRelease(m, release)
  // The protected hosted promotion already checked the original Actions/PR
  // lineage. Its signed immutable payload preserves the original evidence;
  // consumers must not depend on expiring CI artifacts or synthetic PR refs.
  // The promotion source, tag, signature and public bytes are reverified below.
  if (await github.tagCommit(release.tag_name) !== release.target_commitish) {
    fail('qualification tag differs from attested source')
  }
  await github.verifyTagProtection(release.tag_name)
  await github.verifyMainAncestor(release.target_commitish)
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'slv-qualified-public-' }),
  )
  try {
    const names = [
      QUALIFICATION_MANIFEST,
      `${QUALIFICATION_MANIFEST}.intoto.jsonl`,
      ...(selectedAssets ?? Object.keys(m.assets)),
    ]
    for (const name of new Set(names)) {
      const row = release.assets.find((x) => x.name === name)
      if (!row) fail('missing public qualification subject')
      await github.download(row.browser_download_url, join(temporary, name))
      if (name === QUALIFICATION_MANIFEST) {
        await readQualificationManifest(
          join(temporary, name),
          qualificationIdentity(m),
        )
      } else if (name !== `${QUALIFICATION_MANIFEST}.intoto.jsonl`) {
        await verifyFile(join(temporary, name), m.assets[name])
      } else {
        await verifyFile(join(temporary, name), {
          sha256: row.digest.slice(7),
          size: row.size,
        })
      }
    }
    await github.verifyAttestation(
      join(temporary, QUALIFICATION_MANIFEST),
      join(temporary, `${QUALIFICATION_MANIFEST}.intoto.jsonl`),
      release.target_commitish,
    )
    return await checkFreshRuntimeRevocation(
      qualificationIdentity(m),
      revocationTransport,
    )
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
}
export type QualificationBindingOptions = {
  directory: string
  manifestPath?: string
  expectedIdentity?: string
  repositoryRoot: string
  target: QualificationTarget
  mode: QualificationState
  github?: QualificationGitHub
}
export async function verifyQualificationBinding(
  options: QualificationBindingOptions,
): Promise<QualificationBinding> {
  const m = await readQualificationManifest(
    options.manifestPath ??
      join(
        options.repositoryRoot,
        'source-materials/runtime-qualification.json',
      ),
    options.expectedIdentity,
  )
  const identity = qualificationIdentity(m)
  const row = m.targets.find((x) => x.target === options.target)
  if (!row) fail('unknown target')
  const reviewedPolicy = await verifyQualificationDirectory(
    m,
    options.directory,
    options.repositoryRoot,
  )
  let currentPolicy: RuntimeRevocationObservation | null = null
  if (options.mode === 'final-qualified') {
    currentPolicy = await verifyPublishedQualification(
      m,
      options.github ?? githubQualificationAdapter(),
      [
        row.runtime,
        row.derived_lock,
        row.proof,
        row.build_receipt,
        m.source.selected_lock,
      ],
    )
  } else if (options.mode !== 'candidate-validation') {
    fail('invalid qualification state')
  }
  const file = (name: string) => ({
    path: join(options.directory, name),
    ...m.assets[name],
  })
  return {
    identity,
    tag: qualificationTag(m),
    state: options.mode,
    target: row.target,
    runtime: file(row.runtime),
    derivedLock: file(row.derived_lock),
    selectedLock: file(m.source.selected_lock),
    proof: file(row.proof),
    buildReceipt: file(row.build_receipt),
    sourceReceipt: file(m.source.receipt),
    abi: row.abi,
    manifest: m,
    revocation: {
      reviewed_checkout_policy: reviewedPolicy,
      current_main_policy: currentPolicy,
    },
  }
}
/** Only call on the JSON returned by a successful cryptographic gh verification. */
export function verifyQualificationAttestationResult(
  value: unknown,
  expectedSha256: string,
): void {
  if (!Array.isArray(value) || !value.length) {
    fail('missing verified attestation result')
  }
  if (
    !value.some((row) => {
      const statement = row?.verificationResult?.statement
      return statement?._type === 'https://in-toto.io/Statement/v1' &&
        statement.predicateType === 'https://slsa.dev/provenance/v1' &&
        Array.isArray(statement.subject) && statement.subject.length === 1 &&
        statement.subject[0].name === QUALIFICATION_MANIFEST &&
        statement.subject[0].digest?.sha256 === expectedSha256
    })
  ) fail('verified attestation subject differs')
}
export type PromotionContext = {
  repository: string
  event: string
  ref: string
  source_sha: string
  workflow_sha: string
  workflow_ref: string
  operation: string
  runner_environment: string
}
export function assertPromotionContext(context: PromotionContext): void {
  if (
    context.repository !== QUALIFICATION_REPOSITORY ||
    !['push', 'workflow_dispatch'].includes(context.event) ||
    context.ref !== 'refs/heads/main' || !COMMIT.test(context.source_sha) ||
    context.workflow_sha !== context.source_sha ||
    context.workflow_ref !==
      `${QUALIFICATION_REPOSITORY}/${QUALIFICATION_WORKFLOW}@refs/heads/main` ||
    !['release', 'runtime-qualification'].includes(context.operation) ||
    context.runner_environment !== 'github-hosted'
  ) fail('promotion is restricted to trusted hosted main')
}
/** An absent tag may be created by publishing; an existing tag is never moved. */
export async function verifyQualificationTagForPromotion(
  tag: string,
  sourceCommit: string,
  github: QualificationGitHub,
): Promise<'absent' | 'matching'> {
  string(sourceCommit, COMMIT, 'promotion source')
  const resolved = await github.tagCommit(tag)
  if (resolved === null) return 'absent'
  if (resolved !== sourceCommit) {
    fail('existing qualification tag conflicts with reviewed promotion')
  }
  return 'matching'
}

/** Read-only recovery audit. Existing asset bytes are never replaced. */
export async function verifyQualificationDraft(
  m: QualificationManifest,
  release: QualificationRelease,
  sourceCommit: string,
  github: QualificationGitHub,
  requireComplete = false,
  revocationTransport: RuntimeRevocationTransport = {},
): Promise<
  {
    missing_assets: string[]
    needs_attestation: boolean
    current_main_policy: RuntimeRevocationObservation | null
  }
> {
  assertQualificationManifest(m)
  const tag = qualificationTag(m)
  if (
    release.tag_name !== tag || release.draft !== true ||
    release.prerelease !== true || release.immutable === true ||
    release.target_commitish !== sourceCommit || !COMMIT.test(sourceCommit)
  ) fail('existing qualification draft conflicts with reviewed promotion')
  await verifyQualificationTagForPromotion(tag, sourceCommit, github)
  const expected: Record<string, QualificationAsset> = {
    ...m.assets,
    [QUALIFICATION_MANIFEST]: {
      sha256: qualificationIdentity(m),
      size: canonicalQualificationBytes(m).length,
    },
  }
  const bundleName = `${QUALIFICATION_MANIFEST}.intoto.jsonl`
  const seen = new Set<string>()
  const assetIds = new Set<number>()
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'slv-qualification-draft-' }),
  )
  try {
    for (const row of release.assets) {
      positive(row.id, 'release asset ID')
      if (
        seen.has(row.name) ||
        assetIds.has(row.id) ||
        (!(row.name in expected) && row.name !== bundleName)
      ) fail('existing draft has unknown or duplicate assets')
      seen.add(row.name)
      assetIds.add(row.id)
      const wanted = expected[row.name]
      if (
        !/^sha256:[a-f0-9]{64}$/.test(row.digest) || row.size <= 0 ||
        (wanted
          ? row.size !== wanted.size || row.digest !== `sha256:${wanted.sha256}`
          : row.size > 16 * 1024 * 1024)
      ) fail('existing draft asset conflicts with pinned bytes')
      // GitHub uses an untagged preview URL while a release is a draft.
      // That informational URL is never a download authority here: use only
      // the authenticated inventory's ID at the fixed repository API endpoint,
      // then verify the actual bytes. Published URLs remain checked separately.
      await github.downloadReleaseAsset(row.id, join(temporary, row.name))
      await verifyFile(
        join(temporary, row.name),
        wanted ?? { sha256: row.digest.slice(7), size: row.size },
      )
    }
    if (seen.has(bundleName)) {
      // A partial upload may contain the bundle before the subject. The subject
      // is deterministic and reviewed; no replacement of a present asset occurs.
      if (!seen.has(QUALIFICATION_MANIFEST)) {
        await Deno.writeFile(
          join(temporary, QUALIFICATION_MANIFEST),
          canonicalQualificationBytes(m),
          { createNew: true },
        )
      }
      await github.verifyAttestation(
        join(temporary, QUALIFICATION_MANIFEST),
        join(temporary, bundleName),
        sourceCommit,
      )
    }
    const missing_assets = Object.keys(expected).filter((name) =>
      !seen.has(name)
    ).sort()
    const needs_attestation = !seen.has(bundleName)
    if (requireComplete && (missing_assets.length || needs_attestation)) {
      fail('draft qualification upload is incomplete')
    }
    // Re-read after asset transfer and attestation verification, immediately
    // before the caller can publish the complete draft. No tag update is allowed.
    if (requireComplete) {
      await verifyQualificationTagForPromotion(tag, sourceCommit, github)
    }
    const currentPolicy = requireComplete
      ? await checkFreshRuntimeRevocation(
        qualificationIdentity(m),
        revocationTransport,
      )
      : null
    return {
      missing_assets,
      needs_attestation,
      current_main_policy: currentPolicy,
    }
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
}

/** Preserve an earlier main producer only when its signed draft is complete. */
export async function verifyPromotionDraft(
  m: QualificationManifest,
  release: QualificationRelease,
  context: PromotionContext,
  github: QualificationGitHub,
  requireComplete = false,
  revocationTransport: RuntimeRevocationTransport = {},
) {
  assertPromotionContext(context)
  await github.verifyMainAncestor(context.source_sha)
  const source = release.target_commitish
  string(source, COMMIT, 'draft promotion source')
  const priorSource = source !== context.source_sha
  if (priorSource) {
    // Bind ancestry to this exact authorized executor, not a moving main ref.
    await github.verifyMainAncestor(source, context.source_sha)
  }
  const verified = await verifyQualificationDraft(
    m,
    release,
    source,
    github,
    requireComplete || priorSource,
    revocationTransport,
  )
  return {
    ...verified,
    recovery_mode: priorSource
      ? 'complete-attested-ancestor' as const
      : 'same-source' as const,
    source_sha: context.source_sha,
    attested_source_sha: source,
  }
}
/** Prepares an exact publication plan; publishing remains an explicit hosted workflow step. */
export async function planQualificationPromotion(
  options: {
    manifest: QualificationManifest
    directory: string
    repositoryRoot: string
    context: PromotionContext
    github: QualificationGitHub
  },
): Promise<
  {
    action: 'create' | 'resume' | 'reuse'
    tag: string
    identity: string
    assets: string[]
    needs_attestation: boolean
    /** Authorized executor; used as a new tag target only for action=create. */
    source_sha: string
    /** Original signer/tag source, never relabelled during recovery or reuse. */
    attested_source_sha: string
    recovery_mode:
      | 'create'
      | 'same-source'
      | 'complete-attested-ancestor'
      | 'reuse'
    revocation: {
      reviewed_checkout_policy: RuntimeRevocationObservation
      current_main_policy: RuntimeRevocationObservation
    }
    tag_protection: { bypass_visibility: 'visible-empty' | 'not-visible' }
  }
> {
  assertPromotionContext(options.context)
  await options.github.verifyMainAncestor(options.context.source_sha)
  const tagProtection = await options.github.verifyTagProtection(
    qualificationTag(options.manifest),
  )
  const reviewedPolicy = await verifyQualificationDirectory(
    options.manifest,
    options.directory,
    options.repositoryRoot,
  )
  const existing = await options.github.release(
    qualificationTag(options.manifest),
  )
  if (existing?.draft === true) {
    await verifyCandidateProvenance(options.manifest, options.github)
    const recovery = await verifyPromotionDraft(
      options.manifest,
      existing,
      options.context,
      options.github,
    )
    const currentPolicy = recovery.current_main_policy ??
      await checkFreshRuntimeRevocation(
        qualificationIdentity(options.manifest),
      )
    return {
      action: 'resume',
      revocation: {
        reviewed_checkout_policy: reviewedPolicy,
        current_main_policy: currentPolicy,
      },
      tag: qualificationTag(options.manifest),
      identity: qualificationIdentity(options.manifest),
      assets: recovery.missing_assets,
      needs_attestation: recovery.needs_attestation,
      source_sha: recovery.source_sha,
      attested_source_sha: recovery.attested_source_sha,
      recovery_mode: recovery.recovery_mode,
      tag_protection: tagProtection,
    }
  }
  if (existing) {
    const currentPolicy = await verifyPublishedQualification(
      options.manifest,
      options.github,
    )
    return {
      action: 'reuse',
      revocation: {
        reviewed_checkout_policy: reviewedPolicy,
        current_main_policy: currentPolicy,
      },
      tag: qualificationTag(options.manifest),
      identity: qualificationIdentity(options.manifest),
      assets: [],
      needs_attestation: false,
      source_sha: options.context.source_sha,
      attested_source_sha: existing.target_commitish,
      recovery_mode: 'reuse',
      tag_protection: tagProtection,
    }
  }
  await verifyQualificationTagForPromotion(
    qualificationTag(options.manifest),
    options.context.source_sha,
    options.github,
  )
  await verifyCandidateProvenance(options.manifest, options.github)
  const currentPolicy = await checkFreshRuntimeRevocation(
    qualificationIdentity(options.manifest),
  )
  return {
    action: 'create',
    revocation: {
      reviewed_checkout_policy: reviewedPolicy,
      current_main_policy: currentPolicy,
    },
    needs_attestation: true,
    tag: qualificationTag(options.manifest),
    identity: qualificationIdentity(options.manifest),
    assets: [
      QUALIFICATION_MANIFEST,
      ...Object.keys(options.manifest.assets).sort(),
    ],
    source_sha: options.context.source_sha,
    attested_source_sha: options.context.source_sha,
    recovery_mode: 'create',
    tag_protection: tagProtection,
  }
}

export async function extractQualificationSourceMembers(
  m: QualificationManifest,
  directory: string,
): Promise<void> {
  const archive = resolve(directory, m.source.archives['slv-source.tar.gz'])
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({
      prefix: 'slv-runtime-source-scan-',
    }),
  )
  try {
    await scanArchiveForUnsafeMembers(
      archive,
      'slv-source',
      temporary,
      join(temporary, 'scan.log'),
    )
    const script = String.raw`
import json,sys,tarfile,os,shutil
archive,destination=sys.argv[1:]
with tarfile.open(archive,'r:gz') as tar:
 for member,name in json.load(sys.stdin).items():
  row=tar.getmember(member)
  if not row.isfile() or row.size>=2147483648: raise ValueError('source member is not regular')
  with tar.extractfile(row) as src, open(os.path.join(destination,name),'xb') as out: shutil.copyfileobj(src,out,1024*1024)
`
    await command(
      'python3',
      ['-c', script, archive, directory],
      JSON.stringify(m.source.members),
    )
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
}
/** Acquire without executing any original artifact, and preserve every original byte. */
export async function acquireQualificationInputs(
  options: {
    manifestPath: string
    directory: string
    repositoryRoot: string
    github: QualificationGitHub
  },
): Promise<
  {
    state: 'candidate-ready' | 'existing-qualified'
    identity: string
    tag: string
  }
> {
  const m = await readQualificationManifest(options.manifestPath)
  const reviewedPolicy = await checkReviewedRuntimeRevocation(
    qualificationIdentity(m),
    options.repositoryRoot,
  )
  let currentPolicy: RuntimeRevocationObservation | null = null
  await Deno.mkdir(options.directory, { recursive: false, mode: 0o700 })
  const existing = await options.github.release(qualificationTag(m))
  if (existing?.draft) {
    await options.github.verifyMainAncestor(existing.target_commitish)
    await verifyQualificationDraft(
      m,
      existing,
      existing.target_commitish,
      options.github,
    )
  }
  if (existing && !existing.draft) {
    assertPublishedRelease(m, existing)
    for (const [name, expected] of Object.entries(m.assets)) {
      const row = existing.assets.find((x) => x.name === name)!
      await options.github.download(
        row.browser_download_url,
        join(options.directory, name),
      )
      await verifyFile(join(options.directory, name), expected)
    }
    await verifyQualificationDirectory(
      m,
      options.directory,
      options.repositoryRoot,
    )
    currentPolicy = await verifyPublishedQualification(m, options.github, [])
  } else {
    await verifyCandidateProvenance(m, options.github)
    for (const row of m.artifacts) {
      const path = join(options.directory, row.asset)
      await options.github.downloadArtifact(row.id, path)
      await verifyFile(path, m.assets[row.asset])
      await extractQualificationZip(path, row.members, options.directory)
    }
    await extractQualificationSourceMembers(m, options.directory)
    await verifyQualificationDirectory(
      m,
      options.directory,
      options.repositoryRoot,
    )
  }
  await Deno.writeFile(
    join(options.directory, QUALIFICATION_MANIFEST),
    canonicalQualificationBytes(m),
    { createNew: true },
  )
  const receipt = {
    state: existing && !existing.draft
      ? 'existing-qualified' as const
      : 'candidate-ready' as const,
    identity: qualificationIdentity(m),
    tag: qualificationTag(m),
    revocation: {
      reviewed_checkout_policy: reviewedPolicy,
      current_main_policy: currentPolicy,
    },
  }
  await Deno.writeFile(
    join(options.directory, 'qualification-state.json'),
    canonicalQualificationBytes(receipt),
    { createNew: true },
  )
  return receipt
}
function promotionEnvironment(): PromotionContext {
  return {
    repository: Deno.env.get('GITHUB_REPOSITORY') ?? '',
    event: Deno.env.get('GITHUB_EVENT_NAME') ?? '',
    ref: Deno.env.get('GITHUB_REF') ?? '',
    source_sha: Deno.env.get('SLV_RELEASE_SOURCE_SHA') ?? '',
    workflow_sha: Deno.env.get('GITHUB_WORKFLOW_SHA') ?? '',
    workflow_ref: Deno.env.get('GITHUB_WORKFLOW_REF') ?? '',
    operation: Deno.env.get('SLV_RELEASE_OPERATION') ?? '',
    runner_environment: Deno.env.get('RUNNER_ENVIRONMENT') ?? '',
  }
}
if (import.meta.main) {
  const [action, ...args] = Deno.args
  if (action === 'inputs' && args.length === 3) {
    await acquireQualificationInputs({
      manifestPath: args[0],
      directory: args[1],
      repositoryRoot: args[2],
      github: githubQualificationAdapter(),
    })
  } else if (action === 'promotion-plan' && args.length === 4) {
    const plan = await planQualificationPromotion({
      manifest: await readQualificationManifest(args[0]),
      directory: args[1],
      repositoryRoot: args[2],
      context: promotionEnvironment(),
      github: githubQualificationAdapter(),
    })
    await Deno.writeFile(args[3], canonicalQualificationBytes(plan), {
      createNew: true,
    })
  } else if (
    action === 'verify-draft' && (args.length === 3 || args.length === 4)
  ) {
    const m = await readQualificationManifest(args[0]),
      context = promotionEnvironment(),
      github = githubQualificationAdapter()
    assertPromotionContext(context)
    const reviewedPolicy = await verifyQualificationDirectory(
      m,
      args[1],
      args[2],
    )
    const release = await github.release(qualificationTag(m))
    if (!release) fail('draft qualification not found')
    const result = await verifyPromotionDraft(
      m,
      release,
      context,
      github,
      true,
    )
    const receipt = canonicalQualificationBytes({
      identity: qualificationIdentity(m),
      executor_source_sha: context.source_sha,
      attested_source_sha: result.attested_source_sha,
      recovery_mode: result.recovery_mode,
      revocation: {
        reviewed_checkout_policy: reviewedPolicy,
        current_main_policy: result.current_main_policy,
      },
    })
    if (args[3]) await Deno.writeFile(args[3], receipt, { createNew: true })
    else await Deno.stdout.write(receipt)
  } else if (action === 'verify' && args.length === 5) {
    const m = await readQualificationManifest(args[0])
    const state = args[3]
    if (!['candidate-validation', 'final-qualified'].includes(state)) {
      fail('unknown verification state')
    }
    if (
      Deno.env.get('GITHUB_REF') === 'refs/heads/main' &&
      state !== 'final-qualified'
    ) fail('main requires final public qualification')
    const reviewedPolicy = await verifyQualificationDirectory(
      m,
      args[1],
      args[2],
    )
    const currentPolicy = state === 'final-qualified'
      ? await verifyPublishedQualification(m, githubQualificationAdapter())
      : null
    await Deno.writeFile(
      args[4],
      canonicalQualificationBytes({
        state,
        identity: qualificationIdentity(m),
        tag: qualificationTag(m),
        manifest_sha256: qualificationIdentity(m),
        revocation: {
          reviewed_checkout_policy: reviewedPolicy,
          current_main_policy: currentPolicy,
        },
      }),
      { createNew: true },
    )
  } else {fail(
      'usage: inputs MANIFEST DIRECTORY ROOT | promotion-plan MANIFEST DIRECTORY ROOT PLAN | verify-draft MANIFEST DIRECTORY ROOT | verify MANIFEST DIRECTORY ROOT STATE RECEIPT',
    )}
}
