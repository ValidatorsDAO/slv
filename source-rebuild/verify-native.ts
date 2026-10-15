/**
 * Offline native rebuild proof driver.
 *
 * `build` reconstructs baseline and sentinel runtimes from the three source
 * archives and emits a hash-allowlisted transport directory. `execute` runs
 * only those transported artifacts on the target host. `merge` rebinds both
 * phase receipts to the immutable assembly receipt and produces the target
 * proof consumed by the release aggregator.
 */
import { createHash } from 'node:crypto'
import {
  sha256,
  type SourceAsset,
  type SourceMaterialsReceipt,
  verifyNativeSourceRebuildProof,
  verifySourceMaterialsReceipt,
} from '../scripts/release/source-materials.ts'
import {
  canonicalTargetDescriptorBytes,
  parseToolPins,
} from './prepare-tools.ts'

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const SHA256 = /^[a-f0-9]{64}$/
const TARGETS = new Set([
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
])
const ASSETS = [
  'slv-source.tar.gz',
  'deno-source.tar.gz',
  'deno-cargo-vendor.tar.gz',
] as const
// Measured peak after tool and source-archive staging on Linux is 10.3 GiB
// (2.8 GiB extracted source, 1.1 GiB disposable recipe work, 6.4 GiB target).
// The remaining allowance covers transport binaries, logs, metadata, and the
// modified-tree transition without retaining the completed baseline scratch.
const BUILD_MIN_FREE_KIB = 12 * 1024 * 1024
const EXECUTION_FAILURE_TAIL_BYTES = 4096
type AssetName = typeof ASSETS[number]
type Phase = 'build' | 'build-variant' | 'join-build' | 'execute' | 'merge'
type Args = Record<string, string>
type Host = { os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }
type Variant = 'baseline' | 'modified'
type ProducerContext = {
  schema_version: 1
  kind: 'slv-native-producer-context'
  repository: 'ValidatorsDAO/slv'
  workflow: string
  run_id: string
  run_attempt: string
  job_id: string
}
type CommandReceipt = {
  command: string[]
  cwd: string
  started_at: string
  finished_at: string
  exit_code: number
  log: string
  log_sha256: string
  environment: Record<string, string>
}
type ObservedCommandResult = {
  started_at: string
  finished_at: string
  elapsed_seconds: number
  exit_code: number
  signal: string | null
}
type ToolReceipt = {
  target: string
  build_host: string
  purpose: 'build' | 'execution'
  pins_sha256: string
  target_pin_sha256: string
  environment: Record<string, string>
  identities: Record<string, { path: string; sha256: string }>
  archives: Record<string, {
    sha256: string
    size: number
    url: string
    included_members?: string[]
  }>
}
export type Artifacts = {
  baseline: {
    denort_sha256: string
    v8_archive_sha256: string
    ninja_sha256: string
    probe_standalone_sha256: string
    derived_relink_cargo_lock_sha256: string
    slv_executable_sha256: string
    bridge_standalone_sha256: string
  }
  modified: {
    denort_sha256: string
    v8_archive_sha256: string
    ninja_sha256: string
    probe_standalone_sha256: string
  }
}
type ImmutableInputs = {
  assembly: SourceMaterialsReceipt
  assemblyReceiptSha256: string
  pinsSha256: string
  noticeSha256: string
  sourceAssets: Array<{ name: AssetName; sha256: string; size: number }>
  archives: Record<AssetName, string>
  sourceRoot?: string
  extraction?: Record<string, CommandReceipt>
}
type TransportEntry = { path: string; sha256: string; size: number }
type TransportManifest = {
  schema_version: 1
  kind: 'slv-source-native-transport'
  target: string
  source_receipt_sha256: string
  artifacts: Artifacts
  entries: Record<string, TransportEntry>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function sha(value: unknown, label: string): string {
  const digest = text(value, label)
  if (!SHA256.test(digest)) throw new Error(`${label} must be a SHA-256`)
  return digest
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`
      ).join(',')
    }}`
  }
  return JSON.stringify(value)
}

function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) {
    throw new Error(`${label} has an unexpected key set`)
  }
}

function positiveDecimal(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!/^[1-9][0-9]*$/.test(parsed)) {
    throw new Error(`${label} must be a positive decimal string`)
  }
  return parsed
}

function artifactDigest(value: unknown, label: string): string {
  const raw = text(value, label)
  const digest = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
  if (!SHA256.test(digest)) {
    throw new Error(`${label} must be a SHA-256 or sha256:SHA-256`)
  }
  return digest
}

function parseProducerContext(value: unknown, label: string): ProducerContext {
  const record = object(value, label)
  exactKeys(record, [
    'schema_version',
    'kind',
    'repository',
    'workflow',
    'run_id',
    'run_attempt',
    'job_id',
  ], label)
  if (
    record.schema_version !== 1 ||
    record.kind !== 'slv-native-producer-context' ||
    record.repository !== 'ValidatorsDAO/slv'
  ) {
    throw new Error(`${label} has an unsupported producer identity`)
  }
  const workflow = text(record.workflow, `${label} workflow`)
  if (!workflow.startsWith('ValidatorsDAO/slv/')) {
    throw new Error(`${label} workflow does not belong to ValidatorsDAO/slv`)
  }
  return {
    schema_version: 1,
    kind: 'slv-native-producer-context',
    repository: 'ValidatorsDAO/slv',
    workflow,
    run_id: positiveDecimal(record.run_id, `${label} run_id`),
    run_attempt: positiveDecimal(record.run_attempt, `${label} run_attempt`),
    job_id: text(record.job_id, `${label} job_id`),
  }
}

function phaseOf(args: Args): Phase {
  const phase = args['--phase']
  if (
    phase !== 'build' && phase !== 'build-variant' &&
    phase !== 'join-build' && phase !== 'execute' && phase !== 'merge'
  ) {
    throw new Error(
      '--phase must be build, build-variant, join-build, execute, or merge',
    )
  }
  return phase
}

export function parseNativeArgs(argv: string[]): Args {
  const values: Args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !flag?.startsWith('--') || !value || value.startsWith('--') ||
      values[flag]
    ) {
      throw new Error('arguments must be unique --flag VALUE pairs')
    }
    values[flag] = value
  }
  const phase = values['--phase']
  if (
    phase !== 'build' && phase !== 'build-variant' &&
    phase !== 'join-build' && phase !== 'execute' && phase !== 'merge'
  ) {
    throw new Error(
      'usage: verify-native.ts --phase build|build-variant|join-build|execute|merge --target TARGET --source-root EMPTY_DIR --work-dir EMPTY_DIR --out PROOF_DIR --pins PINS_JSON --source-receipt RECEIPT_JSON --slv-source ARCHIVE --deno-source ARCHIVE --cargo-vendor ARCHIVE --notice-file THIRD_PARTY_NOTICES [phase inputs]',
    )
  }
  const common = [
    '--target',
    '--source-root',
    '--work-dir',
    '--out',
    '--pins',
    '--source-receipt',
    '--slv-source',
    '--deno-source',
    '--cargo-vendor',
    '--notice-file',
  ]
  for (const required of common) {
    if (!values[required]) throw new Error(`missing ${required}`)
  }
  if (
    (phase === 'build' || phase === 'build-variant') &&
    !values['--tools-receipt']
  ) {
    throw new Error(`${phase} requires --tools-receipt`)
  }
  if (
    values['--evidence-out'] !== undefined &&
    phase !== 'build' && phase !== 'build-variant'
  ) {
    throw new Error(
      '--evidence-out is permitted only for build or build-variant',
    )
  }
  if (
    values['--evidence-out'] !== undefined &&
    !values['--evidence-out'].startsWith('/')
  ) {
    throw new Error('--evidence-out must be an absolute directory')
  }
  if (values['--jobs'] !== undefined) {
    if (
      (phase !== 'build' && phase !== 'build-variant') ||
      !/^(?:[1-9]|1[0-6])$/.test(values['--jobs'])
    ) {
      throw new Error(
        '--jobs is permitted only for build or build-variant and must be 1 through 16',
      )
    }
  }
  if (phase === 'build-variant') {
    if (
      values['--variant'] !== 'baseline' && values['--variant'] !== 'modified'
    ) {
      throw new Error('build-variant requires --variant baseline or modified')
    }
    for (const required of ['--build-host', '--jobs', '--producer-context']) {
      if (!values[required]) {
        throw new Error(`build-variant requires ${required}`)
      }
    }
    if (values['--jobs'] !== '4') {
      throw new Error('build-variant requires --jobs 4')
    }
    if (values['--variant-dependencies'] !== undefined) {
      throw new Error('build-variant does not accept --variant-dependencies')
    }
  }
  if (phase === 'join-build') {
    for (const required of ['--producer-context', '--variant-dependencies']) {
      if (!values[required]) throw new Error(`join-build requires ${required}`)
    }
    for (
      const forbidden of ['--variant', '--jobs', '--tools-receipt']
    ) {
      if (values[forbidden] !== undefined) {
        throw new Error(`join-build does not accept ${forbidden}`)
      }
    }
  }
  if (phase !== 'build-variant' && phase !== 'join-build') {
    for (
      const unexpected of [
        '--variant',
        '--producer-context',
        '--variant-dependencies',
      ]
    ) {
      if (values[unexpected] !== undefined) {
        throw new Error(`${phase} does not accept ${unexpected}`)
      }
    }
  }
  if (phase === 'execute') {
    for (
      const required of [
        '--build-receipt',
        '--build-materials',
        '--execution-tools-receipt',
      ]
    ) {
      if (!values[required]) throw new Error(`execute requires ${required}`)
    }
  }
  if (phase === 'merge') {
    for (const required of ['--build-receipt', '--execution-receipt']) {
      if (!values[required]) throw new Error(`merge requires ${required}`)
    }
  }
  return values
}

async function real(path: string): Promise<string> {
  return await Deno.realPath(path)
}

async function ensureEmptyDirectory(
  path: string,
  label: string,
): Promise<string> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (info && (!info.isDirectory || info.isSymlink)) {
    throw new Error(`${label} must be a real directory: ${path}`)
  }
  if (!info) await Deno.mkdir(path, { recursive: true })
  for await (const _entry of Deno.readDir(path)) {
    throw new Error(`${label} must be empty: ${path}`)
  }
  return await real(path)
}

async function ensureDirectory(path: string, label: string): Promise<string> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isDirectory || info.isSymlink) {
    throw new Error(`${label} must be a real directory: ${path}`)
  }
  return await real(path)
}

async function regularFile(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink) {
    throw new Error(`${label} is not a regular file: ${path}`)
  }
}

async function regularToolIdentity(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info) throw new Error(`${label} is missing: ${path}`)
  if (info.isSymlink) {
    // Chromium Clang exposes ld.lld as a same-directory link to `lld`.
    // Permit that package-internal layout without permitting a receipt to
    // escape into arbitrary host bytes.
    const resolved = await real(path).catch(() => undefined)
    const parent = await real(path.slice(0, path.lastIndexOf('/'))).catch(() =>
      undefined
    )
    if (!resolved || !parent || !resolved.startsWith(`${parent}/`)) {
      throw new Error(`${label} symlink escapes its prepared tool directory`)
    }
    const resolvedInfo = await Deno.stat(resolved).catch(() => undefined)
    if (!resolvedInfo?.isFile || resolvedInfo.size <= 0) {
      throw new Error(`${label} link does not resolve to a non-empty file`)
    }
    return
  }
  if (!info.isFile || info.size <= 0) {
    throw new Error(`${label} is not a non-empty regular tool file: ${path}`)
  }
}

function baseCommandEnvironment(cwd: string): Record<string, string> {
  return {
    HOME: `${cwd}/.private-home`,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  }
}

async function allowedEnvironment(
  cwd: string,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const allowed = { ...baseCommandEnvironment(cwd), ...env }
  await Deno.mkdir(allowed.HOME, { recursive: true })
  return allowed
}

async function command(
  executable: string,
  args: string[],
  cwd: string,
  log: string,
  env: Record<string, string> = {},
): Promise<CommandReceipt> {
  const environment = await allowedEnvironment(cwd, env)
  const started_at = new Date().toISOString()
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    clearEnv: true,
    env: environment,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const finished_at = new Date().toISOString()
  const bytes = new Uint8Array(result.stdout.length + result.stderr.length)
  bytes.set(result.stdout)
  bytes.set(result.stderr, result.stdout.length)
  await Deno.writeFile(log, bytes)
  return {
    command: [executable, ...args],
    cwd,
    started_at,
    finished_at,
    exit_code: result.code,
    log,
    log_sha256: await sha256(log),
    environment,
  }
}

async function assertBuildCapacity(
  paths: string[],
  cwd: string,
): Promise<{
  minimum_free_kib: number
  measurements: Array<
    { path: string; free_kib: number; command: CommandReceipt }
  >
}> {
  const measurements: Array<{
    path: string
    free_kib: number
    command: CommandReceipt
  }> = []
  for (const [index, path] of [...new Set(paths)].entries()) {
    const receipt = await command(
      'df',
      ['-Pk', path],
      cwd,
      `${cwd}/capacity-${index}.log`,
    )
    succeeded(receipt, `disk-capacity measurement for ${path}`)
    const rows = decoder.decode(await Deno.readFile(receipt.log)).trim().split(
      '\n',
    )
    const parts = rows.at(-1)?.trim().split(/\s+/) ?? []
    const free = Number(parts.at(-3))
    if (!Number.isSafeInteger(free) || free < 0) {
      throw new Error(`could not parse POSIX df free space for ${path}`)
    }
    if (free < BUILD_MIN_FREE_KIB) {
      throw new Error(
        `insufficient free space for bounded native rebuild at ${path}: ${free} KiB, need ${BUILD_MIN_FREE_KIB} KiB after tool/archive staging`,
      )
    }
    measurements.push({ path, free_kib: free, command: receipt })
  }
  return { minimum_free_kib: BUILD_MIN_FREE_KIB, measurements }
}

export async function prepareBuildDirectories(
  outPath: string,
  workPath: string,
  sourceRootPath: string,
): Promise<{
  out: string
  work: string
  sourceRoot: string
  capacity: Awaited<ReturnType<typeof assertBuildCapacity>>
}> {
  // Every build caller supplies fresh paths. Create and validate all three
  // before `df` so capacity evidence covers the actual extraction directory
  // rather than failing merely because it does not exist yet.
  const out = await ensureEmptyDirectory(outPath, 'build proof output')
  const work = await ensureEmptyDirectory(workPath, 'build work directory')
  const sourceRoot = await ensureEmptyDirectory(sourceRootPath, 'source root')
  const capacity = await assertBuildCapacity([out, work, sourceRoot], out)
  return { out, work, sourceRoot, capacity }
}

async function streamingCommand(
  executable: string,
  args: string[],
  cwd: string,
  log: string,
  env: Record<string, string>,
  observed?: (result: ObservedCommandResult) => void,
): Promise<CommandReceipt> {
  const environment = await allowedEnvironment(cwd, env)
  const started_at = new Date().toISOString()
  const startedMonotonic = performance.now()
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    clearEnv: true,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()
  const finished_at = new Date().toISOString()
  // Preserve the child result before a missing log or log hash can reject the
  // public receipt. Successful receipts keep their existing fields.
  observed?.({
    started_at,
    finished_at,
    elapsed_seconds: Math.max(0, (performance.now() - startedMonotonic) / 1000),
    exit_code: result.code,
    signal: result.signal ?? null,
  })
  await regularFile(log, 'streamed command log')
  return {
    command: [executable, ...args],
    cwd,
    started_at,
    finished_at,
    exit_code: result.code,
    log,
    log_sha256: await sha256(log),
    environment,
  }
}

function succeeded(receipt: CommandReceipt, label: string): void {
  if (receipt.exit_code !== 0) {
    throw new Error(
      `${label} failed (exit ${receipt.exit_code}); inspect ${receipt.log}`,
    )
  }
}

function redactExecutionFailureLine(line: string): string | undefined {
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return undefined
  return line.replace(
    /((?:authorization\s*:\s*(?:bearer\s+)?|(?:api[_ -]?key|token|secret|password|credential|private[_ -]?key)\s*[=:]\s*))[^\s,;]+/gi,
    '$1<redacted>',
  )
}

async function readExecutionFailureTail(
  path: string,
): Promise<{ bytes: Uint8Array; size: number; truncated: boolean }> {
  const info = await Deno.stat(path)
  const size = info.size
  const tailSize = Math.min(size, EXECUTION_FAILURE_TAIL_BYTES)
  const file = await Deno.open(path, { read: true })
  try {
    await file.seek(-tailSize, Deno.SeekMode.End)
    const bytes = new Uint8Array(tailSize)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset))
      if (read === null) break
      offset += read
    }
    return {
      bytes: bytes.subarray(0, offset),
      size,
      truncated: size > tailSize,
    }
  } finally {
    file.close()
  }
}

function redactExecutionFailureTail(
  bytes: Uint8Array,
  truncated: boolean,
): string {
  let text = decoder.decode(bytes)
  if (truncated) {
    const newline = text.indexOf('\n')
    text = newline === -1 ? '' : text.slice(newline + 1)
  }
  return text.split(/\r?\n/).flatMap((line) => {
    const redacted = redactExecutionFailureLine(line)
    return redacted === undefined ? [] : [redacted]
  }).join('\n')
}

async function emitExecutionFailureDiagnostics(
  receipt: CommandReceipt,
  label: string,
): Promise<void> {
  console.error(`execution failure diagnostics: ${label}`)
  console.error(`exit_code: ${receipt.exit_code}`)
  console.error(`log_path: ${receipt.log}`)
  console.error(`recorded_log_sha256: ${receipt.log_sha256}`)
  try {
    const tail = await readExecutionFailureTail(receipt.log)
    console.error(
      `log_tail_bytes: ${tail.bytes.length}/${tail.size}${
        tail.truncated ? ' (truncated)' : ''
      }`,
    )
    console.error(
      `log_tail:\n${redactExecutionFailureTail(tail.bytes, tail.truncated)}`,
    )
  } catch {
    console.error('execution failure log unavailable')
  }
}

export async function assertExecutionSucceeded(
  receipt: CommandReceipt,
  label: string,
): Promise<void> {
  if (receipt.exit_code === 0) return
  await emitExecutionFailureDiagnostics(receipt, label)
  succeeded(receipt, label)
}

async function copyTree(source: string, destination: string): Promise<void> {
  const info = await Deno.lstat(source)
  if (info.isSymlink) {
    await Deno.mkdir(
      destination.slice(0, destination.lastIndexOf('/')) || '.',
      { recursive: true },
    )
    await Deno.symlink(await Deno.readLink(source), destination)
    return
  }
  if (info.isFile) {
    await Deno.mkdir(
      destination.slice(0, destination.lastIndexOf('/')) || '.',
      {
        recursive: true,
      },
    )
    await Deno.copyFile(source, destination)
    return
  }
  if (!info.isDirectory) throw new Error(`unsupported source entry: ${source}`)
  await Deno.mkdir(destination, { recursive: true })
  for await (const entry of Deno.readDir(source)) {
    await copyTree(`${source}/${entry.name}`, `${destination}/${entry.name}`)
  }
}

function assertContainedSymlink(
  linkPath: string,
  target: string,
  links: Map<string, string>,
  safeRoot: string,
): void {
  if (
    !target || target.startsWith('/') || target.includes('\\') ||
    target.includes('\0')
  ) {
    throw new Error('archive contains an unsafe symlink: ' + linkPath)
  }
  const relative = linkPath.slice(safeRoot.length + 1).split('/')
  relative.pop()
  const pending = [...relative, ...target.split('/')]
  const resolved = [safeRoot.slice(safeRoot.lastIndexOf('/') + 1)]
  const seen = new Set<string>()
  let expansions = 0
  while (pending.length) {
    const part = pending.shift()!
    if (!part || part === '.') continue
    if (part === '..') {
      if (resolved.length === 1) {
        throw new Error('archive symlink escapes its root: ' + linkPath)
      }
      resolved.pop()
      continue
    }
    const candidate = [...resolved, part].join('/')
    const nested = links.get(candidate)
    if (nested !== undefined) {
      if (seen.has(candidate) || ++expansions > 128) {
        throw new Error('archive symlink cycle or expansion limit: ' + linkPath)
      }
      seen.add(candidate)
      if (
        !nested || nested.startsWith('/') || nested.includes('\\') ||
        nested.includes('\0')
      ) {
        throw new Error('archive contains an unsafe symlink: ' + candidate)
      }
      // Expand a symlink before processing later `..` components. A lexical
      // normalization alone accepts `a -> ../target`, then
      // `b -> a/../../escape`, although the kernel resolves b outside root.
      pending.unshift(...nested.split('/'))
      continue
    }
    resolved.push(part)
  }
}

export async function assertSafeTree(
  root: string,
  archiveRoot?: string,
): Promise<void> {
  const safeRoot = archiveRoot ?? await real(root)
  const links = new Map<string, string>()
  const collect = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`
      const stat = await Deno.lstat(path)
      if (stat.isSymlink) {
        const relative = path.slice(safeRoot.length + 1)
        links.set(
          `${safeRoot.slice(safeRoot.lastIndexOf('/') + 1)}/${relative}`,
          await Deno.readLink(path),
        )
        continue
      }
      if (stat.isDirectory) await collect(path)
      else if (!stat.isFile) {
        throw new Error('archive has unsupported entry: ' + path)
      }
    }
  }
  await collect(root)
  for (const [archivePath, target] of links) {
    assertContainedSymlink(
      `${safeRoot}/${archivePath.slice(archivePath.indexOf('/') + 1)}`,
      target,
      links,
      safeRoot,
    )
  }
}

async function verifyArchive(path: string, asset: SourceAsset): Promise<void> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (
    !info?.isFile || info.isSymlink || info.size !== asset.size ||
    info.size <= 0 ||
    info.size >= 2 * 1024 * 1024 * 1024
  ) {
    throw new Error(
      `archive size differs from immutable receipt: ${asset.name}`,
    )
  }
  if (await sha256(path) !== asset.sha256) {
    throw new Error(
      `archive SHA-256 differs from immutable receipt: ${asset.name}`,
    )
  }
}

function assetFor(
  receipt: SourceMaterialsReceipt,
  name: AssetName,
): SourceAsset {
  const asset = receipt.assets.find((entry) => entry.name === name)
  if (!asset) throw new Error(`assembly receipt omits ${name}`)
  return asset
}

export async function scanArchiveForUnsafeMembers(
  archive: string,
  root: string,
  destination: string,
  log: string,
): Promise<CommandReceipt> {
  const python = await resolveHostPython()
  const script = String.raw`

import posixpath
import sys
import tarfile

archive, root = sys.argv[1:]

def canonical(raw, label):
    # Member paths name filesystem locations.  Reject aliases instead of
    # collapsing them so duplicate/ancestor checks cannot be bypassed by
    # repeated separators, dot components, leading dot slash, or a hidden parent component.
    if not raw or raw.startswith('/') or chr(92) in raw or chr(0) in raw:
        raise SystemExit('unsafe ' + label + ': ' + raw)
    name = raw[:-1] if raw.endswith('/') else raw
    if not name or name.endswith('/') or name.startswith('./'):
        raise SystemExit('non-canonical ' + label + ': ' + raw)
    normalized = posixpath.normpath(name)
    if normalized != name or '..' in name.split('/'):
        raise SystemExit('non-canonical ' + label + ': ' + raw)
    if not (name == root or name.startswith(root + '/')):
        raise SystemExit('unexpected archive root: ' + raw)
    return name

def unsafe_target(target):
    return (
        not target or target.startswith('/') or chr(92) in target or
        chr(0) in target
    )

with tarfile.open(archive, 'r:gz') as payload:
    members = payload.getmembers()
if not members:
    raise SystemExit('archive has no members')

entries = {}
for member in members:
    name = canonical(member.name, 'archive member')
    if name in entries:
        raise SystemExit('duplicate archive member: ' + member.name)
    if member.islnk() or member.isdev() or member.isfifo() or not (
        member.isfile() or member.isdir() or member.issym()
    ):
        raise SystemExit('unsupported archive member type: ' + member.name)
    entries[name] = member

# No entry may be placed beneath a file or symlink: extraction must never
# traverse an archive-provided link while creating a later member.
for name, member in entries.items():
    parent = posixpath.dirname(name)
    while parent and parent != '.':
        ancestor = entries.get(parent)
        if ancestor and not ancestor.isdir():
            raise SystemExit(
                'archive member has non-directory ancestor: ' +
                member.name + ' under ' + ancestor.name
            )
        parent = posixpath.dirname(parent)

links = {}
for name, member in entries.items():
    if not member.issym():
        continue
    target = member.linkname
    if unsafe_target(target):
        raise SystemExit('unsafe archive symlink: ' + member.name + ' -> ' + target)
    links[name] = target

def resolve_link(name):
    # Resolve path components in kernel order: if one component is a symlink,
    # expand its raw target before applying the next parent component.  A lexical
    # normpath of the whole target misses directory-link escapes such as
    # xdir/a -> ../target, b -> xdir/a/../../outside.
    parent = name.split('/')[:-1]
    pending = list(parent) + list(links[name].split('/'))
    resolved = []
    seen = set()
    expansions = 0
    while pending:
        part = pending.pop(0)
        if not part or part == '.':
            continue
        if part == '..':
            if len(resolved) <= 1:
                raise SystemExit('escaping archive symlink: ' + name + ' -> ' + links[name])
            resolved.pop()
            continue
        candidate = '/'.join(resolved + [part])
        nested = links.get(candidate)
        if nested is not None:
            if candidate in seen or expansions >= 128:
                raise SystemExit('archive symlink cycle or expansion limit: ' + name)
            seen.add(candidate)
            expansions += 1
            if unsafe_target(nested):
                raise SystemExit('unsafe archive symlink: ' + candidate + ' -> ' + nested)
            pending = nested.split('/') + pending
            continue
        entry = entries.get(candidate)
        # A link target may finish at a file or a genuinely dangling path, but
        # it may not traverse through an archive file.
        if entry and not entry.isdir() and pending:
            raise SystemExit('archive symlink traverses non-directory member: ' + name)
        resolved.append(part)
    if not resolved or resolved[0] != root:
        raise SystemExit('escaping archive symlink: ' + name + ' -> ' + links[name])

for name in links:
    resolve_link(name)

print('safe_members=' + str(len(members)))
print('safe_symlinks=' + str(len(links)))

`

  const receipt = await command(
    python.path,
    ['-c', script, archive, root],
    destination,
    log,
    withPythonPath({}, python),
  )
  succeeded(receipt, `pre-extraction archive scan ${archive}`)
  return receipt
}

export async function extractArchive(
  archive: string,
  destination: string,
  root: string,
  log: string,
): Promise<CommandReceipt> {
  // `tar -t` is a presentation format and may quote a valid UTF-8 member
  // differently across implementations. The structured tarfile scanner is the
  // authoritative admission boundary for every extraction, including callers
  // outside the native driver.
  await scanArchiveForUnsafeMembers(archive, root, destination, `${log}.scan`)
  const extracted = await command(
    'tar',
    ['-xzf', archive, '-C', destination],
    destination,
    log,
  )
  succeeded(extracted, `extracting ${archive}`)
  await ensureDirectory(`${destination}/${root}`, `archive root ${root}`)
  return extracted
}

async function verifyEmbeddedMaterials(
  root: string,
  receipt: SourceMaterialsReceipt,
  noticeSha256: string,
): Promise<void> {
  for (
    const relative of [
      'source-materials/pack-manifest.json',
      receipt.closure.embedded_path,
      receipt.inventory.embedded_path,
      'THIRD_PARTY_NOTICES',
    ]
  ) {
    await regularFile(`${root}/${relative}`, `embedded material ${relative}`)
  }
  if (
    await sha256(`${root}/${receipt.closure.embedded_path}`) !==
      receipt.closure.sha256
  ) {
    throw new Error('embedded closure digest differs from immutable receipt')
  }
  if (
    await sha256(`${root}/${receipt.inventory.embedded_path}`) !==
      receipt.inventory.sha256
  ) {
    throw new Error('embedded inventory digest differs from immutable receipt')
  }
  if (await sha256(`${root}/THIRD_PARTY_NOTICES`) !== noticeSha256) {
    throw new Error('embedded notice bytes differ from canonical notice input')
  }
  await assertSafeTree(root)
}

async function verifyRuntimeSecurityEvidence(
  denoRoot: string,
  receipt: SourceMaterialsReceipt,
): Promise<void> {
  const security = receipt.runtime_security
  const files = [
    security.upstream.cargo_lock,
    security.upstream.cargo_manifest,
    security.selected.cargo_lock,
    security.selected.cargo_manifest,
    security.transform.selection,
    security.transform.manifest_patch,
    security.transform.resolution_receipt,
    security.transform.added_identities_osv,
  ]
  for (const file of files) {
    const path = `${denoRoot}/${file.path}`
    await regularFile(path, `runtime security evidence ${file.path}`)
    if (await sha256(path) !== file.sha256) {
      throw new Error(
        `runtime security evidence differs from immutable receipt: ${file.path}`,
      )
    }
  }
}

function targetHost(target: string): Host {
  if (target === 'x86_64-unknown-linux-gnu') return { os: 'linux', arch: 'x64' }
  if (target === 'aarch64-unknown-linux-gnu') {
    return { os: 'linux', arch: 'arm64' }
  }
  if (target === 'x86_64-apple-darwin') return { os: 'darwin', arch: 'x64' }
  if (target === 'aarch64-apple-darwin') return { os: 'darwin', arch: 'arm64' }
  throw new Error(`unsupported target: ${target}`)
}

function currentHost(): Host {
  const os = Deno.build.os
  const arch = Deno.build.arch
  if (
    (os !== 'linux' && os !== 'darwin') ||
    (arch !== 'x86_64' && arch !== 'aarch64')
  ) {
    throw new Error(`unsupported native host: ${os}/${arch}`)
  }
  return { os, arch: arch === 'x86_64' ? 'x64' : 'arm64' }
}

function equalHost(left: Host, right: Host): boolean {
  return left.os === right.os && left.arch === right.arch
}

type HostPython = { path: string; version: string }

async function resolveHostPython(): Promise<HostPython> {
  const selected = Deno.env.get('SLV_HOST_PYTHON')
  const candidates = selected ? [selected] : Deno.build.os === 'darwin'
    ? [
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
    ]
    : ['/usr/bin/python3', '/usr/local/bin/python3']
  for (const candidate of candidates) {
    if (!candidate.startsWith('/')) {
      if (selected) throw new Error('SLV_HOST_PYTHON must be an absolute path')
      continue
    }
    // System Python entry points are commonly a stable absolute symlink such
    // as /usr/bin/python3 -> python3.12. Resolve it, then validate the final
    // executable bytes; rejecting that ordinary system layout would make the
    // otherwise isolated tool recipe fail before any source validation.
    const path = await real(candidate).catch(() => undefined)
    if (!path) continue
    const info = await Deno.lstat(path).catch(() => undefined)
    if (!info?.isFile || info.isSymlink || ((info.mode ?? 0) & 0o111) === 0) {
      continue
    }
    const output = await new Deno.Command(path, {
      args: ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!output.success) continue
    const version = decoder.decode(output.stdout).trim()
    const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    if (matched && Number(matched[1]) === 3 && Number(matched[2]) >= 11) {
      return { path, version }
    }
  }
  throw new Error(
    'a validated absolute Python 3.11+ is required; set SLV_HOST_PYTHON on hosts without one at a standard path',
  )
}

function withPythonPath(
  environment: Record<string, string>,
  python: HostPython,
): Record<string, string> {
  const directory = python.path.slice(0, python.path.lastIndexOf('/'))
  return { ...environment, PATH: `${directory}:/usr/bin:/bin` }
}

function approvedBuildHostTarget(
  target: string,
  buildHost: string | undefined,
): string {
  const expected = target === 'aarch64-unknown-linux-gnu'
    ? 'x86_64-unknown-linux-gnu'
    : target
  const actual = buildHost ?? expected
  if (!TARGETS.has(actual)) throw new Error(`unsupported build host: ${actual}`)
  if (actual !== expected) {
    throw new Error('only Linux x64 to Linux ARM cross-build is permitted')
  }
  return actual
}

function sourceAssets(assembly: SourceMaterialsReceipt): Array<{
  name: AssetName
  sha256: string
  size: number
}> {
  return ASSETS.map((name) => {
    const asset = assetFor(assembly, name)
    return { name, sha256: asset.sha256, size: asset.size }
  })
}

export async function resolveSourceArchivePaths(
  slvSource: string,
  denoSource: string,
  cargoVendor: string,
): Promise<Record<AssetName, string>> {
  // Archive scanners/extractors run with a disposable extraction cwd. Resolve
  // every user-supplied asset before any subprocess changes cwd so ordinary
  // CI-relative artifact paths remain usable throughout this proof.
  return {
    'slv-source.tar.gz': await real(slvSource),
    'deno-source.tar.gz': await real(denoSource),
    'deno-cargo-vendor.tar.gz': await real(cargoVendor),
  }
}

async function immutableInputs(
  args: Args,
  extract: boolean,
): Promise<ImmutableInputs> {
  const receiptBytes = await Deno.readFile(args['--source-receipt'])
  const digest = await crypto.subtle.digest(
    'SHA-256',
    receiptBytes.slice().buffer,
  )
  const assemblyReceiptSha256 = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  const assembly = verifySourceMaterialsReceipt(
    JSON.parse(decoder.decode(receiptBytes)),
  )
  const pinsSha256 = await sha256(args['--pins'])
  if (pinsSha256 !== assembly.pins.sha256) {
    throw new Error('pins differ from the immutable source receipt')
  }
  const noticeSha256 = await sha256(args['--notice-file'])
  if (noticeSha256 !== assembly.canonical_notice.sha256) {
    throw new Error('canonical notice differs from immutable source receipt')
  }
  const archives = await resolveSourceArchivePaths(
    args['--slv-source'],
    args['--deno-source'],
    args['--cargo-vendor'],
  )
  for (const name of ASSETS) {
    await verifyArchive(archives[name], assetFor(assembly, name))
  }
  const result: ImmutableInputs = {
    assembly,
    assemblyReceiptSha256,
    pinsSha256,
    noticeSha256,
    sourceAssets: sourceAssets(assembly),
    archives,
  }
  if (!extract) return result

  const root = await ensureEmptyDirectory(args['--source-root'], 'source root')
  const out = await ensureDirectory(args['--out'], 'proof output')
  const extraction: Record<string, CommandReceipt> = {}
  extraction.slv_scan = await scanArchiveForUnsafeMembers(
    archives['slv-source.tar.gz'],
    'slv-source',
    root,
    `${out}/scan-slv.log`,
  )
  extraction.deno_scan = await scanArchiveForUnsafeMembers(
    archives['deno-source.tar.gz'],
    'deno-source',
    root,
    `${out}/scan-deno.log`,
  )
  extraction.vendor_scan = await scanArchiveForUnsafeMembers(
    archives['deno-cargo-vendor.tar.gz'],
    'deno-cargo-vendor',
    root,
    `${out}/scan-vendor.log`,
  )
  extraction.slv = await extractArchive(
    archives['slv-source.tar.gz'],
    root,
    'slv-source',
    `${out}/extract-slv.log`,
  )
  extraction.deno = await extractArchive(
    archives['deno-source.tar.gz'],
    root,
    'deno-source',
    `${out}/extract-deno.log`,
  )
  extraction.vendor = await extractArchive(
    archives['deno-cargo-vendor.tar.gz'],
    root,
    'deno-cargo-vendor',
    `${out}/extract-vendor.log`,
  )
  for (const name of ['slv-source', 'deno-source', 'deno-cargo-vendor']) {
    await verifyEmbeddedMaterials(`${root}/${name}`, assembly, noticeSha256)
  }
  await verifyRuntimeSecurityEvidence(`${root}/deno-source`, assembly)
  for (
    const required of [
      'deno-source/deno/Cargo.lock',
      'deno-source/rusty_v8/v8/BUILD.gn',
      'deno-cargo-vendor/vendor',
      'deno-cargo-vendor/Cargo.lock',
      'slv-source/deno-cache',
      'slv-source/source-rebuild/build-baseline-denort.sh',
      'slv-source/source-rebuild/glibc-sin-sentinel.patch',
    ]
  ) {
    if (!await Deno.lstat(`${root}/${required}`).catch(() => undefined)) {
      throw new Error(`extracted source material lacks ${required}`)
    }
  }
  result.sourceRoot = root
  result.extraction = extraction
  return result
}

export async function readTools(
  path: string,
  target: string,
  purpose: 'build' | 'execution',
  expectedBuildHost: string,
): Promise<ToolReceipt> {
  const value = object(
    JSON.parse(await Deno.readTextFile(path)),
    'tools receipt',
  )
  if (
    value.schema_version !== 1 || value.kind !== 'slv-native-toolchain' ||
    value.target !== target || value.purpose !== purpose ||
    value.build_host !== expectedBuildHost
  ) {
    throw new Error(
      'tool receipt target, host, or purpose does not match this phase',
    )
  }
  const pins = object(value.pins, 'tool receipt pins')
  const descriptor = object(
    value.target_descriptor,
    'tool receipt target descriptor',
  )
  const descriptorPath = text(
    descriptor.path,
    'tool receipt target descriptor path',
  )
  await regularFile(descriptorPath, 'tool receipt target descriptor')
  if (
    await sha256(descriptorPath) !==
      sha(descriptor.sha256, 'target tool descriptor digest')
  ) {
    throw new Error('target descriptor bytes differ from the tool receipt')
  }
  const archivesValue = object(value.archives, 'tool receipt archives')
  const archives: ToolReceipt['archives'] = {}
  for (const [name, rawArchive] of Object.entries(archivesValue)) {
    const archive = object(rawArchive, `tool archive ${name}`)
    const url = text(archive.url, `tool archive ${name} URL`)
    if (new URL(url).protocol !== 'https:') {
      throw new Error(`tool archive ${name} URL must use HTTPS`)
    }
    const size = archive.size
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new Error(`tool archive ${name} has invalid size`)
    }
    const includedMembers = archive.included_members
    if (
      includedMembers !== undefined &&
      (!Array.isArray(includedMembers) ||
        includedMembers.some((member) => typeof member !== 'string'))
    ) {
      throw new Error(`tool archive ${name} has invalid scoped member list`)
    }
    archives[name] = {
      url,
      sha256: sha(archive.sha256, `tool archive ${name} digest`),
      size: size as number,
      ...(includedMembers ? { included_members: [...includedMembers] } : {}),
    }
  }
  const environmentValue = object(value.environment, 'tool receipt environment')
  const identitiesValue = object(value.identities, 'tool receipt identities')
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(environmentValue)) {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error(`unsafe tool environment key: ${key}`)
    }
    environment[key] = text(value, `tool environment ${key}`)
  }
  const identities: ToolReceipt['identities'] = {}
  for (const [name, rawIdentity] of Object.entries(identitiesValue)) {
    const identity = object(rawIdentity, `tool identity ${name}`)
    const identityPath = text(identity.path, `tool identity ${name} path`)
    const identitySha256 = sha(identity.sha256, `tool identity ${name} digest`)
    await regularToolIdentity(identityPath, `tool identity ${name}`)
    if (await sha256(identityPath) !== identitySha256) {
      throw new Error(`tool identity changed after receipt generation: ${name}`)
    }
    identities[name] = { path: identityPath, sha256: identitySha256 }
  }
  const covered = (toolPath: string): boolean =>
    Object.values(identities).some((identity) => identity.path === toolPath)
  const required = purpose === 'build'
    ? [
      'RUST_BIN',
      'GN',
      'NINJA',
      'CLANG_BASE_PATH',
      'SLV_LINKER',
      'LIBCLANG_PATH',
      'CHROMIUM_RUST_TOOLCHAIN',
      'DENO_FRONTEND',
      ...(targetHost(target).os === 'linux'
        ? ['DENO_SYSROOT', 'V8_SYSROOT_AMD64', 'V8_SYSROOT_ARM64']
        : []),
      ...(target === 'aarch64-unknown-linux-gnu'
        ? ['CROSS_SYSROOT_AMD64', 'CROSS_SYSROOT_ARM64', 'CROSS_LINKER']
        : []),
    ]
    : [
      'DENO_FRONTEND',
      ...(targetHost(target).os === 'linux' ? ['DENO_SYSROOT'] : []),
    ]
  for (const key of required) {
    if (!environment[key]) throw new Error(`tool receipt lacks ${key}`)
  }
  const libclangName = targetHost(expectedBuildHost).os === 'darwin'
    ? 'libclang.dylib'
    : 'libclang.so'
  const mustBeCovered = purpose === 'build'
    ? [
      environment.GN,
      environment.NINJA,
      environment.DENO_FRONTEND,
      `${environment.RUST_BIN}/rustc`,
      `${environment.RUST_BIN}/cargo`,
      `${environment.CLANG_BASE_PATH}/bin/clang`,
      environment.SLV_LINKER,
      `${environment.LIBCLANG_PATH}/${libclangName}`,
      `${environment.CHROMIUM_RUST_TOOLCHAIN}/bin/rustc`,
      ...(target === 'aarch64-unknown-linux-gnu'
        ? [environment.CROSS_LINKER]
        : []),
    ]
    : [environment.DENO_FRONTEND]
  for (const toolPath of mustBeCovered) {
    if (!covered(toolPath)) {
      throw new Error(
        `tool receipt does not hash-bind required path: ${toolPath}`,
      )
    }
  }
  if (targetHost(target).os === 'linux') {
    const requiredSysroots: Array<[string, string]> = [
      ['deno-sysroot', environment.DENO_SYSROOT],
      ...(purpose === 'build'
        ? [
          ['sysroot-amd64', environment.V8_SYSROOT_AMD64] as [string, string],
          ['sysroot-arm64', environment.V8_SYSROOT_ARM64] as [string, string],
          ...(target === 'aarch64-unknown-linux-gnu'
            ? [
              ['sysroot-amd64', environment.CROSS_SYSROOT_AMD64] as [
                string,
                string,
              ],
              ['sysroot-arm64', environment.CROSS_SYSROOT_ARM64] as [
                string,
                string,
              ],
            ]
            : []),
        ]
        : []),
    ]
    for (const [name, path] of requiredSysroots) {
      await ensureDirectory(path, `Linux ${name}`)
      if (!archives[name]) {
        throw new Error(`Linux tool receipt lacks ${name} archive identity`)
      }
    }
    const scoped = archives['deno-sysroot'].included_members
    const expectedScoped = target === 'x86_64-unknown-linux-gnu'
      ? [
        'sysroot/.env',
        'sysroot/lib',
        'sysroot/lib64',
        'sysroot/usr/include',
        'sysroot/usr/lib',
      ]
      : [
        'sysroot/.env',
        'sysroot/lib',
        'sysroot/usr/include',
        'sysroot/usr/lib',
      ]
    if (!equalJson(scoped, expectedScoped)) {
      throw new Error(
        'Deno ABI sysroot receipt does not record the bounded compiler subset',
      )
    }
  }
  return {
    target,
    build_host: expectedBuildHost,
    purpose,
    pins_sha256: sha(pins.sha256, 'tool pin manifest digest'),
    target_pin_sha256: sha(descriptor.sha256, 'target tool descriptor digest'),
    environment,
    identities,
    archives,
  }
}

type NativeSources = {
  deno: string
  rustyV8: string
  cargoVendor: string
}

type CargoFingerprintContext = 'host-release' | 'target-release'
type CargoFingerprintRecord = {
  context: CargoFingerprintContext
  path: string
  sha256: string
  content_base64: string
}
export type CargoFingerprintCollection = {
  schema_version: 1
  kind: 'slv-cargo-fingerprint-records'
  phase: 'baseline' | 'modified'
  target: string
  runtime_sha256: string
  derived_relink_cargo_lock_sha256: string
  records: CargoFingerprintRecord[]
}

type CargoFingerprintExpectation = Pick<
  CargoFingerprintCollection,
  'phase' | 'target' | 'runtime_sha256' | 'derived_relink_cargo_lock_sha256'
>

const utf8 = new TextDecoder('utf-8', { fatal: true })

function fingerprintContextsForTarget(
  target: string,
): readonly CargoFingerprintContext[] {
  if (!TARGETS.has(target)) {
    throw new Error(`unsupported Cargo fingerprint target: ${target}`)
  }
  // Linux always invokes Cargo with the declared --target while also building
  // host tools. macOS has no --target in the selected recipe, so a target
  // directory there would be unrelated stale output rather than evidence.
  return target.endsWith('linux-gnu')
    ? ['host-release', 'target-release']
    : ['host-release']
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function decodeBase64(value: string, label: string): Uint8Array {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new Error(`${label} is not canonical base64`)
  }
}

function fingerprintPath(value: string, label: string): string {
  if (!value || value.startsWith('/') || value.includes('\\')) {
    throw new Error(`${label} has an unsafe path`)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} has an unsafe path`)
  }
  return value
}

async function fingerprintRecords(
  directory: string,
  context: CargoFingerprintContext,
): Promise<CargoFingerprintRecord[]> {
  const directoryInfo = await Deno.lstat(directory).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  })
  if (!directoryInfo) return []
  if (!directoryInfo.isDirectory || directoryInfo.isSymlink) {
    throw new Error(
      `Cargo fingerprint directory is not a real directory: ${directory}`,
    )
  }
  const records: CargoFingerprintRecord[] = []
  const collect = async (current: string, relative: string): Promise<void> => {
    const entries = []
    for await (const entry of Deno.readDir(current)) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = `${current}/${entry.name}`
      const child = relative ? `${relative}/${entry.name}` : entry.name
      const info = await Deno.lstat(path)
      if (info.isSymlink) {
        throw new Error(`Cargo fingerprint record is a symlink: ${child}`)
      }
      if (info.isDirectory) {
        await collect(path, child)
        continue
      }
      if (!info.isFile) {
        throw new Error(
          `Cargo fingerprint record is not a regular file: ${child}`,
        )
      }
      if (!child.endsWith('.json')) continue
      const bytes = await Deno.readFile(path)
      if (bytes.length === 0) {
        throw new Error(`Cargo fingerprint record is empty: ${child}`)
      }
      try {
        JSON.parse(utf8.decode(bytes))
      } catch {
        throw new Error(`Cargo fingerprint record is not JSON: ${child}`)
      }
      records.push({
        context,
        path: fingerprintPath(child, 'Cargo fingerprint record'),
        sha256: await sha256Bytes(bytes),
        content_base64: base64(bytes),
      })
    }
  }
  await collect(directory, '')
  return records
}

export async function captureCargoFingerprintCollection(
  stage: string,
  expected: CargoFingerprintExpectation,
): Promise<CargoFingerprintCollection> {
  const records = [
    ...await fingerprintRecords(
      `${stage}/target/release/.fingerprint`,
      'host-release',
    ),
    ...await fingerprintRecords(
      `${stage}/target/${expected.target}/release/.fingerprint`,
      'target-release',
    ),
  ].sort((left, right) =>
    `${left.context}/${left.path}`.localeCompare(
      `${right.context}/${right.path}`,
    )
  )
  if (!records.length) {
    throw new Error('source build emitted no Cargo fingerprint JSON records')
  }
  const expectedContexts = fingerprintContextsForTarget(expected.target)
  const observedContexts = new Set(records.map((record) => record.context))
  if (
    observedContexts.size !== expectedContexts.length ||
    expectedContexts.some((context) => !observedContexts.has(context))
  ) {
    throw new Error(
      `source build fingerprint contexts differ for ${expected.target}`,
    )
  }
  return {
    schema_version: 1,
    kind: 'slv-cargo-fingerprint-records',
    ...expected,
    records,
  }
}

export async function verifyCargoFingerprintCollection(
  value: unknown,
  expected: CargoFingerprintExpectation,
): Promise<CargoFingerprintCollection> {
  const record = object(value, 'Cargo fingerprint collection')
  const keys = [
    'schema_version',
    'kind',
    'phase',
    'target',
    'runtime_sha256',
    'derived_relink_cargo_lock_sha256',
    'records',
  ]
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    record.schema_version !== 1 ||
    record.kind !== 'slv-cargo-fingerprint-records' ||
    record.phase !== expected.phase ||
    record.target !== expected.target ||
    sha(record.runtime_sha256, 'Cargo fingerprint runtime SHA-256') !==
      expected.runtime_sha256 ||
    sha(
        record.derived_relink_cargo_lock_sha256,
        'Cargo fingerprint derived Cargo.lock SHA-256',
      ) !== expected.derived_relink_cargo_lock_sha256 ||
    !Array.isArray(record.records) ||
    !record.records.length
  ) {
    throw new Error('Cargo fingerprint collection does not bind this build')
  }
  const seen = new Set<string>()
  const records: CargoFingerprintRecord[] = []
  for (const [index, value] of record.records.entries()) {
    const entry = object(value, `Cargo fingerprint record ${index}`)
    const context = entry.context
    if (context !== 'host-release' && context !== 'target-release') {
      throw new Error(`Cargo fingerprint record ${index} has invalid context`)
    }
    const path = fingerprintPath(
      text(entry.path, `Cargo fingerprint record ${index} path`),
      `Cargo fingerprint record ${index}`,
    )
    if (!path.endsWith('.json')) {
      throw new Error(`Cargo fingerprint record ${index} is not JSON path`)
    }
    const content = text(
      entry.content_base64,
      `Cargo fingerprint record ${index} content`,
    )
    const bytes = decodeBase64(content, `Cargo fingerprint record ${index}`)
    if (base64(bytes) !== content) {
      throw new Error(
        `Cargo fingerprint record ${index} is not canonical base64`,
      )
    }
    try {
      JSON.parse(utf8.decode(bytes))
    } catch {
      throw new Error(`Cargo fingerprint record ${index} is not JSON`)
    }
    const digest = sha(
      entry.sha256,
      `Cargo fingerprint record ${index} SHA-256`,
    )
    if (await sha256Bytes(bytes) !== digest) {
      throw new Error(
        `Cargo fingerprint record ${index} digest differs from bytes`,
      )
    }
    const identity = `${context}/${path}`
    if (seen.has(identity)) {
      throw new Error(
        `Cargo fingerprint collection has duplicate record: ${identity}`,
      )
    }
    seen.add(identity)
    records.push({ context, path, sha256: digest, content_base64: content })
  }
  const expectedContexts = fingerprintContextsForTarget(expected.target)
  const observedContexts = new Set(records.map((record) => record.context))
  if (
    observedContexts.size !== expectedContexts.length ||
    expectedContexts.some((context) => !observedContexts.has(context))
  ) {
    throw new Error(
      `Cargo fingerprint collection contexts differ for ${expected.target}`,
    )
  }
  return {
    ...expected,
    schema_version: 1,
    kind: 'slv-cargo-fingerprint-records',
    records,
  }
}

type ArmObservationFile = {
  path: string
  size: number
  sha256: string
}
type ArmObservationCapture = {
  evidenceOut: string
  status: 'complete' | 'incomplete' | 'configuration-mismatch'
  missing_evidence: string[]
  host: Record<string, unknown>
  consumer: Record<string, unknown>
  snapshot_bundle: Record<string, unknown>
}

const ARM_OBSERVATION_LIMITS = {
  metadata: 512 * 1024,
  gn: 256 * 1024,
  ninja: 512 * 1024,
  bundle: 64 * 1024 * 1024,
  member: 32 * 1024 * 1024,
  members: 1024,
  path: 256,
  table: 128 * 1024,
} as const

function observationAsciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function observationPath(relative: string, label: string): string {
  if (
    !relative || relative.startsWith('/') ||
    relative.split('/').some((part) =>
      !part || part === '.' || part === '..'
    ) || encoder.encode(relative).byteLength > ARM_OBSERVATION_LIMITS.path
  ) throw new Error(`${label} has an unsafe observation path`)
  return relative
}

async function observationRegularFile(
  path: string,
  label: string,
  maximum: number,
  relative = path.slice(path.lastIndexOf('/') + 1),
): Promise<ArmObservationFile> {
  const info = await Deno.lstat(path)
  if (!info.isFile || info.isSymlink || info.size > maximum) {
    throw new Error(`${label} is unavailable or exceeds its observation limit`)
  }
  return {
    path: observationPath(relative, label),
    size: info.size,
    sha256: await sha256(path),
  }
}

function ninjaDefines(bytes: Uint8Array, label: string): string {
  const lines = decoder.decode(bytes).split('\n')
  const matches = lines.filter((line) => /^defines\s*=/.test(line))
  if (matches.length !== 1 || matches[0].trimEnd().endsWith('$')) {
    throw new Error(`${label} lacks one supported complete defines assignment`)
  }
  return matches[0]
}

function macroValue(defines: string, name: string): string | undefined {
  const matches = [
    ...defines.matchAll(
      new RegExp(`(?:^|\\s)-D${name}(?:=([^\\s]+))?(?=\\s|$)`, 'g'),
    ),
  ]
  if (matches.length > 1) throw new Error(`Ninja defines duplicate ${name}`)
  return matches[0] ? matches[0][1] ?? '1' : undefined
}

function v8Architecture(defines: string): boolean {
  const architectures = [
    ...defines.matchAll(
      /(?:^|\s)-D(V8_TARGET_ARCH_[A-Z0-9_]+)(?:=[^\s]+)?(?=\s|$)/g,
    ),
  ].map((match) => match[1])
  if (
    architectures.length !== 1 || architectures[0] !== 'V8_TARGET_ARCH_ARM64'
  ) {
    throw new Error('Ninja defines do not uniquely select V8_TARGET_ARCH_ARM64')
  }
  return true
}

async function elfIdentity(
  path: string,
  label: string,
  relative: string,
): Promise<Record<string, unknown>> {
  const info = await Deno.lstat(path)
  if (!info.isFile || info.isSymlink) {
    throw new Error(`${label} is not a regular executable`)
  }
  const record = {
    path: observationPath(relative, label),
    size: info.size,
    sha256: await sha256(path),
  }
  const file = await Deno.open(path, { read: true })
  try {
    const header = new Uint8Array(64)
    const count = await file.read(header)
    if (
      count !== 64 || header[0] !== 0x7f || header[1] !== 0x45 ||
      header[2] !== 0x4c ||
      header[3] !== 0x46 || header[4] !== 2 || header[5] !== 1
    ) {
      throw new Error(`${label} is not a little-endian ELF64 executable`)
    }
    return {
      ...record,
      elf64_little_endian_machine: header[18] | (header[19] << 8),
      header_base64: base64(header),
    }
  } finally {
    file.close()
  }
}

type SelectedCargoRecord = {
  context: 'host-release' | 'target-release'
  path: string
  sha256: string
  features: unknown
  data: Record<string, unknown>
}

type ActiveCargoRoles = {
  hostSnapshotCompile: SelectedCargoRecord
  hostV8Compile: SelectedCargoRecord
  hostV8Run: SelectedCargoRecord
  hostV8Library: SelectedCargoRecord
  targetSnapshotRun: SelectedCargoRecord
  targetSnapshotLibrary: SelectedCargoRecord
  targetV8Run: SelectedCargoRecord
  targetV8Library: SelectedCargoRecord
}

function cargoData(record: CargoFingerprintRecord): Record<string, unknown> {
  const parsed = JSON.parse(
    decoder.decode(decodeBase64(record.content_base64, 'cargo fingerprint')),
  )
  return object(parsed, `Cargo fingerprint ${record.context}/${record.path}`)
}

function selectedFeatures(
  data: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const raw = data.features
  if (typeof raw !== 'string') {
    throw new Error('Cargo fingerprint features are not a raw string')
  }
  if (encoder.encode(raw).byteLength > 16 * 1024) {
    throw new Error(
      'Cargo fingerprint raw feature value exceeds its observation limit',
    )
  }
  const runRecord = /\/run-build-script-build-script-build\.json$/.test(path)
  if (runRecord) {
    if (raw !== '') {
      throw new Error('Cargo run record has declared feature information')
    }
    return { raw, normalized: null, state: 'unavailable-by-run' }
  }
  if (!raw) {
    throw new Error('Cargo compiled or library record has empty feature data')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('Cargo fingerprint feature string is invalid JSON')
  }
  if (
    !Array.isArray(decoded) || decoded.length > 256 ||
    !decoded.every((value) =>
      typeof value === 'string' && encoder.encode(value).byteLength <= 256
    )
  ) {
    throw new Error(
      'Cargo fingerprint feature string is not a bounded string list',
    )
  }
  const normalized = [...decoded].sort()
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Cargo fingerprint feature string has duplicate entries')
  }
  return { raw, normalized, state: 'declared' }
}

function selectCargoRecord(
  fingerprints: CargoFingerprintCollection,
  context: 'host-release' | 'target-release',
  pattern: RegExp,
  label: string,
): SelectedCargoRecord {
  const records = fingerprints.records.filter((record) =>
    record.context === context && pattern.test(record.path)
  )
  if (records.length !== 1) throw new Error(`${label} is missing or ambiguous`)
  const record = records[0]
  const data = cargoData(record)
  return {
    context: record.context,
    path: record.path,
    sha256: record.sha256,
    features: selectedFeatures(data, record.path),
    data,
  }
}

function selectedRecordValue(
  record: SelectedCargoRecord,
): Record<string, unknown> {
  return {
    context: record.context,
    path: record.path,
    sha256: record.sha256,
    features: record.features,
    local: record.data.local ?? null,
    dependencies: record.data.deps ?? null,
  }
}

function cargoCrateDirectory(record: SelectedCargoRecord): string {
  const slash = record.path.indexOf('/')
  if (slash < 1) throw new Error('Cargo fingerprint path lacks crate directory')
  return record.path.slice(0, slash)
}

function outputFromRunRecord(
  record: SelectedCargoRecord,
  target: string,
): string {
  const local = record.data.local
  if (!Array.isArray(local)) {
    throw new Error('snapshot run record has invalid local output linkage')
  }
  const outputs: string[] = []
  for (const entry of local) {
    const rerun = object(entry, 'snapshot run record local').RerunIfChanged
    if (rerun === undefined) continue
    outputs.push(text(
      object(rerun, 'snapshot run record RerunIfChanged').output,
      'snapshot run record output',
    ))
  }
  if (outputs.length !== 1) {
    throw new Error('snapshot run record lacks one unambiguous output linkage')
  }
  const output = outputs[0]
  const expected = record.context === 'host-release'
    ? `release/build/${cargoCrateDirectory(record)}/output`
    : `${target}/release/build/${cargoCrateDirectory(record)}/output`
  if (
    output !== expected ||
    output.split('/').some((part) => part === '..' || !part)
  ) {
    throw new Error(
      'snapshot run record output is outside the selected target build tree',
    )
  }
  return output.slice(0, -'/output'.length)
}

function checkDepInfo(record: SelectedCargoRecord, target: string): void {
  const local = record.data.local
  if (!Array.isArray(local)) {
    throw new Error('Cargo fingerprint lacks local dep-info linkage')
  }
  const entries = local.filter((entry) =>
    object(entry, 'Cargo fingerprint local').CheckDepInfo !== undefined
  )
  if (entries.length !== 1) {
    throw new Error('Cargo fingerprint lacks one dep-info linkage')
  }
  const value = text(
    object(
      object(entries[0], 'Cargo fingerprint local').CheckDepInfo,
      'Cargo CheckDepInfo',
    ).dep_info,
    'Cargo dep-info path',
  )
  const prefix = record.context === 'host-release'
    ? `release/.fingerprint/${cargoCrateDirectory(record)}/`
    : `${target}/release/.fingerprint/${cargoCrateDirectory(record)}/`
  if (!value.startsWith(prefix) || value.includes('..')) {
    throw new Error('Cargo dep-info linkage is outside its selected context')
  }
}

function activeCargoRoles(
  fingerprints: CargoFingerprintCollection,
  target: string,
): ActiveCargoRoles {
  const roles = {
    hostSnapshotCompile: selectCargoRecord(
      fingerprints,
      'host-release',
      /^deno_snapshots-[^/]+\/build-script-build-script-build\.json$/,
      'host deno_snapshots compiled build script',
    ),
    hostV8Compile: selectCargoRecord(
      fingerprints,
      'host-release',
      /^v8-[^/]+\/build-script-build-script-build\.json$/,
      'host V8 compiled build script',
    ),
    hostV8Run: selectCargoRecord(
      fingerprints,
      'host-release',
      /^v8-[^/]+\/run-build-script-build-script-build\.json$/,
      'host V8 run build script',
    ),
    hostV8Library: selectCargoRecord(
      fingerprints,
      'host-release',
      /^v8-[^/]+\/lib-v8\.json$/,
      'host V8 library',
    ),
    targetSnapshotRun: selectCargoRecord(
      fingerprints,
      'target-release',
      /^deno_snapshots-[^/]+\/run-build-script-build-script-build\.json$/,
      'target deno_snapshots run build script',
    ),
    targetSnapshotLibrary: selectCargoRecord(
      fingerprints,
      'target-release',
      /^deno_snapshots-[^/]+\/lib-deno_snapshots\.json$/,
      'target deno_snapshots library',
    ),
    targetV8Run: selectCargoRecord(
      fingerprints,
      'target-release',
      /^v8-[^/]+\/run-build-script-build-script-build\.json$/,
      'target V8 run build script',
    ),
    targetV8Library: selectCargoRecord(
      fingerprints,
      'target-release',
      /^v8-[^/]+\/lib-v8\.json$/,
      'target V8 library',
    ),
  }
  for (
    const record of [
      roles.hostSnapshotCompile,
      roles.hostV8Compile,
      roles.hostV8Library,
      roles.targetSnapshotLibrary,
      roles.targetV8Library,
    ]
  ) checkDepInfo(record, target)
  for (
    const record of [
      roles.hostV8Run,
      roles.targetSnapshotRun,
      roles.targetV8Run,
    ]
  ) outputFromRunRecord(record, target)
  return roles
}

async function activeSnapshotOutDir(
  output: string,
  target: string,
  fingerprints: CargoFingerprintCollection,
): Promise<{
  directory: string
  relative: string
  hostBuildDirectory: string
  hostBuildRelative: string
  roles: ActiveCargoRoles
  cargo: Record<string, unknown>
}> {
  const roles = activeCargoRoles(fingerprints, target)
  const relative = outputFromRunRecord(roles.targetSnapshotRun, target)
  const hostDirectory = cargoCrateDirectory(roles.hostSnapshotCompile)
  const directory = `${output}/target/${relative}/out`
  const info = await Deno.lstat(directory)
  if (!info.isDirectory || info.isSymlink) {
    throw new Error('active deno_snapshots OUT_DIR is unavailable')
  }
  return {
    directory,
    relative: `target/${relative}/out`,
    hostBuildDirectory: `${output}/target/release/build/${hostDirectory}`,
    hostBuildRelative: `target/release/build/${hostDirectory}`,
    roles,
    cargo: Object.fromEntries(
      Object.entries(roles).map((
        [name, record],
      ) => [name, selectedRecordValue(record)]),
    ),
  }
}

async function residualSourcePaths(table: string): Promise<string[]> {
  const bytes = await Deno.readFile(table)
  if (bytes.byteLength > ARM_OBSERVATION_LIMITS.table) {
    throw new Error('residual source table exceeds capture limit')
  }
  const found: string[] = []
  for (
    const match of decoder.decode(bytes).matchAll(
      /residual_sources\/([A-Za-z0-9._/-]+)/g,
    )
  ) {
    found.push(
      observationPath(`residual_sources/${match[1]}`, 'residual source table'),
    )
  }
  if (!found.length || new Set(found).size !== found.length) {
    throw new Error('residual source table has missing or duplicate members')
  }
  return found.sort(observationAsciiCompare)
}

async function regularTreeFiles(
  root: string,
  relative = '',
): Promise<string[]> {
  const info = await Deno.lstat(root)
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(
      `snapshot tree component is not a real directory: ${relative || '.'}`,
    )
  }
  const entries = []
  for await (const entry of Deno.readDir(root)) entries.push(entry)
  entries.sort((a, b) => observationAsciiCompare(a.name, b.name))
  const result: string[] = []
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    const path = `${root}/${entry.name}`
    const childInfo = await Deno.lstat(path)
    if (childInfo.isSymlink) {
      throw new Error(`snapshot tree contains symlink: ${child}`)
    }
    if (childInfo.isDirectory) {
      result.push(...await regularTreeFiles(path, child))
    } else if (childInfo.isFile) {
      result.push(observationPath(child, 'snapshot tree'))
    } else {throw new Error(
        `snapshot tree contains non-regular member: ${child}`,
      )}
  }
  return result.sort(observationAsciiCompare)
}

async function captureSnapshotBundle(
  output: string,
  target: string,
  evidenceOut: string,
  fingerprints: CargoFingerprintCollection,
): Promise<Record<string, unknown>> {
  const active = await activeSnapshotOutDir(output, target, fingerprints)
  const table = `${active.directory}/EXTENSION_RESIDUAL_SOURCES.rs`
  const source = `${active.directory}/CLI_SNAPSHOT.bin`
  const names = await residualSourcePaths(table)
  const discovered = await regularTreeFiles(
    `${active.directory}/residual_sources`,
    'residual_sources',
  )
  if (!equalJson(discovered, names)) {
    throw new Error('snapshot residual tree does not exactly match its table')
  }
  const requested = [
    'CLI_SNAPSHOT.bin',
    'EXTENSION_RESIDUAL_SOURCES.rs',
    ...names,
  ].sort(observationAsciiCompare)
  if (requested.length > ARM_OBSERVATION_LIMITS.members) {
    throw new Error('snapshot bundle has too many members')
  }
  const preflight: Array<{ relative: string; source: string; size: number }> =
    []
  let total = 0
  for (const relative of requested) {
    const full = `${active.directory}/${relative}`
    const info = await Deno.lstat(full)
    if (
      !info.isFile || info.isSymlink ||
      info.size > ARM_OBSERVATION_LIMITS.member
    ) throw new Error(`snapshot member is invalid or oversized: ${relative}`)
    total += info.size
    preflight.push({ relative, source: full, size: info.size })
  }
  if (total > ARM_OBSERVATION_LIMITS.bundle) {
    throw new Error('snapshot bundle exceeds capture limit')
  }
  // Inventory identities are measured from the active OUT_DIR. Raw bundle
  // copies are deliberately absent: duplicating the generated snapshot is not
  // needed to bind this producer observation and would consume runner disk.
  const members: ArmObservationFile[] = []
  for (const member of preflight) {
    members.push(
      await observationRegularFile(
        member.source,
        `snapshot ${member.relative}`,
        ARM_OBSERVATION_LIMITS.member,
        member.relative,
      ),
    )
  }
  const bytes = await Deno.readFile(source)
  if (bytes.byteLength < 8) {
    throw new Error('CLI snapshot lacks V8 length footer')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const v8Length = Number(view.getBigUint64(bytes.byteLength - 8, true))
  if (!Number.isSafeInteger(v8Length) || v8Length > bytes.byteLength - 8) {
    throw new Error('CLI snapshot V8 length footer is invalid')
  }
  const inventory = {
    active_out_dir_relative: active.relative,
    members: members.sort((a, b) => observationAsciiCompare(a.path, b.path)),
  }
  const inventoryBytes = encoder.encode(
    JSON.stringify(inventory, null, 2) + '\n',
  )
  const inventorySha256 = await sha256Bytes(inventoryBytes)
  await Deno.writeFile(
    `${evidenceOut}/snapshot-bundle-manifest.json`,
    inventoryBytes,
  )
  return {
    ...inventory,
    inventory_sha256: inventorySha256,
    cargo_records: active.cargo,
    v8_payload: {
      size: v8Length,
      sha256: await sha256Bytes(bytes.subarray(0, v8Length)),
    },
    sidecar: {
      size: bytes.byteLength - 8 - v8Length,
      sha256: await sha256Bytes(bytes.subarray(v8Length, bytes.byteLength - 8)),
    },
    whole_cli_snapshot: {
      size: bytes.byteLength,
      sha256: await sha256Bytes(bytes),
    },
  }
}

function declaredGnValues(
  bytes: Uint8Array,
  label: string,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of decoder.decode(bytes).split('\n')) {
    const match = /^([a-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    if (values[match[1]] !== undefined) {
      throw new Error(`${label} has duplicate declared ${match[1]}`)
    }
    values[match[1]] = match[2]
  }
  return values
}

export async function captureArmObservation(
  output: string,
  target: string,
  evidenceOut: string | undefined,
  fingerprints: CargoFingerprintCollection,
): Promise<ArmObservationCapture | undefined> {
  if (target !== 'aarch64-unknown-linux-gnu' || !evidenceOut) return undefined
  const missing: string[] = []
  let active: Awaited<ReturnType<typeof activeSnapshotOutDir>> | undefined
  let snapshot_bundle: Record<string, unknown> = { status: 'unavailable' }
  let hostExecutable =
    `${output}/target/release/build/deno_snapshots-unavailable/build-script-build`
  let hostRelative =
    'target/release/build/deno_snapshots-unavailable/build-script-build'
  try {
    active = await activeSnapshotOutDir(output, target, fingerprints)
    hostExecutable = `${active.hostBuildDirectory}/build-script-build`
    hostRelative = `${active.hostBuildRelative}/build-script-build`
    snapshot_bundle = await captureSnapshotBundle(
      output,
      target,
      evidenceOut,
      fingerprints,
    )
  } catch (error) {
    missing.push(
      `snapshot bundle: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const captureContext = async (
    context: 'host' | 'consumer',
    expectedMachine: number,
    expectedSimulator: boolean,
    executable: string,
    executableRelative: string,
    cargoRecords: SelectedCargoRecord[],
  ): Promise<Record<string, unknown>> => {
    const raw = {
      args: `${evidenceOut}/${context}-args.gn`,
      ninja: `${evidenceOut}/${context}-rusty_v8.ninja`,
    }
    try {
      const args = await observationRegularFile(
        raw.args,
        `${context} args.gn`,
        ARM_OBSERVATION_LIMITS.gn,
        `${context}-args.gn`,
      )
      const ninja = await observationRegularFile(
        raw.ninja,
        `${context} Ninja`,
        ARM_OBSERVATION_LIMITS.ninja,
        `${context}-rusty_v8.ninja`,
      )
      const declared = declaredGnValues(
        await Deno.readFile(raw.args),
        `${context} args.gn`,
      )
      const defines = ninjaDefines(
        await Deno.readFile(raw.ninja),
        `${context} Ninja`,
      )
      const identity = await elfIdentity(
        executable,
        `${context} executable`,
        executableRelative,
      )
      const simulator = macroValue(defines, 'USE_SIMULATOR') !== undefined
      const targetArm = v8Architecture(defines)
      const settings = Object.fromEntries([
        'V8_COMPRESS_POINTERS',
        'V8_ENABLE_SANDBOX',
        'V8_STATIC_ROOTS',
        'V8_STATIC_ROOTS_GENERATION',
        'V8_ENABLE_EXTENSIBLE_RO_SNAPSHOT',
      ].map((name) => {
        const raw = macroValue(defines, name)
        return [name, { enabled: raw !== undefined, raw_token: raw ?? null }]
      }))
      // ninjaDefines has already established that this is one complete,
      // non-continued assignment. Optional feature macros are therefore false
      // only here, when they are absent from that complete observed assignment.
      const configured =
        identity.elf64_little_endian_machine === expectedMachine && targetArm &&
        simulator === expectedSimulator
      if (!configured) {
        missing.push(
          `${context} compiled configuration contradicts ARM simulator expectation`,
        )
      }
      return {
        declared_gn_arguments: declared,
        files: [args, ninja],
        executable_identity: identity,
        cargo_records: cargoRecords.map(selectedRecordValue),
        effective_semantics: {
          v8_target_arch_arm64: targetArm,
          use_simulator: simulator,
          compiled_settings: settings,
          ninja_defines_sha256: await sha256(raw.ninja),
        },
      }
    } catch (error) {
      missing.push(
        `${context}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { status: 'unavailable' }
    }
  }
  const host = await captureContext(
    'host',
    62,
    true,
    hostExecutable,
    hostRelative,
    active
      ? [
        active.roles.hostSnapshotCompile,
        active.roles.hostV8Compile,
        active.roles.hostV8Run,
        active.roles.hostV8Library,
      ]
      : [],
  )
  const consumer = await captureContext(
    'consumer',
    183,
    false,
    `${output}/target/${target}/release/denort`,
    `target/${target}/release/denort`,
    active
      ? [
        active.roles.targetSnapshotRun,
        active.roles.targetSnapshotLibrary,
        active.roles.targetV8Run,
        active.roles.targetV8Library,
      ]
      : [],
  )
  const hostSettings =
    (host.effective_semantics as Record<string, unknown> | undefined)
      ?.compiled_settings
  const consumerSettings =
    (consumer.effective_semantics as Record<string, unknown> | undefined)
      ?.compiled_settings
  if (
    hostSettings && consumerSettings &&
    !equalJson(hostSettings, consumerSettings)
  ) {
    missing.push('host and consumer compiled V8 settings differ')
  }
  const status =
    missing.some((value) =>
        value.includes('contradicts') || value.includes('settings differ')
      )
      ? 'configuration-mismatch'
      : missing.length
      ? 'incomplete'
      : 'complete'
  return {
    evidenceOut,
    status,
    missing_evidence: missing,
    host,
    consumer,
    snapshot_bundle,
  }
}

function compactCargoReference(value: unknown): Record<string, unknown> {
  const record = object(value, 'ARM selected Cargo record')
  const local = Array.isArray(record.local) ? record.local : []
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies
    : []
  const output: string[] = []
  const depInfo: string[] = []
  for (const entry of local) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const rerun = row.RerunIfChanged
    if (rerun && typeof rerun === 'object' && !Array.isArray(rerun)) {
      const candidate = (rerun as Record<string, unknown>).output
      if (typeof candidate === 'string') output.push(candidate)
    }
    const check = row.CheckDepInfo
    if (check && typeof check === 'object' && !Array.isArray(check)) {
      const candidate = (check as Record<string, unknown>).dep_info
      if (typeof candidate === 'string') depInfo.push(candidate)
    }
  }
  return {
    context: record.context,
    path: record.path,
    sha256: record.sha256,
    features: record.features,
    local_entry_count: local.length,
    dependency_count: dependencies.length,
    output: output.length === 1 ? output[0] : null,
    dep_info: depInfo.length === 1 ? depInfo[0] : null,
    summary_status: 'reference-only',
  }
}

function compactArmValue(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value.status === 'unavailable') return { status: 'unavailable' }
  return {
    files: value.files,
    executable_identity: value.executable_identity,
    effective_semantics: value.effective_semantics,
    cargo_records: Array.isArray(value.cargo_records)
      ? value.cargo_records.map(compactCargoReference)
      : [],
  }
}

function compactArmBundle(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value.status === 'unavailable') return { status: 'unavailable' }
  const cargo = value.cargo_records
  return {
    active_out_dir_relative: value.active_out_dir_relative,
    members: value.members,
    inventory_sha256: value.inventory_sha256,
    v8_payload: value.v8_payload,
    sidecar: value.sidecar,
    whole_cli_snapshot: value.whole_cli_snapshot,
    cargo_records: cargo && typeof cargo === 'object' && !Array.isArray(cargo)
      ? Object.fromEntries(
        Object.entries(cargo as Record<string, unknown>).map((
          [name, record],
        ) => [name, compactCargoReference(record)]),
      )
      : {},
  }
}

function armObservationDiagnostic(
  operation: string,
  error: unknown,
): { operation: string; error: string } {
  const text = error instanceof Error ? error.message : String(error)
  const diagnostic = { operation, error: text.slice(0, 128) }
  console.error(
    'SLV_ARM_OBSERVATION_CAPTURE_ERROR ' + JSON.stringify(diagnostic),
  )
  return diagnostic
}

function boundedArmErrors(values: unknown[]): string[] {
  const errors: string[] = []
  for (const value of values) {
    if (
      typeof value === 'string' &&
      /^[A-Za-z0-9_.:-]{1,128}$/.test(value) &&
      !errors.includes(value) &&
      errors.length < 16
    ) errors.push(value)
  }
  return errors
}

type ArmStateSnapshot = {
  state: Record<string, unknown> | undefined
  errors: string[]
  lastPhase: string
  bindingConflict: Record<string, unknown> | undefined
}

function canonicalArmBinding(
  binding: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source_commit: binding.source_commit,
    source_receipt_sha256: binding.source_receipt_sha256,
    recipe_sha256: binding.recipe_sha256,
    target: binding.target,
    build_host: binding.build_host,
    variant: binding.variant,
    producer_context: binding.producer_context,
  }
}

async function armStateSnapshot(
  evidenceOut: string,
  binding: Record<string, unknown>,
): Promise<ArmStateSnapshot> {
  const path = evidenceOut + '/compilation-state.json'
  let state: Record<string, unknown>
  try {
    const info = await Deno.lstat(path)
    if (!info.isFile || info.isSymlink || info.size > 64 * 1024) {
      throw new Error('not-regular')
    }
    state = object(JSON.parse(await Deno.readTextFile(path)), 'ARM state')
    const captureError = state.capture_error
    const captureErrors = state.capture_errors
    const phase = state.phase
    const lastPhase = state.last_observed_phase
    if (
      state.schema_version !== 1 ||
      state.kind !== 'slv-arm-snapshot-build-observation-state' ||
      !['started', 'incomplete', 'complete'].includes(state.status as string) ||
      typeof phase !== 'string' ||
      ![
        'initial',
        'guarded-cargo-start',
        'guarded-cargo-finished',
        'raw-capture',
        'unavailable',
        'finished',
      ].includes(phase) ||
      (
        lastPhase !== undefined &&
        (
          typeof lastPhase !== 'string' ||
          ![
            'initial',
            'guarded-cargo-start',
            'guarded-cargo-finished',
            'raw-capture',
            'unavailable',
            'finished',
          ].includes(lastPhase)
        )
      ) ||
      typeof state.monotonic_started !== 'number' ||
      !Number.isFinite(state.monotonic_started) ||
      state.monotonic_started < 0 ||
      (
        state.monotonic_elapsed_seconds !== undefined &&
        (
          typeof state.monotonic_elapsed_seconds !== 'number' ||
          !Number.isFinite(state.monotonic_elapsed_seconds) ||
          state.monotonic_elapsed_seconds < 0
        )
      ) ||
      (
        captureError !== undefined &&
        (
          typeof captureError !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(captureError)
        )
      ) ||
      (
        captureErrors !== undefined &&
        (
          !Array.isArray(captureErrors) ||
          captureErrors.length > 16 ||
          !captureErrors.every((value) =>
            typeof value === 'string' &&
            /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
          ) ||
          new Set(captureErrors).size !== captureErrors.length
        )
      ) ||
      (
        state.binding !== undefined &&
        (
          !state.binding ||
          typeof state.binding !== 'object' ||
          Array.isArray(state.binding)
        )
      ) ||
      (state.binding === undefined && state.identity_status !== 'unavailable')
    ) {
      throw new Error('invalid')
    }
  } catch (error) {
    const kind = error instanceof Deno.errors.NotFound
      ? 'state-missing'
      : 'state-invalid'
    return {
      state: undefined,
      errors: [kind],
      lastPhase: 'unavailable',
      bindingConflict: undefined,
    }
  }
  const errors = boundedArmErrors([
    state.capture_error,
    ...(state.capture_errors as string[] | undefined ?? []),
    ...(state.status === 'incomplete' ? ['state-incomplete'] : []),
  ])
  if (state.identity_status === 'unavailable') {
    errors.push('identity-unavailable')
  }
  const stateBinding = state.binding as Record<string, unknown> | undefined
  let bindingConflict: Record<string, unknown> | undefined
  if (
    stateBinding &&
    !equalJson(
      canonicalArmBinding(stateBinding),
      canonicalArmBinding(binding),
    )
  ) {
    errors.push('binding-conflict')
    bindingConflict = {
      sha256: await sha256Bytes(encoder.encode(stableJson(stateBinding))),
      status: state.status,
    }
  }
  return {
    state,
    errors: boundedArmErrors(errors),
    lastPhase:
      (typeof state.last_observed_phase === 'string'
        ? state.last_observed_phase
        : state.phase) as string,
    bindingConflict,
  }
}

async function atomicArmWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = path + '.tmp-' + crypto.randomUUID()
  try {
    await Deno.writeFile(temporary, bytes, { createNew: true })
    await Deno.rename(temporary, path)
  } finally {
    await Deno.remove(temporary).catch(() => undefined)
  }
}

function armStateDocument(
  prior: ArmStateSnapshot,
  binding: Record<string, unknown>,
  status: 'complete' | 'incomplete',
  phase: string,
  errors: string[],
  additions: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(prior.state ?? {
      schema_version: 1,
      kind: 'slv-arm-snapshot-build-observation-state',
      monotonic_started: null,
    }),
    ...additions,
    binding,
    status,
    phase,
    last_observed_phase: prior.lastPhase,
    capture_errors: errors,
    ...(prior.bindingConflict
      ? { observed_binding_conflict: prior.bindingConflict }
      : {}),
  }
}

async function writeArmObservation(
  capture: ArmObservationCapture | undefined,
  binding: Record<string, unknown>,
  afterMetadataWrite?: () => Promise<void>,
): Promise<void> {
  if (!capture) return
  const prior = await armStateSnapshot(capture.evidenceOut, binding)
  const inherited = boundedArmErrors([
    ...prior.errors,
    ...(capture.status === 'complete' ? [] : ['capture-incomplete']),
  ])
  const complete = inherited.length === 0 && capture.status === 'complete'
  const status = complete ? 'complete' : 'incomplete'
  const payload = {
    schema_version: 1,
    kind: 'slv-arm-snapshot-build-observation',
    ...binding,
    status,
    phase: prior.lastPhase,
    last_observed_phase: prior.lastPhase,
    host: compactArmValue(capture.host),
    consumer: compactArmValue(capture.consumer),
    snapshot_bundle: compactArmBundle(capture.snapshot_bundle),
    missing_evidence: capture.missing_evidence,
    capture_errors: inherited,
    ...(prior.bindingConflict
      ? { observed_binding_conflict: prior.bindingConflict }
      : {}),
  }
  const metadata = (metadataErrors: string[]) =>
    encoder.encode(
      JSON.stringify(
        {
          ...payload,
          status: metadataErrors.length ? 'incomplete' : status,
          capture_errors: metadataErrors,
        },
        null,
        2,
      ) + '\n',
    )
  if (metadata(inherited).byteLength > ARM_OBSERVATION_LIMITS.metadata) {
    throw new Error('ARM compilation metadata exceeds its observation limit')
  }
  const writeErrors: string[] = []
  let metadataWritten = false
  try {
    await atomicArmWrite(
      capture.evidenceOut + '/compilation-metadata.json',
      metadata(inherited),
    )
    metadataWritten = true
    if (afterMetadataWrite) await afterMetadataWrite()
  } catch (error) {
    writeErrors.push(
      armObservationDiagnostic('metadata-write', error).operation,
    )
  }
  const errors = boundedArmErrors([...inherited, ...writeErrors])
  try {
    const state = armStateDocument(
      prior,
      binding,
      errors.length ? 'incomplete' : status,
      errors.length ? prior.lastPhase : 'finished',
      errors,
      {
        missing_evidence: capture.missing_evidence,
        raw_capture_status: capture.status === 'complete'
          ? 'raw-capture-complete'
          : 'raw-capture-incomplete',
        ...(typeof binding.original_build_exit_code === 'number'
          ? { original_build_exit_code: binding.original_build_exit_code }
          : {}),
      },
    )
    await atomicArmWrite(
      capture.evidenceOut + '/compilation-state.json',
      encoder.encode(JSON.stringify(state, null, 2) + '\n'),
    )
  } catch (error) {
    writeErrors.push(armObservationDiagnostic('state-write', error).operation)
  }
  const finalErrors = boundedArmErrors([...errors, ...writeErrors])
  if (metadataWritten && writeErrors.includes('state-write')) {
    try {
      await atomicArmWrite(
        capture.evidenceOut + '/compilation-metadata.json',
        metadata(finalErrors),
      )
    } catch (error) {
      armObservationDiagnostic('metadata-rewrite', error)
    }
  }
  if (finalErrors.length || capture.status !== 'complete') {
    throw new Error('ARM compilation observation is incomplete')
  }
}

export const internalWriteArmObservation = writeArmObservation

function armObservationBinding(
  inputs: ImmutableInputs,
  target: string,
  buildHost: string,
  variant: Variant,
  producer: ProducerContext | null,
): Record<string, unknown> {
  return {
    source_commit: inputs.assembly.source.commit,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    target,
    build_host: targetHost(buildHost),
    variant,
    producer_context: producer,
  }
}

async function armFailureRawReference(
  evidenceOut: string,
): Promise<Record<string, unknown>> {
  const path = evidenceOut + '/raw-capture.json'
  try {
    await regularFile(path, 'ARM raw capture')
    const info = await Deno.stat(path)
    return {
      path: 'raw-capture.json',
      size: info.size,
      sha256: await sha256(path),
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error
        ? error.message.slice(0, 128)
        : 'unavailable',
    }
  }
}

async function recordArmBuildFailure(
  evidenceOut: string | undefined,
  binding: Record<string, unknown> | undefined,
  observed: ObservedCommandResult | undefined,
  reason: string,
): Promise<void> {
  if (!evidenceOut || !binding) return
  const prior = await armStateSnapshot(evidenceOut, binding)
  const errors = boundedArmErrors([
    ...prior.errors,
    observed ? 'source-command-failed' : 'source-result-unavailable',
  ])
  const timing = observed
    ? {
      started_at: observed.started_at,
      finished_at: observed.finished_at,
      elapsed_seconds: observed.elapsed_seconds,
    }
    : { status: 'unavailable' }
  const rawCapture = await armFailureRawReference(evidenceOut)
  const payload = {
    schema_version: 1,
    kind: 'slv-arm-snapshot-build-observation',
    ...binding,
    status: 'incomplete',
    phase: prior.lastPhase,
    last_observed_phase: prior.lastPhase,
    original_build_exit_code: observed?.exit_code ?? null,
    original_build_signal: observed?.signal ?? null,
    timing,
    raw_capture: rawCapture,
    capture_errors: errors,
    missing_evidence: [reason],
    ...(prior.bindingConflict
      ? { observed_binding_conflict: prior.bindingConflict }
      : {}),
  }
  const writeErrors: string[] = []
  try {
    const bytes = encoder.encode(JSON.stringify(payload, null, 2) + '\n')
    if (bytes.byteLength > ARM_OBSERVATION_LIMITS.metadata) {
      throw new Error('failure metadata exceeds its observation limit')
    }
    await atomicArmWrite(evidenceOut + '/compilation-metadata.json', bytes)
  } catch (error) {
    writeErrors.push(
      armObservationDiagnostic('failure-metadata-write', error).operation,
    )
  }
  try {
    const state = armStateDocument(
      prior,
      binding,
      'incomplete',
      prior.lastPhase,
      boundedArmErrors([...errors, ...writeErrors]),
      {
        original_build_exit_code: observed?.exit_code ?? null,
        original_build_signal: observed?.signal ?? null,
        timing,
        raw_capture: rawCapture,
        missing_evidence: [reason],
      },
    )
    await atomicArmWrite(
      evidenceOut + '/compilation-state.json',
      encoder.encode(JSON.stringify(state, null, 2) + '\n'),
    )
  } catch (error) {
    armObservationDiagnostic('failure-state-write', error)
  }
}

async function stageBuild(
  recipeSource: string,
  sources: NativeSources,
  output: string,
  tools: ToolReceipt,
  target: string,
  buildHost: string,
  label: 'baseline' | 'modified',
  jobs: string,
  evidenceOut?: string,
  observationBinding?: Record<string, unknown>,
): Promise<{
  build: CommandReceipt
  denort: string
  v8: string
  ninja: string
  recipe_sha256: string
  recipe_receipt_sha256: string
  derived_relink_cargo_lock: string
  derived_relink_cargo_lock_sha256: string
  runtime_abi: Record<string, unknown>
  runtime_abi_receipt_sha256: string
  cargo_fingerprints: CargoFingerprintCollection
  arm_observation: ArmObservationCapture | undefined
  arm_binding: Record<string, unknown> | undefined
}> {
  const recipeDirectory = `${output}/recipe`
  await Deno.mkdir(recipeDirectory, { recursive: true })
  const recipe = `${recipeDirectory}/build-baseline-denort.sh`
  const preflightSource = `${
    recipeSource.slice(0, recipeSource.lastIndexOf('/'))
  }/linux-sysroot-preflight.sh`
  const preflightRecipe = `${recipeDirectory}/linux-sysroot-preflight.sh`
  await Deno.copyFile(recipeSource, recipe)
  await Deno.copyFile(preflightSource, preflightRecipe)
  await Deno.chmod(recipe, 0o755)
  await Deno.chmod(preflightRecipe, 0o755)
  const recipeSha256 = await sha256(recipe)
  const fullBinding =
    target === 'aarch64-unknown-linux-gnu' && evidenceOut && observationBinding
      ? { ...observationBinding, recipe_sha256: recipeSha256 }
      : undefined
  const armContext = fullBinding ? JSON.stringify(fullBinding) : undefined
  if (armContext && encoder.encode(armContext).byteLength > 16 * 1024) {
    throw new Error(
      'ARM observation context exceeds its bounded recipe handoff',
    )
  }
  const cross = target !== buildHost
  const hostPython = await resolveHostPython()
  const buildEnvironment = Object.fromEntries(
    [
      'RUST_BIN',
      'GN',
      'NINJA',
      'CLANG_BASE_PATH',
      'SLV_LINKER',
      'LIBCLANG_PATH',
      'CHROMIUM_RUST_TOOLCHAIN',
      ...(targetHost(target).os === 'linux'
        ? ['DENO_SYSROOT', 'V8_SYSROOT_AMD64', 'V8_SYSROOT_ARM64']
        : []),
      ...(cross
        ? ['CROSS_SYSROOT_AMD64', 'CROSS_SYSROOT_ARM64', 'CROSS_LINKER']
        : []),
    ].map((key) => [key, tools.environment[key]]),
  ) as Record<string, string>
  const env: Record<string, string> = {
    ...buildEnvironment,
    HOME: `${output}/private-home`,
    PATH: `${
      hostPython.path.slice(0, hostPython.path.lastIndexOf('/'))
    }:/usr/bin:/bin`,
    PYTHON: hostPython.path,
    JOBS: jobs,
    CARGO: `${tools.environment.RUST_BIN}/cargo`,
    RUSTC: `${tools.environment.RUST_BIN}/rustc`,
    GN_ARGS: 'use_glib=false',
    EXTRA_GN_ARGS: 'use_lld=true',
    DENO_SOURCE_DIR: sources.deno,
    RUSTY_V8_SOURCE_DIR: sources.rustyV8,
    CARGO_VENDOR_DIR: sources.cargoVendor,
    ...(armContext ? { SLV_ARM_OBSERVATION_CONTEXT: armContext } : {}),
    ...(targetHost(target).os === 'linux'
      ? {
        BUILD_TARGET: target,
        DENO_SYSROOT_SHA256: tools.archives['deno-sysroot'].sha256,
        V8_SYSROOT_AMD64_SHA256: tools.archives['sysroot-amd64'].sha256,
        V8_SYSROOT_ARM64_SHA256: tools.archives['sysroot-arm64'].sha256,
        ...(cross
          ? {
            CROSS_SYSROOT_AMD64_SHA256: tools.archives['sysroot-amd64'].sha256,
            CROSS_SYSROOT_ARM64_SHA256: tools.archives['sysroot-arm64'].sha256,
          }
          : {}),
      }
      : {}),
  }
  for (const key of ['DEVELOPER_DIR', 'SLV_APPLE_SDK_PATH']) {
    const value = Deno.env.get(key)
    if (value) env[key] = value
  }
  let observed: ObservedCommandResult | undefined
  let build: CommandReceipt
  try {
    build = await streamingCommand(
      Deno.build.os === 'darwin' ? '/bin/bash' : '/usr/bin/bash',
      [
        recipe,
        ...(evidenceOut ? ['--evidence-out', evidenceOut] : []),
        await real(sources.deno.slice(0, sources.deno.lastIndexOf('/'))),
        output,
      ],
      output,
      `${output}/baseline-denort.log`,
      env,
      (result) => {
        observed = result
      },
    )
  } catch (error) {
    await recordArmBuildFailure(
      evidenceOut,
      fullBinding,
      observed,
      observed
        ? 'source command receipt log capture failed'
        : 'source command did not return a result',
    )
    throw error
  }
  if (build.exit_code !== 0) {
    await recordArmBuildFailure(
      evidenceOut,
      fullBinding,
      observed,
      'source build did not complete; partial raw evidence may be retained',
    )
    succeeded(build, `${label} source build`)
  }
  const release = targetHost(target).os === 'linux'
    ? `${output}/target/${target}/release`
    : `${output}/target/release`
  const denort = `${release}/denort`
  const v8 = `${release}/gn_out/obj/librusty_v8.a`
  const ninja = `${release}/gn_out/obj/rusty_v8.ninja`
  for (const [name, path] of Object.entries({ denort, v8, ninja })) {
    await regularFile(path, `${label} ${name}`)
  }
  const recipeReceipt = `${output}/baseline-denort-receipt.env`
  const derivedRelinkCargoLock = `${output}/derived-relink-Cargo.lock`
  await regularFile(recipeReceipt, `${label} build recipe receipt`)
  await regularFile(
    derivedRelinkCargoLock,
    `${label} derived local-V8 relink Cargo.lock`,
  )
  const abiReceipt = targetHost(target).os === 'linux'
    ? `${output}/linux-denort-abi/receipt.json`
    : `${output}/macos-denort-abi/receipt.json`
  await regularFile(abiReceipt, `${label} runtime ABI receipt`)
  const runtimeAbi = object(
    JSON.parse(await Deno.readTextFile(abiReceipt)),
    `${label} runtime ABI receipt`,
  )
  const expectedAbiKind = targetHost(target).os === 'linux'
    ? 'slv-linux-denort-abi'
    : 'slv-macos-denort-abi'
  if (
    runtimeAbi.schema_version !== 1 || runtimeAbi.kind !== expectedAbiKind ||
    runtimeAbi.status !== 'passed' ||
    sha(runtimeAbi.denort_sha256, `${label} ABI denort SHA-256`) !==
      await sha256(denort)
  ) {
    throw new Error(
      `${label} runtime ABI receipt does not bind the built denort`,
    )
  }
  if (targetHost(target).os === 'linux') {
    if (
      runtimeAbi.glibc_private !== 'absent' ||
      runtimeAbi.rpath_or_runpath !== 'absent' ||
      !Array.isArray(runtimeAbi.glibc_versions)
    ) {
      throw new Error(`${label} Linux runtime ABI receipt is incomplete`)
    }
  } else if (runtimeAbi.minimum_os !== '12.0') {
    throw new Error(
      `${label} macOS runtime ABI receipt does not retain minOS 12.0`,
    )
  }
  const derivedRelinkCargoLockSha256 = await sha256(derivedRelinkCargoLock)
  const cargoFingerprints = await captureCargoFingerprintCollection(output, {
    phase: label,
    target,
    runtime_sha256: await sha256(denort),
    derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
  })
  if (target === 'aarch64-unknown-linux-gnu' && evidenceOut) {
    await Deno.writeFile(
      `${evidenceOut}/cargo-fingerprints.json`,
      encoder.encode(JSON.stringify(cargoFingerprints, null, 2) + '\n'),
    )
  }
  const armObservation = await captureArmObservation(
    output,
    target,
    evidenceOut,
    cargoFingerprints,
  )
  return {
    build,
    denort,
    v8,
    ninja,
    recipe_sha256: recipeSha256,
    recipe_receipt_sha256: await sha256(recipeReceipt),
    derived_relink_cargo_lock: derivedRelinkCargoLock,
    derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
    runtime_abi: runtimeAbi,
    runtime_abi_receipt_sha256: await sha256(abiReceipt),
    cargo_fingerprints: cargoFingerprints,
    arm_observation: armObservation,
    arm_binding: fullBinding,
  }
}

async function recordArmObservation(
  stage: {
    arm_observation: ArmObservationCapture | undefined
    arm_binding: Record<string, unknown> | undefined
    recipe_sha256: string
    derived_relink_cargo_lock_sha256: string
    denort: string
    build: CommandReceipt
  },
  inputs: ImmutableInputs,
  target: string,
  buildHost: string,
  variant: Variant,
  producer: ProducerContext | null,
): Promise<void> {
  await writeArmObservation(stage.arm_observation, {
    ...(stage.arm_binding ?? {
      source_commit: inputs.assembly.source.commit,
      source_receipt_sha256: inputs.assemblyReceiptSha256,
      recipe_sha256: stage.recipe_sha256,
      target,
      build_host: targetHost(buildHost),
      variant,
      producer_context: producer,
    }),
    derived_relink_cargo_lock_sha256: stage.derived_relink_cargo_lock_sha256,
    runtime_sha256: await sha256(stage.denort),
    requested: { gn_args: 'use_glib=false', extra_gn_args: 'use_lld=true' },
    timing: {
      started_at: stage.build.started_at,
      finished_at: stage.build.finished_at,
      elapsed_seconds: Math.max(
        0,
        Date.parse(stage.build.finished_at) -
          Date.parse(stage.build.started_at),
      ) / 1000,
    },
    original_build_exit_code: stage.build.exit_code,
    configuration_check: stage.arm_observation?.status === 'complete'
      ? 'passed'
      : 'failed',
  })
}

async function compileProbe(
  frontend: string,
  runtime: string,
  target: string,
  directory: string,
  output: string,
  label: string,
): Promise<CommandReceipt> {
  await Deno.mkdir(directory, { recursive: true })
  const source = `${directory}/math-sin.ts`
  await Deno.writeTextFile(
    source,
    'const x = Number(Deno.args[0]);\nconsole.log(JSON.stringify({ input: x, output: Math.sin(x) }));\n',
  )
  const receipt = await command(
    frontend,
    [
      'compile',
      '--cached-only',
      '--no-prompt',
      '--allow-read',
      '--target',
      target,
      '--output',
      output,
      source,
    ],
    directory,
    `${directory}/${label}-probe-compile.log`,
    {
      DENORT_BIN: runtime,
      DENO_DIR: `${directory}/deno-cache`,
      HOME: `${directory}/private-home`,
    },
  )
  succeeded(receipt, `${label} runtime probe compilation`)
  await regularFile(output, `${label} probe executable`)
  return receipt
}

async function compileSlv(
  extracted: string,
  work: string,
  target: string,
  frontend: string,
  runtime: string,
  executable: string,
  bridgeExecutable: string,
): Promise<{ compile: CommandReceipt; bridge_compile: CommandReceipt }> {
  const app = `${work}/slv-app`
  await copyTree(`${extracted}/slv-source`, app)
  await Deno.mkdir(`${app}/dist/release-inputs`, { recursive: true })
  await Deno.copyFile(
    `${app}/THIRD_PARTY_NOTICES`,
    `${app}/dist/release-inputs/THIRD_PARTY_NOTICES`,
  )
  const env = {
    DENORT_BIN: runtime,
    DENO_DIR: `${app}/deno-cache`,
    HOME: `${work}/private-home`,
  }
  const compile = await command(
    frontend,
    [
      'compile',
      '--frozen',
      '--cached-only',
      '--no-prompt',
      '-A',
      '--include',
      'cli/lib/release/engine.py',
      '--include',
      'dist/release-inputs/THIRD_PARTY_NOTICES',
      '--target',
      target,
      '--output',
      executable,
      'cli/src/index.ts',
    ],
    app,
    `${work}/slv-compile.log`,
    env,
  )
  succeeded(
    compile,
    'SLV compilation through source-built product baseline denort',
  )
  const bridge_compile = await command(
    frontend,
    [
      'compile',
      '--frozen',
      '--cached-only',
      '--no-prompt',
      '-A',
      '--include',
      'cli/lib/release/engine.py',
      '--target',
      target,
      '--output',
      bridgeExecutable,
      'cli/lib/release/compiled_bridge_smoke.ts',
    ],
    app,
    `${work}/bridge-compile.log`,
    env,
  )
  succeeded(bridge_compile, 'compiled release bridge smoke compilation')
  await regularFile(executable, 'compiled SLV executable')
  await regularFile(
    bridgeExecutable,
    'compiled release bridge smoke executable',
  )
  return { compile, bridge_compile }
}

async function copyTransport(
  source: string,
  destination: string,
  executable = true,
): Promise<TransportEntry> {
  await regularFile(source, `transport source ${source}`)
  await Deno.copyFile(source, destination)
  if (executable) await Deno.chmod(destination, 0o755)
  const info = await Deno.stat(destination)
  return {
    path: destination.slice(destination.lastIndexOf('/') + 1),
    sha256: await sha256(destination),
    size: info.size,
  }
}

function artifactsFromEntries(
  entries: Record<string, TransportEntry>,
): Artifacts {
  const digest = (name: string): string =>
    sha(entries[name]?.sha256, `transport entry ${name}`)
  return {
    baseline: {
      denort_sha256: digest('baseline-denort'),
      v8_archive_sha256: digest('baseline-v8-archive'),
      ninja_sha256: digest('baseline-ninja'),
      probe_standalone_sha256: digest('baseline-probe'),
      derived_relink_cargo_lock_sha256: digest(
        'baseline-derived-relink-Cargo.lock',
      ),
      slv_executable_sha256: digest('baseline-slv'),
      bridge_standalone_sha256: digest('baseline-bridge'),
    },
    modified: {
      denort_sha256: digest('modified-denort'),
      v8_archive_sha256: digest('modified-v8-archive'),
      ninja_sha256: digest('modified-ninja'),
      probe_standalone_sha256: digest('modified-probe'),
    },
  }
}

async function writeJson(path: string, value: unknown): Promise<string> {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n')
  return await sha256(path)
}

async function discardBuildScratch(output: string): Promise<void> {
  for (const name of ['target', 'work', 'cargo-home']) {
    const path = `${output}/${name}`
    const info = await Deno.lstat(path).catch(() => undefined)
    if (!info) continue
    if (!info.isDirectory || info.isSymlink) {
      throw new Error(
        `refusing to discard unexpected build scratch path: ${path}`,
      )
    }
    await Deno.remove(path, { recursive: true })
  }
}

const BASELINE_TRANSPORT_NAMES = [
  'baseline-denort',
  'baseline-v8-archive',
  'baseline-ninja',
  'baseline-probe',
  'baseline-derived-relink-Cargo.lock',
  'baseline-slv',
  'baseline-bridge',
  'tls-localhost.crt',
  'tls-localhost.key',
  'tls-root-ca.pem',
] as const
const MODIFIED_TRANSPORT_NAMES = [
  'modified-denort',
  'modified-v8-archive',
  'modified-ninja',
  'modified-probe',
] as const

function roleTransportNames(variant: Variant): readonly string[] {
  return variant === 'baseline'
    ? BASELINE_TRANSPORT_NAMES
    : MODIFIED_TRANSPORT_NAMES
}

function parseHost(value: unknown, label: string): Host {
  const host = object(value, label)
  exactKeys(host, ['os', 'arch'], label)
  if (
    (host.os !== 'linux' && host.os !== 'darwin') ||
    (host.arch !== 'x64' && host.arch !== 'arm64')
  ) {
    throw new Error(`${label} is not a supported host`)
  }
  return { os: host.os, arch: host.arch }
}

function parseVariantEntries(
  value: unknown,
  variant: Variant,
  label: string,
): Record<string, TransportEntry> {
  const entries = object(value, label)
  const expected = roleTransportNames(variant)
  exactKeys(entries, expected, label)
  const parsed: Record<string, TransportEntry> = {}
  for (const name of expected) {
    const entry = object(entries[name], `${label}.${name}`)
    exactKeys(entry, ['path', 'sha256', 'size'], `${label}.${name}`)
    const path = text(entry.path, `${label}.${name} path`)
    if (path !== name) {
      throw new Error(`${label}.${name} must use its exact payload path`)
    }
    const size = entry.size
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new Error(`${label}.${name} has an invalid size`)
    }
    parsed[name] = {
      path,
      sha256: sha(entry.sha256, `${label}.${name} SHA-256`),
      size: size as number,
    }
  }
  return parsed
}

function commandSucceeded(value: unknown, label: string): void {
  const receipt = object(value, label)
  if (
    !Array.isArray(receipt.command) || !receipt.command.length ||
    receipt.command.some((part) => typeof part !== 'string') ||
    receipt.exit_code !== 0
  ) {
    throw new Error(`${label} is not a successful command receipt`)
  }
  for (const key of ['cwd', 'started_at', 'finished_at', 'log']) {
    text(receipt[key], `${label} ${key}`)
  }
  sha(receipt.log_sha256, `${label} log SHA-256`)
}

function successfulCheck(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const check = object(value, label)
  if (check.passed !== true) throw new Error(`${label} did not pass`)
  commandSucceeded(check.command, `${label} command`)
  return check
}

function identityDigests(
  value: unknown,
  label: string,
): Record<string, string> {
  const identities = object(value, label)
  const parsed: Record<string, string> = {}
  for (const [name, raw] of Object.entries(identities)) {
    if (!name) throw new Error(`${label} has an empty identity name`)
    const identity = object(raw, `${label}.${name}`)
    text(identity.path, `${label}.${name} path`)
    parsed[name] = sha(identity.sha256, `${label}.${name} SHA-256`)
  }
  if (!Object.keys(parsed).length) throw new Error(`${label} is empty`)
  return parsed
}

function parseToolArchives(
  value: unknown,
  label: string,
): Record<
  string,
  { sha256: string; size: number; url: string; included_members?: string[] }
> {
  const archives = object(value, label)
  const parsed: Record<
    string,
    { sha256: string; size: number; url: string; included_members?: string[] }
  > = {}
  for (const [name, raw] of Object.entries(archives)) {
    const archive = object(raw, `${label}.${name}`)
    const allowed = archive.included_members === undefined
      ? ['sha256', 'size', 'url']
      : ['sha256', 'size', 'url', 'included_members']
    exactKeys(archive, allowed, `${label}.${name}`)
    const size = archive.size
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new Error(`${label}.${name} has an invalid size`)
    }
    const url = text(archive.url, `${label}.${name} URL`)
    if (new URL(url).protocol !== 'https:') {
      throw new Error(`${label}.${name} URL must use HTTPS`)
    }
    let includedMembers: string[] | undefined
    if (archive.included_members !== undefined) {
      if (
        !Array.isArray(archive.included_members) ||
        archive.included_members.some((member) => typeof member !== 'string')
      ) {
        throw new Error(`${label}.${name} has invalid included members`)
      }
      includedMembers = [...archive.included_members]
    }
    parsed[name] = {
      sha256: sha(archive.sha256, `${label}.${name} SHA-256`),
      size: size as number,
      url,
      ...(includedMembers ? { included_members: includedMembers } : {}),
    }
  }
  if (!Object.keys(parsed).length) throw new Error(`${label} is empty`)
  return parsed
}

type VariantReceipt = {
  value: Record<string, unknown>
  variant: Variant
  producer: ProducerContext
  target: string
  buildMode: 'native' | 'cross'
  buildHost: Host
  entries: Record<string, TransportEntry>
  checks: Record<string, unknown>
  toolchain: { pinsSha256: string; identities: Record<string, string> }
  toolArchives: Record<
    string,
    { sha256: string; size: number; url: string; included_members?: string[] }
  >
}

function parseVariantReceipt(value: unknown, label: string): VariantReceipt {
  const receipt = object(value, label)
  exactKeys(receipt, [
    'schema_version',
    'kind',
    'variant',
    'producer',
    'target',
    'build_mode',
    'build_host',
    'source_commit',
    'source_receipt_sha256',
    'source_assets',
    'source_pin_sha256',
    'notice_sha256',
    'source_selected_cargo_lock_sha256',
    'tool_pin_sha256',
    'toolchain',
    'tool_archives',
    'tools_receipt_sha256',
    'jobs',
    'resources',
    'extraction',
    'recipe_sha256',
    'patch_sha256',
    'derived_relink_cargo_lock_sha256',
    'transport',
    'entries',
    'checks',
    'timing',
  ], label)
  if (
    receipt.schema_version !== 1 ||
    receipt.kind !== 'slv-source-build-variant-receipt' ||
    (receipt.variant !== 'baseline' && receipt.variant !== 'modified') ||
    (receipt.build_mode !== 'native' && receipt.build_mode !== 'cross') ||
    !TARGETS.has(text(receipt.target, `${label} target`)) ||
    receipt.jobs !== '4'
  ) {
    throw new Error(`${label} has invalid schema, role, mode, or jobs`)
  }
  const variant = receipt.variant
  const sourceAssetsValue = receipt.source_assets
  if (
    !Array.isArray(sourceAssetsValue) ||
    sourceAssetsValue.length !== ASSETS.length
  ) {
    throw new Error(`${label} has invalid source assets`)
  }
  const sourceAssets = sourceAssetsValue.map((asset, index) => {
    const parsed = object(asset, `${label} source asset ${index}`)
    exactKeys(
      parsed,
      ['name', 'sha256', 'size'],
      `${label} source asset ${index}`,
    )
    const size = parsed.size
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new Error(`${label} source asset ${index} has invalid size`)
    }
    const name = text(parsed.name, `${label} source asset ${index} name`)
    if (name !== ASSETS[index]) {
      throw new Error(`${label} source asset ${index} has an unexpected name`)
    }
    return {
      name,
      sha256: sha(parsed.sha256, `${label} source asset ${index} SHA-256`),
      size: size as number,
    }
  })
  if (!equalJson(sourceAssets, receipt.source_assets)) {
    throw new Error(`${label} source assets are not canonical`)
  }
  const toolchain = object(receipt.toolchain, `${label} toolchain`)
  exactKeys(toolchain, ['pins_sha256', 'identities'], `${label} toolchain`)
  const transport = object(receipt.transport, `${label} transport`)
  exactKeys(transport, ['manifest', 'manifest_sha256'], `${label} transport`)
  if (transport.manifest !== 'transport/manifest.json') {
    throw new Error(`${label} has an unexpected transport manifest path`)
  }
  const timing = object(receipt.timing, `${label} timing`)
  exactKeys(timing, ['started_at', 'finished_at'], `${label} timing`)
  text(timing.started_at, `${label} timing started_at`)
  text(timing.finished_at, `${label} timing finished_at`)
  const resources = object(receipt.resources, `${label} resources`)
  exactKeys(resources, ['capacity_preflight'], `${label} resources`)
  object(resources.capacity_preflight, `${label} capacity preflight`)
  const extraction = object(receipt.extraction, `${label} extraction`)
  exactKeys(
    extraction,
    ['slv_scan', 'deno_scan', 'vendor_scan', 'slv', 'deno', 'vendor'],
    `${label} extraction`,
  )
  for (const [name, command] of Object.entries(extraction)) {
    commandSucceeded(command, `${label} extraction ${name}`)
  }
  const checks = object(receipt.checks, `${label} checks`)
  const expectedChecks = variant === 'baseline'
    ? ['baseline_build', 'slv_compile']
    : ['patch', 'modified_build']
  exactKeys(checks, expectedChecks, `${label} checks`)
  const primary = successfulCheck(
    checks[variant === 'baseline' ? 'baseline_build' : 'modified_build'],
    `${label} ${variant} build check`,
  )
  const fingerprints = primary.cargo_fingerprints
  commandSucceeded(primary.probe_compile, `${label} ${variant} probe compile`)
  sha(
    primary.runtime_abi_receipt_sha256,
    `${label} ${variant} runtime ABI receipt SHA-256`,
  )
  const runtimeAbi = object(
    primary.runtime_abi,
    `${label} ${variant} runtime ABI`,
  )
  if (runtimeAbi.status !== 'passed') {
    throw new Error(`${label} ${variant} runtime ABI did not pass`)
  }
  const derived = sha(
    receipt.derived_relink_cargo_lock_sha256,
    `${label} derived Cargo.lock SHA-256`,
  )
  const runtime = variant === 'baseline'
    ? sha(
      object(primary.runtime_abi, `${label} baseline runtime ABI`)
        .denort_sha256,
      `${label} baseline runtime SHA-256`,
    )
    : sha(
      object(primary.runtime_abi, `${label} modified runtime ABI`)
        .denort_sha256,
      `${label} modified runtime SHA-256`,
    )
  void runtime
  if (primary.derived_relink_cargo_lock_sha256 !== derived) {
    throw new Error(`${label} build check does not bind its derived Cargo.lock`)
  }
  if (variant === 'baseline') {
    const slvCompile = successfulCheck(
      checks.slv_compile,
      `${label} SLV compile check`,
    )
    commandSucceeded(slvCompile.bridge_compile, `${label} bridge compile`)
  } else {
    const patch = successfulCheck(checks.patch, `${label} patch check`)
    sha(patch.before_sha256, `${label} patch before SHA-256`)
    sha(patch.after_sha256, `${label} patch after SHA-256`)
    if (patch.before_sha256 === patch.after_sha256) {
      throw new Error(`${label} patch did not change its sentinel source`)
    }
  }
  const entries = parseVariantEntries(
    receipt.entries,
    variant,
    `${label} entries`,
  )
  const runtimeEntry = entries[
    variant === 'baseline' ? 'baseline-denort' : 'modified-denort'
  ]
  if (runtime !== runtimeEntry.sha256) {
    throw new Error(`${label} runtime ABI does not bind its transported denort`)
  }
  return {
    value: receipt,
    variant,
    producer: parseProducerContext(receipt.producer, `${label} producer`),
    target: text(receipt.target, `${label} target`),
    buildMode: receipt.build_mode,
    buildHost: parseHost(receipt.build_host, `${label} build host`),
    entries,
    checks,
    toolchain: {
      pinsSha256: sha(
        toolchain.pins_sha256,
        `${label} tool pin manifest SHA-256`,
      ),
      identities: identityDigests(
        toolchain.identities,
        `${label} tool identities`,
      ),
    },
    toolArchives: parseToolArchives(
      receipt.tool_archives,
      `${label} tool archives`,
    ),
  }
}

async function buildPhase(args: Args): Promise<void> {
  const target = args['--target']
  if (!TARGETS.has(target)) throw new Error(`unsupported target: ${target}`)
  const buildHostTarget = approvedBuildHostTarget(target, args['--build-host'])
  const jobs = args['--jobs'] ?? '2'
  if (!equalHost(currentHost(), targetHost(buildHostTarget))) {
    throw new Error(`build host must execute on ${buildHostTarget}`)
  }
  const { out, work, capacity } = await prepareBuildDirectories(
    args['--out'],
    args['--work-dir'],
    args['--source-root'],
  )
  const tools = await readTools(
    args['--tools-receipt'],
    target,
    'build',
    buildHostTarget,
  )
  // Tool archives and the three source archives are already staged before
  // this point. Measure the filesystems that will receive extraction, recipe
  // work, and proof output before allocating another multi-GiB tree.
  const inputs = await immutableInputs(args, true)
  const extracted = inputs.sourceRoot!
  const recipe =
    `${extracted}/slv-source/source-rebuild/build-baseline-denort.sh`
  const sourceSelectedCargoLockSha256 = await sha256(
    `${extracted}/deno-source/deno/Cargo.lock`,
  )
  if (
    sourceSelectedCargoLockSha256 !==
      inputs.assembly.runtime_security.selected.cargo_lock.sha256
  ) {
    throw new Error(
      'extracted Deno Cargo.lock differs from the security-selected assembly lock',
    )
  }
  const vendorCargoLockSha256 = await sha256(
    `${extracted}/deno-cargo-vendor/Cargo.lock`,
  )
  if (
    vendorCargoLockSha256 !== inputs.assembly.vendor.lock_sha256 ||
    vendorCargoLockSha256 !== sourceSelectedCargoLockSha256
  ) {
    throw new Error(
      'extracted Cargo vendor lock differs from the selected Deno build lock',
    )
  }
  const baselineSources: NativeSources = {
    deno: `${extracted}/deno-source/deno`,
    rustyV8: `${extracted}/deno-source/rusty_v8`,
    cargoVendor: `${extracted}/deno-cargo-vendor/vendor`,
  }
  const transport = `${out}/transport`
  await Deno.mkdir(transport)
  const evidenceRoot = await prepareCombinedEvidenceRoot(args['--evidence-out'])
  const baseline = await stageBuild(
    recipe,
    baselineSources,
    `${out}/baseline`,
    tools,
    target,
    buildHostTarget,
    'baseline',
    jobs,
    evidenceRoot ? `${evidenceRoot}/baseline` : undefined,
    armObservationBinding(inputs, target, buildHostTarget, 'baseline', null),
  )
  await recordArmObservation(
    baseline,
    inputs,
    target,
    buildHostTarget,
    'baseline',
    null,
  )

  const baselineProbeCompile = await compileProbe(
    tools.environment.DENO_FRONTEND,
    baseline.denort,
    target,
    `${out}/baseline/probe`,
    `${transport}/baseline-probe`,
    'baseline',
  )
  const baselineSlv = await compileSlv(
    extracted,
    `${work}/baseline-slv`,
    target,
    tools.environment.DENO_FRONTEND,
    baseline.denort,
    `${transport}/baseline-slv`,
    `${transport}/baseline-bridge`,
  )
  await Deno.remove(`${work}/baseline-slv`, { recursive: true })
  const baselineEntries: Record<string, TransportEntry> = {
    'baseline-denort': await copyTransport(
      baseline.denort,
      `${transport}/baseline-denort`,
    ),
    'baseline-v8-archive': await copyTransport(
      baseline.v8,
      `${transport}/baseline-v8-archive`,
    ),
    'baseline-ninja': await copyTransport(
      baseline.ninja,
      `${transport}/baseline-ninja`,
    ),
    'baseline-probe': {
      path: 'baseline-probe',
      sha256: await sha256(`${transport}/baseline-probe`),
      size: (await Deno.stat(`${transport}/baseline-probe`)).size,
    },
    'baseline-derived-relink-Cargo.lock': await copyTransport(
      baseline.derived_relink_cargo_lock,
      `${transport}/baseline-derived-relink-Cargo.lock`,
      false,
    ),
    'baseline-slv': {
      path: 'baseline-slv',
      sha256: await sha256(`${transport}/baseline-slv`),
      size: (await Deno.stat(`${transport}/baseline-slv`)).size,
    },
    'baseline-bridge': {
      path: 'baseline-bridge',
      sha256: await sha256(`${transport}/baseline-bridge`),
      size: (await Deno.stat(`${transport}/baseline-bridge`)).size,
    },
    // The official product compatibility job receives only the verified
    // transport, so bind its loopback TLS fixture to this manifest rather
    // than relying on an extracted source tree or a second tar invocation.
    'tls-localhost.crt': await copyTransport(
      `${extracted}/deno-source/deno/tests/testdata/tls/localhost.crt`,
      `${transport}/tls-localhost.crt`,
      false,
    ),
    'tls-localhost.key': await copyTransport(
      `${extracted}/deno-source/deno/tests/testdata/tls/localhost.key`,
      `${transport}/tls-localhost.key`,
      false,
    ),
    // localhost.crt is a leaf signed by this fixture root. Keep the trust
    // anchor in the same hash-bound transport so the product job never reads
    // an unverified extracted source tree or host trust store.
    'tls-root-ca.pem': await copyTransport(
      `${extracted}/deno-source/deno/tests/testdata/tls/RootCA.pem`,
      `${transport}/tls-root-ca.pem`,
      false,
    ),
  }
  await discardBuildScratch(`${out}/baseline`)

  // A sentinel rebuild needs a mutable V8 tree, but Deno and the checked
  // vendor closure are read-only inputs for both builds. Copy only rusty_v8
  // after the baseline product artifacts are immutable, rather than staging a
  // duplicate full source assembly on disk.
  const modifiedRustyV8 = `${work}/modified-rusty_v8`
  await copyTree(baselineSources.rustyV8, modifiedRustyV8)
  // Archive integrity, embedded manifests, and the completed baseline receipt
  // already bind the pristine tree. The modified build uses only this copied
  // tree, so retaining both V8 source trees would exceed a hosted runner's
  // disk budget without adding rebuild evidence.
  await Deno.remove(baselineSources.rustyV8, { recursive: true })
  const sin =
    `${modifiedRustyV8}/v8/third_party/glibc/src/sysdeps/ieee754/dbl-64/s_sin.c`
  const beforeSha256 = await sha256(sin)
  const patch =
    `${extracted}/slv-source/source-rebuild/glibc-sin-sentinel.patch`
  const patchReceipt = await command(
    'patch',
    ['-p1', '-d', `${modifiedRustyV8}/v8`, '-i', patch],
    work,
    `${out}/modified-patch.log`,
  )
  succeeded(patchReceipt, 'contextual glibc sentinel patch')
  const afterSha256 = await sha256(sin)
  if (beforeSha256 === afterSha256) {
    throw new Error('sentinel patch did not change glibc s_sin.c')
  }
  const modified = await stageBuild(
    recipe,
    { ...baselineSources, rustyV8: modifiedRustyV8 },
    `${out}/modified`,
    tools,
    target,
    buildHostTarget,
    'modified',
    jobs,
    evidenceRoot ? `${evidenceRoot}/modified` : undefined,
    armObservationBinding(inputs, target, buildHostTarget, 'modified', null),
  )
  await recordArmObservation(
    modified,
    inputs,
    target,
    buildHostTarget,
    'modified',
    null,
  )
  // The recipe already made its own immutable build worktree. Keep only the
  // patch hashes and receipt, then release this copied source before probe
  // compilation and transport hashing on constrained hosted runners.
  await Deno.remove(modifiedRustyV8, { recursive: true })

  const modifiedProbeCompile = await compileProbe(
    tools.environment.DENO_FRONTEND,
    modified.denort,
    target,
    `${out}/modified/probe`,
    `${transport}/modified-probe`,
    'modified',
  )
  const entries: Record<string, TransportEntry> = {
    ...baselineEntries,
    'modified-denort': await copyTransport(
      modified.denort,
      `${transport}/modified-denort`,
    ),
    'modified-v8-archive': await copyTransport(
      modified.v8,
      `${transport}/modified-v8-archive`,
    ),
    'modified-ninja': await copyTransport(
      modified.ninja,
      `${transport}/modified-ninja`,
    ),
    'modified-probe': {
      path: 'modified-probe',
      sha256: await sha256(`${transport}/modified-probe`),
      size: (await Deno.stat(`${transport}/modified-probe`)).size,
    },
  }
  const artifacts = artifactsFromEntries(entries)
  const transportManifest: TransportManifest = {
    schema_version: 1,
    kind: 'slv-source-native-transport',
    target,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    artifacts,
    entries,
  }
  const transportManifestSha256 = await writeJson(
    `${transport}/manifest.json`,
    transportManifest,
  )
  const patchSha256 = await sha256(patch)
  const buildMode = target === buildHostTarget ? 'native' : 'cross'
  const checks = {
    baseline_build: {
      passed: true,
      command: baseline.build,
      recipe_receipt_sha256: baseline.recipe_receipt_sha256,
      probe_compile: baselineProbeCompile,
      derived_relink_cargo_lock_sha256:
        baseline.derived_relink_cargo_lock_sha256,
      runtime_abi: baseline.runtime_abi,
      runtime_abi_receipt_sha256: baseline.runtime_abi_receipt_sha256,
      cargo_fingerprints: baseline.cargo_fingerprints,
    },
    patch: {
      passed: true,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      command: patchReceipt,
    },
    modified_build: {
      passed: true,
      command: modified.build,
      recipe_receipt_sha256: modified.recipe_receipt_sha256,
      probe_compile: modifiedProbeCompile,
      derived_relink_cargo_lock_sha256:
        modified.derived_relink_cargo_lock_sha256,
      runtime_abi: modified.runtime_abi,
      runtime_abi_receipt_sha256: modified.runtime_abi_receipt_sha256,
      cargo_fingerprints: modified.cargo_fingerprints,
    },
    slv_compile: {
      passed: true,
      command: baselineSlv.compile,
      bridge_compile: baselineSlv.bridge_compile,
    },
  }
  await writeJson(`${out}/build-receipt.json`, {
    schema_version: 1,
    kind: 'slv-source-build-receipt',
    target,
    build_mode: buildMode,
    build_host: targetHost(buildHostTarget),
    source_commit: inputs.assembly.source.commit,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    source_assets: inputs.sourceAssets,
    source_pin_sha256: inputs.pinsSha256,
    source_selected_cargo_lock_sha256: sourceSelectedCargoLockSha256,
    tool_pin_sha256: tools.target_pin_sha256,
    patch_sha256: patchSha256,
    toolchain: { pins_sha256: tools.pins_sha256, identities: tools.identities },
    jobs,
    resources: { capacity_preflight: capacity },
    extraction: inputs.extraction,
    recipe_sha256: {
      baseline: baseline.recipe_sha256,
      modified: modified.recipe_sha256,
    },
    transport: {
      manifest: 'transport/manifest.json',
      manifest_sha256: transportManifestSha256,
    },
    artifacts,
    checks,
  })
}

async function checkedSourceLocks(inputs: ImmutableInputs): Promise<string> {
  const extracted = inputs.sourceRoot
  if (!extracted) {
    throw new Error('source extraction is required for this phase')
  }
  const selected = await sha256(`${extracted}/deno-source/deno/Cargo.lock`)
  if (
    selected !== inputs.assembly.runtime_security.selected.cargo_lock.sha256
  ) {
    throw new Error(
      'extracted Deno Cargo.lock differs from the security-selected assembly lock',
    )
  }
  const vendor = await sha256(`${extracted}/deno-cargo-vendor/Cargo.lock`)
  if (vendor !== inputs.assembly.vendor.lock_sha256 || vendor !== selected) {
    throw new Error(
      'extracted Cargo vendor lock differs from the selected Deno build lock',
    )
  }
  return selected
}

async function prepareCombinedEvidenceRoot(
  evidenceOut: string | undefined,
): Promise<string | undefined> {
  if (!evidenceOut) return undefined
  const existing = await Deno.lstat(evidenceOut).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  })
  if (existing) {
    throw new Error('--evidence-out must name a fresh directory')
  }
  await Deno.mkdir(evidenceOut)
  const info = await Deno.lstat(evidenceOut)
  if (!info.isDirectory || info.isSymlink) {
    throw new Error('--evidence-out must be a real directory')
  }
  return evidenceOut
}

async function producerContext(
  path: string,
  label: string,
): Promise<ProducerContext> {
  await regularFile(path, label)
  return parseProducerContext(
    JSON.parse(await Deno.readTextFile(path)),
    label,
  )
}

function buildModeFor(target: string, buildHost: string): 'native' | 'cross' {
  return target === buildHost ? 'native' : 'cross'
}

async function buildVariantPhase(args: Args): Promise<void> {
  const target = args['--target']
  if (
    target !== 'aarch64-unknown-linux-gnu' &&
    target !== 'x86_64-apple-darwin'
  ) {
    throw new Error('build-variant is limited to Linux ARM64 and macOS x86_64')
  }
  const variant = args['--variant'] as Variant
  const buildHostTarget = approvedBuildHostTarget(target, args['--build-host'])
  if (!equalHost(currentHost(), targetHost(buildHostTarget))) {
    throw new Error(`build host must execute on ${buildHostTarget}`)
  }
  const startedAt = new Date().toISOString()
  const { out, work, capacity } = await prepareBuildDirectories(
    args['--out'],
    args['--work-dir'],
    args['--source-root'],
  )
  const context = await producerContext(
    args['--producer-context'],
    'build variant producer context',
  )
  const tools = await readTools(
    args['--tools-receipt'],
    target,
    'build',
    buildHostTarget,
  )
  const diagnostics = `${work}/immutable-inputs`
  await Deno.mkdir(diagnostics)
  const inputs = await immutableInputs({ ...args, '--out': diagnostics }, true)
  const extracted = inputs.sourceRoot!
  const sourceSelectedCargoLockSha256 = await checkedSourceLocks(inputs)
  const recipe =
    `${extracted}/slv-source/source-rebuild/build-baseline-denort.sh`
  const patch =
    `${extracted}/slv-source/source-rebuild/glibc-sin-sentinel.patch`
  const transport = `${out}/transport`
  await Deno.mkdir(transport)
  const pristine: NativeSources = {
    deno: `${extracted}/deno-source/deno`,
    rustyV8: `${extracted}/deno-source/rusty_v8`,
    cargoVendor: `${extracted}/deno-cargo-vendor/vendor`,
  }
  let entries: Record<string, TransportEntry>
  let checks: Record<string, unknown>
  let derivedRelinkCargoLockSha256: string
  if (variant === 'baseline') {
    const baseline = await stageBuild(
      recipe,
      pristine,
      `${work}/baseline`,
      tools,
      target,
      buildHostTarget,
      'baseline',
      '4',
      args['--evidence-out'],
      armObservationBinding(
        inputs,
        target,
        buildHostTarget,
        'baseline',
        context,
      ),
    )
    await recordArmObservation(
      baseline,
      inputs,
      target,
      buildHostTarget,
      'baseline',
      context,
    )
    const probeCompile = await compileProbe(
      tools.environment.DENO_FRONTEND,
      baseline.denort,
      target,
      `${work}/baseline/probe`,
      `${transport}/baseline-probe`,
      'baseline',
    )
    const slv = await compileSlv(
      extracted,
      `${work}/baseline-slv`,
      target,
      tools.environment.DENO_FRONTEND,
      baseline.denort,
      `${transport}/baseline-slv`,
      `${transport}/baseline-bridge`,
    )
    await Deno.remove(`${work}/baseline-slv`, { recursive: true })
    entries = {
      'baseline-denort': await copyTransport(
        baseline.denort,
        `${transport}/baseline-denort`,
      ),
      'baseline-v8-archive': await copyTransport(
        baseline.v8,
        `${transport}/baseline-v8-archive`,
      ),
      'baseline-ninja': await copyTransport(
        baseline.ninja,
        `${transport}/baseline-ninja`,
      ),
      'baseline-probe': {
        path: 'baseline-probe',
        sha256: await sha256(`${transport}/baseline-probe`),
        size: (await Deno.stat(`${transport}/baseline-probe`)).size,
      },
      'baseline-derived-relink-Cargo.lock': await copyTransport(
        baseline.derived_relink_cargo_lock,
        `${transport}/baseline-derived-relink-Cargo.lock`,
        false,
      ),
      'baseline-slv': {
        path: 'baseline-slv',
        sha256: await sha256(`${transport}/baseline-slv`),
        size: (await Deno.stat(`${transport}/baseline-slv`)).size,
      },
      'baseline-bridge': {
        path: 'baseline-bridge',
        sha256: await sha256(`${transport}/baseline-bridge`),
        size: (await Deno.stat(`${transport}/baseline-bridge`)).size,
      },
      'tls-localhost.crt': await copyTransport(
        `${extracted}/deno-source/deno/tests/testdata/tls/localhost.crt`,
        `${transport}/tls-localhost.crt`,
        false,
      ),
      'tls-localhost.key': await copyTransport(
        `${extracted}/deno-source/deno/tests/testdata/tls/localhost.key`,
        `${transport}/tls-localhost.key`,
        false,
      ),
      'tls-root-ca.pem': await copyTransport(
        `${extracted}/deno-source/deno/tests/testdata/tls/RootCA.pem`,
        `${transport}/tls-root-ca.pem`,
        false,
      ),
    }
    derivedRelinkCargoLockSha256 = baseline.derived_relink_cargo_lock_sha256
    checks = {
      baseline_build: {
        passed: true,
        command: baseline.build,
        recipe_receipt_sha256: baseline.recipe_receipt_sha256,
        probe_compile: probeCompile,
        derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
        runtime_abi: baseline.runtime_abi,
        runtime_abi_receipt_sha256: baseline.runtime_abi_receipt_sha256,
        cargo_fingerprints: baseline.cargo_fingerprints,
      },
      slv_compile: {
        passed: true,
        command: slv.compile,
        bridge_compile: slv.bridge_compile,
      },
    }
    await discardBuildScratch(`${work}/baseline`)
  } else {
    const modifiedRustyV8 = `${work}/modified-rusty_v8`
    await copyTree(pristine.rustyV8, modifiedRustyV8)
    const sin =
      `${modifiedRustyV8}/v8/third_party/glibc/src/sysdeps/ieee754/dbl-64/s_sin.c`
    const beforeSha256 = await sha256(sin)
    const patchReceipt = await command(
      'patch',
      ['-p1', '-d', `${modifiedRustyV8}/v8`, '-i', patch],
      work,
      `${work}/modified-patch.log`,
    )
    succeeded(patchReceipt, 'contextual glibc sentinel patch')
    const afterSha256 = await sha256(sin)
    if (beforeSha256 === afterSha256) {
      throw new Error('sentinel patch did not change glibc s_sin.c')
    }
    const modified = await stageBuild(
      recipe,
      { ...pristine, rustyV8: modifiedRustyV8 },
      `${work}/modified`,
      tools,
      target,
      buildHostTarget,
      'modified',
      '4',
      args['--evidence-out'],
      armObservationBinding(
        inputs,
        target,
        buildHostTarget,
        'modified',
        context,
      ),
    )
    await recordArmObservation(
      modified,
      inputs,
      target,
      buildHostTarget,
      'modified',
      context,
    )
    await Deno.remove(modifiedRustyV8, { recursive: true })
    const probeCompile = await compileProbe(
      tools.environment.DENO_FRONTEND,
      modified.denort,
      target,
      `${work}/modified/probe`,
      `${transport}/modified-probe`,
      'modified',
    )
    entries = {
      'modified-denort': await copyTransport(
        modified.denort,
        `${transport}/modified-denort`,
      ),
      'modified-v8-archive': await copyTransport(
        modified.v8,
        `${transport}/modified-v8-archive`,
      ),
      'modified-ninja': await copyTransport(
        modified.ninja,
        `${transport}/modified-ninja`,
      ),
      'modified-probe': {
        path: 'modified-probe',
        sha256: await sha256(`${transport}/modified-probe`),
        size: (await Deno.stat(`${transport}/modified-probe`)).size,
      },
    }
    derivedRelinkCargoLockSha256 = modified.derived_relink_cargo_lock_sha256
    checks = {
      patch: {
        passed: true,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        command: patchReceipt,
      },
      modified_build: {
        passed: true,
        command: modified.build,
        recipe_receipt_sha256: modified.recipe_receipt_sha256,
        probe_compile: probeCompile,
        derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
        runtime_abi: modified.runtime_abi,
        runtime_abi_receipt_sha256: modified.runtime_abi_receipt_sha256,
        cargo_fingerprints: modified.cargo_fingerprints,
      },
    }
    await discardBuildScratch(`${work}/modified`)
  }
  const manifest = {
    schema_version: 1,
    kind: 'slv-source-native-variant-transport',
    variant,
    target,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    entries,
  }
  const manifestSha256 = await writeJson(`${transport}/manifest.json`, manifest)
  const toolsReceiptCopy = `${out}/build-tools-receipt.json`
  const descriptorSource = object(
    JSON.parse(await Deno.readTextFile(args['--tools-receipt'])),
    'build tools receipt',
  )
  const descriptor = object(
    descriptorSource.target_descriptor,
    'build tools receipt descriptor',
  )
  const descriptorPath = text(
    descriptor.path,
    'build tools receipt descriptor path',
  )
  await regularFile(descriptorPath, 'build tools target descriptor')
  await Deno.copyFile(args['--tools-receipt'], toolsReceiptCopy)
  await Deno.copyFile(descriptorPath, `${out}/tool-pin.json`)
  const patchSha256 = await sha256(patch)
  const receipt = {
    schema_version: 1,
    kind: 'slv-source-build-variant-receipt',
    variant,
    producer: context,
    target,
    build_mode: buildModeFor(target, buildHostTarget),
    build_host: targetHost(buildHostTarget),
    source_commit: inputs.assembly.source.commit,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    source_assets: inputs.sourceAssets,
    source_pin_sha256: inputs.pinsSha256,
    notice_sha256: inputs.noticeSha256,
    source_selected_cargo_lock_sha256: sourceSelectedCargoLockSha256,
    tool_pin_sha256: tools.target_pin_sha256,
    toolchain: { pins_sha256: tools.pins_sha256, identities: tools.identities },
    tool_archives: tools.archives,
    tools_receipt_sha256: await sha256(toolsReceiptCopy),
    jobs: '4',
    resources: { capacity_preflight: capacity },
    extraction: inputs.extraction,
    recipe_sha256: await sha256(recipe),
    patch_sha256: patchSha256,
    derived_relink_cargo_lock_sha256: derivedRelinkCargoLockSha256,
    transport: {
      manifest: 'transport/manifest.json',
      manifest_sha256: manifestSha256,
    },
    entries,
    checks,
    timing: { started_at: startedAt, finished_at: new Date().toISOString() },
  }
  await writeJson(`${out}/variant-receipt.json`, receipt)
  // The producer artifact contains only receipt-bound metadata and transport
  // bytes. Scratch, source extraction, and diagnostics stay under work.
  await Deno.remove(extracted, { recursive: true })
}

type VariantDependency = {
  receipt: string
  materials: string
  receiptSha256: string
  artifactId: string
  artifactDigest: string
  artifactDigestNormalized: string
  producer: ProducerContext
}

function parseVariantDependency(
  value: unknown,
  label: string,
): VariantDependency {
  const dependency = object(value, label)
  exactKeys(dependency, [
    'receipt',
    'materials',
    'receipt_sha256',
    'artifact_id',
    'artifact_digest',
    'producer',
  ], label)
  return {
    receipt: text(dependency.receipt, `${label} receipt`),
    materials: text(dependency.materials, `${label} materials`),
    receiptSha256: sha(dependency.receipt_sha256, `${label} receipt SHA-256`),
    artifactId: positiveDecimal(dependency.artifact_id, `${label} artifact ID`),
    artifactDigest: text(
      dependency.artifact_digest,
      `${label} artifact digest`,
    ),
    artifactDigestNormalized: artifactDigest(
      dependency.artifact_digest,
      `${label} artifact digest`,
    ),
    producer: parseProducerContext(dependency.producer, `${label} producer`),
  }
}

function parseVariantDependencies(value: unknown): {
  baseline: VariantDependency
  modified: VariantDependency
} {
  const dependencies = object(value, 'variant dependencies')
  exactKeys(
    dependencies,
    ['schema_version', 'kind', 'baseline', 'modified'],
    'variant dependencies',
  )
  if (
    dependencies.schema_version !== 1 ||
    dependencies.kind !== 'slv-native-variant-dependencies'
  ) {
    throw new Error('unsupported variant dependencies schema')
  }
  return {
    baseline: parseVariantDependency(
      dependencies.baseline,
      'baseline dependency',
    ),
    modified: parseVariantDependency(
      dependencies.modified,
      'modified dependency',
    ),
  }
}

async function assertExactDirectory(
  path: string,
  expected: readonly string[],
  label: string,
): Promise<string> {
  const root = await ensureDirectory(path, label)
  const entries: Record<string, Deno.DirEntry> = {}
  for await (const entry of Deno.readDir(root)) entries[entry.name] = entry
  exactKeys(entries as Record<string, unknown>, expected, label)
  for (const name of expected) {
    const entry = entries[name]
    if (!entry || entry.isSymlink) {
      throw new Error(`${label} has a missing or symlinked ${name}`)
    }
  }
  return root
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index])
}

type ToolReceiptMetadata = {
  pinsSha256: string
  descriptorSha256: string
  identities: Record<string, string>
  archives: Record<
    string,
    { sha256: string; size: number; url: string; included_members?: string[] }
  >
}

function parseBuildToolReceiptMetadata(
  value: unknown,
  target: string,
  buildHost: string,
  label: string,
): ToolReceiptMetadata {
  const receipt = object(value, label)
  if (
    receipt.schema_version !== 1 || receipt.kind !== 'slv-native-toolchain' ||
    receipt.target !== target || receipt.build_host !== buildHost ||
    receipt.purpose !== 'build'
  ) {
    throw new Error(`${label} does not bind this build target and host`)
  }
  const pins = object(receipt.pins, `${label} pins`)
  const descriptor = object(
    receipt.target_descriptor,
    `${label} target descriptor`,
  )
  return {
    pinsSha256: sha(pins.sha256, `${label} pins SHA-256`),
    descriptorSha256: sha(
      descriptor.sha256,
      `${label} target descriptor SHA-256`,
    ),
    identities: identityDigests(receipt.identities, `${label} identities`),
    archives: parseToolArchives(receipt.archives, `${label} archives`),
  }
}

function expectedProducerJob(target: string, variant: Variant): string {
  if (target === 'aarch64-unknown-linux-gnu') {
    return `source-arm-${variant}`
  }
  if (target === 'x86_64-apple-darwin') {
    return `source-macos-x64-${variant}`
  }
  throw new Error(
    'split source join is limited to Linux ARM64 and macOS x86_64',
  )
}

function assertVariantContext(
  join: ProducerContext,
  dependency: VariantDependency,
  variant: Variant,
  target: string,
): void {
  const producer = dependency.producer
  if (
    producer.repository !== join.repository ||
    producer.workflow !== join.workflow ||
    producer.run_id !== join.run_id ||
    producer.job_id !== expectedProducerJob(target, variant) ||
    BigInt(producer.run_attempt) > BigInt(join.run_attempt)
  ) {
    throw new Error(
      `${variant} dependency does not belong to this exact join run`,
    )
  }
}

async function validateVariantTransport(
  root: string,
  receipt: VariantReceipt,
  sourceReceiptSha256: string,
): Promise<void> {
  const transport = await assertExactDirectory(
    `${root}/transport`,
    ['manifest.json', ...roleTransportNames(receipt.variant)],
    `${receipt.variant} dependency transport`,
  )
  await regularFile(`${transport}/manifest.json`, `${receipt.variant} manifest`)
  const manifestBytes = await Deno.readFile(`${transport}/manifest.json`)
  const transportField = object(
    receipt.value.transport,
    `${receipt.variant} receipt transport`,
  )
  if (
    await sha256(`${transport}/manifest.json`) !==
      sha(transportField.manifest_sha256, `${receipt.variant} manifest SHA-256`)
  ) {
    throw new Error(`${receipt.variant} manifest bytes differ from the receipt`)
  }
  const manifest = object(
    JSON.parse(decoder.decode(manifestBytes)),
    `${receipt.variant} transport manifest`,
  )
  exactKeys(
    manifest,
    [
      'schema_version',
      'kind',
      'variant',
      'target',
      'source_receipt_sha256',
      'entries',
    ],
    `${receipt.variant} transport manifest`,
  )
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== 'slv-source-native-variant-transport' ||
    manifest.variant !== receipt.variant ||
    manifest.target !== receipt.target ||
    manifest.source_receipt_sha256 !== sourceReceiptSha256 ||
    !equalJson(
      parseVariantEntries(
        manifest.entries,
        receipt.variant,
        `${receipt.variant} manifest entries`,
      ),
      receipt.entries,
    )
  ) {
    throw new Error(
      `${receipt.variant} transport manifest does not bind its receipt`,
    )
  }
  for (const [name, entry] of Object.entries(receipt.entries)) {
    const path = `${transport}/${entry.path}`
    await regularFile(path, `${receipt.variant} transported ${name}`)
    const info = await Deno.stat(path)
    if (info.size !== entry.size || await sha256(path) !== entry.sha256) {
      throw new Error(
        `${receipt.variant} transported ${name} differs from receipt`,
      )
    }
  }
}

type ValidatedVariant = {
  dependency: VariantDependency
  receipt: VariantReceipt
  receiptBytes: Uint8Array
  materials: string
}

async function readValidatedVariant(
  dependency: VariantDependency,
  variant: Variant,
  target: string,
  join: ProducerContext,
  inputs: ImmutableInputs,
  sourceSelectedCargoLockSha256: string,
  expectedToolPins: Uint8Array,
  expectedToolPinsSha256: string,
  expectedToolDescriptorSha256: string,
  recipeSha256: string,
  patchSha256: string,
): Promise<ValidatedVariant> {
  assertVariantContext(join, dependency, variant, target)
  await regularFile(dependency.receipt, `${variant} dependency receipt`)
  const materials = await assertExactDirectory(
    dependency.materials,
    [
      'variant-receipt.json',
      'build-tools-receipt.json',
      'tool-pin.json',
      'transport',
    ],
    `${variant} dependency materials`,
  )
  if (
    await real(dependency.receipt) !==
      await real(`${materials}/variant-receipt.json`)
  ) {
    throw new Error(
      `${variant} dependency receipt is not its downloaded sidecar`,
    )
  }
  const receiptBytes = await Deno.readFile(dependency.receipt)
  if (await sha256(dependency.receipt) !== dependency.receiptSha256) {
    throw new Error(`${variant} dependency raw receipt SHA-256 differs`)
  }
  const receipt = parseVariantReceipt(
    JSON.parse(decoder.decode(receiptBytes)),
    `${variant} variant receipt`,
  )
  if (
    receipt.variant !== variant || receipt.target !== target ||
    !equalJson(receipt.producer, dependency.producer) ||
    receipt.buildMode !==
      buildModeFor(
        target,
        receipt.producer.job_id.startsWith('source-arm-')
          ? 'x86_64-unknown-linux-gnu'
          : 'x86_64-apple-darwin',
      ) ||
    !equalJson(
      receipt.buildHost,
      targetHost(
        receipt.producer.job_id.startsWith('source-arm-')
          ? 'x86_64-unknown-linux-gnu'
          : 'x86_64-apple-darwin',
      ),
    ) ||
    receipt.value.source_commit !== inputs.assembly.source.commit ||
    receipt.value.source_receipt_sha256 !== inputs.assemblyReceiptSha256 ||
    receipt.value.source_pin_sha256 !== inputs.pinsSha256 ||
    receipt.value.notice_sha256 !== inputs.noticeSha256 ||
    receipt.value.source_selected_cargo_lock_sha256 !==
      sourceSelectedCargoLockSha256 ||
    !equalJson(receipt.value.source_assets, inputs.sourceAssets) ||
    receipt.toolchain.pinsSha256 !== expectedToolPinsSha256 ||
    receipt.value.tool_pin_sha256 !== expectedToolDescriptorSha256 ||
    receipt.value.recipe_sha256 !== recipeSha256 ||
    receipt.value.patch_sha256 !== patchSha256
  ) {
    throw new Error(`${variant} variant receipt does not bind immutable inputs`)
  }
  const toolReceiptPath = `${materials}/build-tools-receipt.json`
  const toolPinPath = `${materials}/tool-pin.json`
  await regularFile(toolReceiptPath, `${variant} build tools sidecar`)
  await regularFile(toolPinPath, `${variant} target descriptor sidecar`)
  if (await sha256(toolReceiptPath) !== receipt.value.tools_receipt_sha256) {
    throw new Error(
      `${variant} build tools sidecar SHA-256 differs from receipt`,
    )
  }
  const toolPins = await Deno.readFile(toolPinPath)
  if (
    await sha256(toolPinPath) !== expectedToolDescriptorSha256 ||
    !bytesEqual(toolPins, expectedToolPins)
  ) {
    throw new Error(
      `${variant} target descriptor sidecar differs from canonical pins`,
    )
  }
  const expectedBuildHost = target === 'aarch64-unknown-linux-gnu'
    ? 'x86_64-unknown-linux-gnu'
    : 'x86_64-apple-darwin'
  const tools = parseBuildToolReceiptMetadata(
    JSON.parse(await Deno.readTextFile(toolReceiptPath)),
    target,
    expectedBuildHost,
    `${variant} build tools sidecar`,
  )
  if (
    tools.pinsSha256 !== expectedToolPinsSha256 ||
    tools.descriptorSha256 !== expectedToolDescriptorSha256 ||
    !equalJson(tools.identities, receipt.toolchain.identities) ||
    !equalJson(tools.archives, receipt.toolArchives)
  ) {
    throw new Error(`${variant} tool sidecars do not match variant receipt`)
  }
  const primary = object(
    receipt
      .checks[variant === 'baseline' ? 'baseline_build' : 'modified_build'],
    `${variant} primary check`,
  )
  const runtimeEntry = receipt.entries[
    variant === 'baseline' ? 'baseline-denort' : 'modified-denort'
  ]
  await verifyCargoFingerprintCollection(primary.cargo_fingerprints, {
    phase: variant,
    target,
    runtime_sha256: runtimeEntry.sha256,
    derived_relink_cargo_lock_sha256: sha(
      primary.derived_relink_cargo_lock_sha256,
      `${variant} primary check derived Cargo.lock SHA-256`,
    ),
  })
  await validateVariantTransport(
    materials,
    receipt,
    inputs.assemblyReceiptSha256,
  )
  return { dependency, receipt, receiptBytes, materials }
}

async function joinBuildPhase(args: Args): Promise<void> {
  const target = args['--target']
  if (
    target !== 'aarch64-unknown-linux-gnu' && target !== 'x86_64-apple-darwin'
  ) {
    throw new Error('join-build is limited to Linux ARM64 and macOS x86_64')
  }
  const out = await ensureEmptyDirectory(args['--out'], 'join proof output')
  const work = await ensureEmptyDirectory(
    args['--work-dir'],
    'join work directory',
  )
  await ensureEmptyDirectory(args['--source-root'], 'join source root')
  const join = await producerContext(
    args['--producer-context'],
    'join producer context',
  )
  const dependenciesPath = args['--variant-dependencies']
  await regularFile(dependenciesPath, 'variant dependencies')
  const dependencies = parseVariantDependencies(
    JSON.parse(await Deno.readTextFile(dependenciesPath)),
  )
  if (
    dependencies.baseline.artifactId === dependencies.modified.artifactId ||
    dependencies.baseline.producer.job_id ===
      dependencies.modified.producer.job_id
  ) {
    throw new Error(
      'split dependencies must use distinct producer jobs and artifacts',
    )
  }
  const diagnostics = `${work}/immutable-inputs`
  await Deno.mkdir(diagnostics)
  const inputs = await immutableInputs({ ...args, '--out': diagnostics }, true)
  const sourceSelectedCargoLockSha256 = await checkedSourceLocks(inputs)
  const extracted = inputs.sourceRoot!
  const recipeSha256 = await sha256(
    `${extracted}/slv-source/source-rebuild/build-baseline-denort.sh`,
  )
  const patchSha256 = await sha256(
    `${extracted}/slv-source/source-rebuild/glibc-sin-sentinel.patch`,
  )
  const pinsPath = `${extracted}/slv-source/source-rebuild/tool-prereqs.json`
  const pinsBytes = await Deno.readFile(pinsPath)
  const pinsSha256 = await sha256(pinsPath)
  const canonicalDescriptor = canonicalTargetDescriptorBytes(
    parseToolPins(JSON.parse(decoder.decode(pinsBytes))),
    target,
  )
  const descriptorSha256 = await sha256Bytes(canonicalDescriptor)
  const baseline = await readValidatedVariant(
    dependencies.baseline,
    'baseline',
    target,
    join,
    inputs,
    sourceSelectedCargoLockSha256,
    canonicalDescriptor,
    pinsSha256,
    descriptorSha256,
    recipeSha256,
    patchSha256,
  )
  const modified = await readValidatedVariant(
    dependencies.modified,
    'modified',
    target,
    join,
    inputs,
    sourceSelectedCargoLockSha256,
    canonicalDescriptor,
    pinsSha256,
    descriptorSha256,
    recipeSha256,
    patchSha256,
  )
  if (
    baseline.receipt.value.derived_relink_cargo_lock_sha256 !==
      modified.receipt.value.derived_relink_cargo_lock_sha256 ||
    !equalJson(baseline.receipt.toolchain, modified.receipt.toolchain) ||
    !equalJson(baseline.receipt.toolArchives, modified.receipt.toolArchives)
  ) {
    throw new Error(
      'split variants do not share their immutable derived and tool bindings',
    )
  }
  const baselineDerived =
    `${baseline.materials}/transport/baseline-derived-relink-Cargo.lock`
  if (
    await sha256(baselineDerived) !==
      baseline.receipt.value.derived_relink_cargo_lock_sha256
  ) {
    throw new Error(
      'baseline derived Cargo.lock bytes differ from split receipt',
    )
  }
  const transport = `${out}/transport`
  await Deno.mkdir(transport)
  const entries: Record<string, TransportEntry> = {}
  for (const variant of [baseline, modified]) {
    for (const [name, entry] of Object.entries(variant.receipt.entries)) {
      const source = `${variant.materials}/transport/${entry.path}`
      const destination = `${transport}/${entry.path}`
      await Deno.copyFile(source, destination)
      entries[name] = {
        path: entry.path,
        sha256: await sha256(destination),
        size: (await Deno.stat(destination)).size,
      }
      if (!equalJson(entries[name], entry)) {
        throw new Error(`joined ${name} differs from verified producer payload`)
      }
    }
  }
  const artifacts = artifactsFromEntries(entries)
  const manifest: TransportManifest = {
    schema_version: 1,
    kind: 'slv-source-native-transport',
    target,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    artifacts,
    entries,
  }
  const manifestSha256 = await writeJson(`${transport}/manifest.json`, manifest)
  const splitRole = (variant: ValidatedVariant) => ({
    receipt_sha256: variant.dependency.receiptSha256,
    artifact_id: variant.dependency.artifactId,
    artifact_digest: variant.dependency.artifactDigest,
    receipt: variant.receipt.value,
    receipt_bytes_base64: base64(variant.receiptBytes),
  })
  await writeJson(`${out}/build-receipt.json`, {
    schema_version: 1,
    kind: 'slv-source-build-receipt',
    target,
    build_mode: baseline.receipt.buildMode,
    build_host: baseline.receipt.buildHost,
    source_commit: inputs.assembly.source.commit,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    source_assets: inputs.sourceAssets,
    source_pin_sha256: inputs.pinsSha256,
    source_selected_cargo_lock_sha256: sourceSelectedCargoLockSha256,
    tool_pin_sha256: descriptorSha256,
    patch_sha256: patchSha256,
    toolchain: {
      pins_sha256: baseline.receipt.toolchain.pinsSha256,
      identities: object(baseline.receipt.value.toolchain, 'baseline toolchain')
        .identities,
    },
    jobs: '4',
    resources: {
      capacity_preflight: object(
        baseline.receipt.value.resources,
        'baseline resources',
      ).capacity_preflight,
    },
    extraction: baseline.receipt.value.extraction,
    recipe_sha256: { baseline: recipeSha256, modified: recipeSha256 },
    transport: {
      manifest: 'transport/manifest.json',
      manifest_sha256: manifestSha256,
    },
    artifacts,
    checks: {
      baseline_build: baseline.receipt.checks.baseline_build,
      patch: modified.receipt.checks.patch,
      modified_build: modified.receipt.checks.modified_build,
      slv_compile: baseline.receipt.checks.slv_compile,
    },
    split_build: {
      schema_version: 1,
      kind: 'slv-source-split-build-evidence',
      join_producer: join,
      baseline: splitRole(baseline),
      modified: splitRole(modified),
    },
  })
  await Deno.remove(extracted, { recursive: true })
}

function parseTransportEntries(value: unknown): Record<string, TransportEntry> {
  const record = object(value, 'transport entries')
  const expected = new Set([
    'baseline-denort',
    'baseline-v8-archive',
    'baseline-ninja',
    'baseline-probe',
    'baseline-derived-relink-Cargo.lock',
    'baseline-slv',
    'baseline-bridge',
    'tls-localhost.crt',
    'tls-localhost.key',
    'tls-root-ca.pem',
    'modified-denort',
    'modified-v8-archive',
    'modified-ninja',
    'modified-probe',
  ])
  if (
    Object.keys(record).length !== expected.size ||
    [...expected].some((key) => !record[key])
  ) {
    throw new Error('transport manifest does not have its complete allowlist')
  }
  const parsed: Record<string, TransportEntry> = {}
  for (const name of expected) {
    const entry = object(record[name], `transport entry ${name}`)
    const path = text(entry.path, `transport entry ${name} path`)
    if (
      path.includes('/') || path.includes('\\') || path === '.' || path === '..'
    ) {
      throw new Error(`transport entry has unsafe path: ${name}`)
    }
    const size = entry.size
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new Error(`transport entry has invalid size: ${name}`)
    }
    parsed[name] = {
      path,
      sha256: sha(entry.sha256, `transport entry ${name} digest`),
      size: size as number,
    }
  }
  return parsed
}

type EmbeddedSplitRole = {
  receiptSha256: string
  artifactId: string
  artifactDigest: string
  receipt: VariantReceipt
}

function parseEmbeddedSplitRole(
  value: unknown,
  label: string,
): EmbeddedSplitRole {
  const role = object(value, label)
  exactKeys(
    role,
    [
      'receipt_sha256',
      'artifact_id',
      'artifact_digest',
      'receipt',
      'receipt_bytes_base64',
    ],
    label,
  )
  const encoded = text(role.receipt_bytes_base64, `${label} receipt bytes`)
  const bytes = decodeBase64(encoded, `${label} receipt bytes`)
  if (base64(bytes) !== encoded) {
    throw new Error(`${label} receipt bytes are not canonical base64`)
  }
  const receiptSha256 = sha(role.receipt_sha256, `${label} receipt SHA-256`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== receiptSha256) {
    throw new Error(`${label} receipt SHA-256 differs from original bytes`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Error(`${label} receipt bytes are not JSON`)
  }
  if (!equalJson(decoded, role.receipt)) {
    throw new Error(`${label} receipt bytes do not equal the embedded receipt`)
  }
  return {
    receiptSha256,
    artifactId: positiveDecimal(role.artifact_id, `${label} artifact ID`),
    artifactDigest: artifactDigest(
      role.artifact_digest,
      `${label} artifact digest`,
    ),
    receipt: parseVariantReceipt(role.receipt, `${label} receipt`),
  }
}

/**
 * Revalidate the additive split evidence carried by a combined build receipt.
 * This has no dependency on producer paths: all original bytes needed by the
 * downstream execution and merge phases are retained in the combined receipt.
 */
export async function verifySplitBuildEvidence(
  splitValue: unknown,
  build: Record<string, unknown>,
  inputs: ImmutableInputs,
  target: string,
  artifacts: Artifacts,
  transportEntries: Record<string, TransportEntry>,
): Promise<void> {
  const split = object(splitValue, 'split build evidence')
  exactKeys(
    split,
    ['schema_version', 'kind', 'join_producer', 'baseline', 'modified'],
    'split build evidence',
  )
  if (
    split.schema_version !== 1 ||
    split.kind !== 'slv-source-split-build-evidence'
  ) {
    throw new Error('unsupported split build evidence schema')
  }
  const join = parseProducerContext(split.join_producer, 'split join producer')
  const baseline = parseEmbeddedSplitRole(split.baseline, 'split baseline')
  const modified = parseEmbeddedSplitRole(split.modified, 'split modified')
  if (
    !equalJson(baseline.receipt.toolArchives, modified.receipt.toolArchives)
  ) {
    throw new Error('split build variants have mismatched tool archives')
  }
  const recipe = object(build.recipe_sha256, 'build receipt recipe SHA-256')
  exactKeys(recipe, ['baseline', 'modified'], 'build receipt recipe SHA-256')
  if (
    build.jobs !== '4' ||
    build.patch_sha256 !== baseline.receipt.value.patch_sha256 ||
    build.patch_sha256 !== modified.receipt.value.patch_sha256
  ) {
    throw new Error(
      'combined split build does not preserve its fixed jobs and patch',
    )
  }
  if (
    baseline.receipt.variant !== 'baseline' ||
    modified.receipt.variant !== 'modified' ||
    baseline.artifactId === modified.artifactId ||
    baseline.receipt.producer.job_id === modified.receipt.producer.job_id ||
    build.build_mode !== baseline.receipt.buildMode ||
    !equalJson(build.build_host, baseline.receipt.buildHost)
  ) {
    throw new Error(
      'split build roles do not have distinct baseline and modified producers',
    )
  }
  for (
    const [variant, role] of [
      ['baseline', baseline],
      ['modified', modified],
    ] as const
  ) {
    const receipt = role.receipt
    const expectedHost = target === 'aarch64-unknown-linux-gnu'
      ? 'x86_64-unknown-linux-gnu'
      : 'x86_64-apple-darwin'
    if (
      receipt.target !== target ||
      receipt.buildMode !== buildModeFor(target, expectedHost) ||
      !equalJson(receipt.buildHost, targetHost(expectedHost)) ||
      receipt.producer.repository !== join.repository ||
      receipt.producer.workflow !== join.workflow ||
      receipt.producer.run_id !== join.run_id ||
      receipt.producer.job_id !== expectedProducerJob(target, variant) ||
      BigInt(receipt.producer.run_attempt) > BigInt(join.run_attempt) ||
      receipt.value.source_commit !== inputs.assembly.source.commit ||
      receipt.value.source_receipt_sha256 !== inputs.assemblyReceiptSha256 ||
      receipt.value.source_pin_sha256 !== inputs.pinsSha256 ||
      receipt.value.notice_sha256 !== inputs.noticeSha256 ||
      receipt.value.source_selected_cargo_lock_sha256 !==
        inputs.assembly.runtime_security.selected.cargo_lock.sha256 ||
      !equalJson(receipt.value.source_assets, inputs.sourceAssets) ||
      receipt.value.tool_pin_sha256 !== build.tool_pin_sha256 ||
      receipt.value.recipe_sha256 !== recipe[variant] ||
      receipt.toolchain.pinsSha256 !==
        object(build.toolchain, 'build receipt toolchain').pins_sha256 ||
      !equalJson(
        receipt.toolchain.identities,
        identityDigests(
          object(build.toolchain, 'build receipt toolchain').identities,
          'build receipt tool identities',
        ),
      ) ||
      receipt.value.derived_relink_cargo_lock_sha256 !==
        baseline.receipt.value.derived_relink_cargo_lock_sha256
    ) {
      throw new Error(
        `${variant} split receipt does not bind the combined build`,
      )
    }
    const combinedCheck = object(build.checks, 'build receipt checks')[
      variant === 'baseline' ? 'baseline_build' : 'modified_build'
    ]
    const roleCheck = receipt.checks[
      variant === 'baseline' ? 'baseline_build' : 'modified_build'
    ]
    if (!equalJson(combinedCheck, roleCheck)) {
      throw new Error(
        `${variant} split check differs from combined build check`,
      )
    }
    const runtimeEntry = receipt.entries[
      variant === 'baseline' ? 'baseline-denort' : 'modified-denort'
    ]
    const primary = object(roleCheck, `${variant} split primary check`)
    await verifyCargoFingerprintCollection(primary.cargo_fingerprints, {
      phase: variant,
      target,
      runtime_sha256: runtimeEntry.sha256,
      derived_relink_cargo_lock_sha256: sha(
        primary.derived_relink_cargo_lock_sha256,
        `${variant} split primary derived Cargo.lock SHA-256`,
      ),
    })
    for (const [name, entry] of Object.entries(receipt.entries)) {
      if (!equalJson(transportEntries[name], entry)) {
        throw new Error(
          `${variant} split entry ${name} differs from combined transport`,
        )
      }
    }
  }
  if (
    !equalJson(
      object(build.checks, 'build receipt checks').patch,
      modified.receipt.checks.patch,
    ) ||
    !equalJson(
      object(build.checks, 'build receipt checks').slv_compile,
      baseline.receipt.checks.slv_compile,
    ) ||
    !equalJson(artifacts, artifactsFromEntries(transportEntries))
  ) {
    throw new Error(
      'combined split receipt does not preserve downstream checks or artifacts',
    )
  }
}

async function readBuildReceipt(
  path: string,
  inputs: ImmutableInputs,
  target: string,
): Promise<
  {
    value: Record<string, unknown>
    sha256: string
    artifacts: Artifacts
    transport: TransportManifest
  }
> {
  const bytes = await Deno.readFile(path)
  const value = object(JSON.parse(decoder.decode(bytes)), 'build receipt')
  const digest = await sha256(path)
  if (
    value.schema_version !== 1 || value.kind !== 'slv-source-build-receipt' ||
    value.target !== target ||
    (value.build_mode !== 'native' && value.build_mode !== 'cross') ||
    value.source_commit !== inputs.assembly.source.commit ||
    value.source_receipt_sha256 !== inputs.assemblyReceiptSha256 ||
    value.source_pin_sha256 !== inputs.pinsSha256 ||
    value.source_selected_cargo_lock_sha256 !==
      inputs.assembly.runtime_security.selected.cargo_lock.sha256 ||
    !equalJson(value.source_assets, inputs.sourceAssets)
  ) {
    throw new Error('build receipt does not bind immutable source inputs')
  }
  const artifacts = parseArtifacts(value.artifacts, 'build receipt artifacts')
  const checks = object(value.checks, 'build receipt checks')
  await verifyCargoFingerprintCollection(
    object(checks.baseline_build, 'baseline build check').cargo_fingerprints,
    {
      phase: 'baseline',
      target,
      runtime_sha256: artifacts.baseline.denort_sha256,
      derived_relink_cargo_lock_sha256:
        artifacts.baseline.derived_relink_cargo_lock_sha256,
    },
  )
  await verifyCargoFingerprintCollection(
    object(checks.modified_build, 'modified build check').cargo_fingerprints,
    {
      phase: 'modified',
      target,
      runtime_sha256: artifacts.modified.denort_sha256,
      derived_relink_cargo_lock_sha256: sha(
        object(checks.modified_build, 'modified build check')
          .derived_relink_cargo_lock_sha256,
        'modified build check derived Cargo.lock SHA-256',
      ),
    },
  )
  const transportField = object(value.transport, 'build receipt transport')
  const manifestPath = text(
    transportField.manifest,
    'build receipt transport manifest',
  )
  if (manifestPath !== 'transport/manifest.json') {
    throw new Error('unexpected transport manifest path')
  }
  const manifestDigest = sha(
    transportField.manifest_sha256,
    'transport manifest digest',
  )
  const base = path.slice(0, path.lastIndexOf('/')) || '.'
  const manifestPathAbsolute = `${base}/${manifestPath}`
  if (await sha256(manifestPathAbsolute) !== manifestDigest) {
    throw new Error('transport manifest digest differs from build receipt')
  }
  const transport = object(
    JSON.parse(await Deno.readTextFile(manifestPathAbsolute)),
    'transport manifest',
  ) as unknown as TransportManifest
  if (
    transport.schema_version !== 1 ||
    transport.kind !== 'slv-source-native-transport' ||
    transport.target !== target ||
    transport.source_receipt_sha256 !== inputs.assemblyReceiptSha256 ||
    !equalJson(
      parseArtifacts(transport.artifacts, 'transport artifacts'),
      artifacts,
    )
  ) {
    throw new Error('transport manifest does not bind build receipt artifacts')
  }
  transport.entries = parseTransportEntries(transport.entries)
  if (value.split_build !== undefined) {
    await verifySplitBuildEvidence(
      value.split_build,
      value,
      inputs,
      target,
      artifacts,
      transport.entries,
    )
  }
  return { value, sha256: digest, artifacts, transport }
}

function parseArtifacts(value: unknown, label: string): Artifacts {
  const root = object(value, label)
  const baseline = object(root.baseline, `${label}.baseline`)
  const modified = object(root.modified, `${label}.modified`)
  const expectedBaseline = [
    'denort_sha256',
    'v8_archive_sha256',
    'ninja_sha256',
    'probe_standalone_sha256',
    'derived_relink_cargo_lock_sha256',
    'slv_executable_sha256',
    'bridge_standalone_sha256',
  ]
  const expectedModified = [
    'denort_sha256',
    'v8_archive_sha256',
    'ninja_sha256',
    'probe_standalone_sha256',
  ]
  if (
    Object.keys(baseline).length !== expectedBaseline.length ||
    expectedBaseline.some((key) => !baseline[key]) ||
    Object.keys(modified).length !== expectedModified.length ||
    expectedModified.some((key) => !modified[key])
  ) {
    throw new Error(`${label} has incomplete artifact identity`)
  }
  const parse = (
    record: Record<string, unknown>,
    keys: string[],
    part: string,
  ) =>
    Object.fromEntries(
      keys.map((key) => [key, sha(record[key], `${label}.${part}.${key}`)]),
    )
  return {
    baseline: parse(
      baseline,
      expectedBaseline,
      'baseline',
    ) as Artifacts['baseline'],
    modified: parse(
      modified,
      expectedModified,
      'modified',
    ) as Artifacts['modified'],
  }
}

async function verifyTransport(
  directory: string,
  transport: TransportManifest,
): Promise<Artifacts> {
  const root = await ensureDirectory(directory, 'build transport')
  const manifest = `${root}/manifest.json`
  await regularFile(manifest, 'build transport manifest')
  const observed = object(
    JSON.parse(await Deno.readTextFile(manifest)),
    'build transport manifest',
  ) as unknown as TransportManifest
  if (!equalJson(observed, transport)) {
    throw new Error('build transport manifest bytes differ from build receipt')
  }
  for (const [name, entry] of Object.entries(transport.entries)) {
    const path = `${root}/${entry.path}`
    await regularFile(path, `transported ${name}`)
    const info = await Deno.stat(path)
    if (info.size !== entry.size || await sha256(path) !== entry.sha256) {
      throw new Error(
        `transported artifact differs from build receipt: ${name}`,
      )
    }
  }
  // Artifact transports may normalize file modes to 0644. Restore execute
  // only after content/size verification and only for the explicit programs
  // the execution phase invokes; do not chmod arbitrary manifest entries.
  for (
    const name of [
      'baseline-denort',
      'baseline-probe',
      'baseline-slv',
      'baseline-bridge',
      'modified-denort',
      'modified-probe',
    ]
  ) {
    await Deno.chmod(`${root}/${transport.entries[name].path}`, 0o755)
  }
  const artifacts = artifactsFromEntries(transport.entries)
  if (!equalJson(artifacts, transport.artifacts)) {
    throw new Error('transported artifact identities do not match manifest')
  }
  return artifacts
}

async function runProbe(
  executable: string,
  input: string,
  cwd: string,
  log: string,
  env: Record<string, string>,
): Promise<{ receipt: CommandReceipt; output: number }> {
  const receipt = await command(executable, [input], cwd, log, env)
  await assertExecutionSucceeded(receipt, `runtime probe ${input}`)
  const parsed = JSON.parse(
    decoder.decode(await Deno.readFile(log)).trim(),
  ) as { output?: unknown }
  if (typeof parsed.output !== 'number' || !Number.isFinite(parsed.output)) {
    throw new Error(`runtime probe ${input} did not emit a finite output`)
  }
  return { receipt, output: parsed.output }
}

async function executePhase(args: Args): Promise<void> {
  const target = args['--target']
  if (!TARGETS.has(target)) throw new Error(`unsupported target: ${target}`)
  const executionHost = targetHost(target)
  if (!equalHost(currentHost(), executionHost)) {
    throw new Error(`execution host must be ${target}`)
  }
  const out = await ensureDirectory(args['--out'], 'execution proof output')
  await ensureEmptyDirectory(args['--source-root'], 'execution source root')
  const work = await ensureEmptyDirectory(
    args['--work-dir'],
    'execution work directory',
  )
  const inputs = await immutableInputs(args, false)
  const build = await readBuildReceipt(args['--build-receipt'], inputs, target)
  const buildHost = object(build.value.build_host, 'build receipt host')
  const buildHostTarget = target === 'aarch64-unknown-linux-gnu'
    ? 'x86_64-unknown-linux-gnu'
    : target
  if (!equalJson(buildHost, targetHost(buildHostTarget))) {
    throw new Error('build receipt has an unapproved build host')
  }
  const buildMode = build.value.build_mode
  if (buildMode !== (target === buildHostTarget ? 'native' : 'cross')) {
    throw new Error('build receipt has an invalid mode for target')
  }
  const tools = await readTools(
    args['--execution-tools-receipt'],
    target,
    'execution',
    target,
  )
  if (build.value.tool_pin_sha256 !== tools.target_pin_sha256) {
    throw new Error('execution tool descriptor differs from build descriptor')
  }
  const artifacts = await verifyTransport(
    args['--build-materials'],
    build.transport,
  )
  if (!equalJson(artifacts, build.artifacts)) {
    throw new Error('transport artifacts differ from build receipt')
  }
  const entries = build.transport.entries
  const materials = await real(args['--build-materials'])
  const artifact = (name: string) => `${materials}/${entries[name].path}`
  const hostPython = await resolveHostPython()
  const runtimeEnvironment = withPythonPath({
    HOME: `${work}/private-home`,
    DENO_DIR: `${work}/deno-cache`,
  }, hostPython)
  const baselineSentinel = await runProbe(
    artifact('baseline-probe'),
    '0.125',
    work,
    `${out}/baseline-sentinel.log`,
    runtimeEnvironment,
  )
  const baselineControl = await runProbe(
    artifact('baseline-probe'),
    '0.126',
    work,
    `${out}/baseline-control.log`,
    runtimeEnvironment,
  )
  const modifiedSentinel = await runProbe(
    artifact('modified-probe'),
    '0.125',
    work,
    `${out}/modified-sentinel.log`,
    runtimeEnvironment,
  )
  const modifiedControl = await runProbe(
    artifact('modified-probe'),
    '0.126',
    work,
    `${out}/modified-control.log`,
    runtimeEnvironment,
  )
  if (baselineSentinel.output === 0.5) {
    throw new Error('baseline unexpectedly returned sentinel value')
  }
  if (modifiedSentinel.output !== 0.5) {
    throw new Error(
      `sentinel did not reach glibc_sin: ${modifiedSentinel.output}`,
    )
  }
  if (modifiedControl.output !== baselineControl.output) {
    throw new Error(
      'nearby control differs between baseline and sentinel runtime',
    )
  }
  const version = await command(
    artifact('baseline-slv'),
    ['--version'],
    work,
    `${out}/slv-version.log`,
    runtimeEnvironment,
  )
  const help = await command(
    artifact('baseline-slv'),
    ['--help'],
    work,
    `${out}/slv-help.log`,
    runtimeEnvironment,
  )
  const licenses = await command(
    artifact('baseline-slv'),
    ['licenses'],
    work,
    `${out}/slv-licenses.log`,
    runtimeEnvironment,
  )
  const bridge = await command(
    artifact('baseline-bridge'),
    [],
    work,
    `${out}/bridge.log`,
    runtimeEnvironment,
  )
  for (
    const [label, receipt] of Object.entries({
      version,
      help,
      licenses,
      bridge,
    })
  ) {
    await assertExecutionSucceeded(
      receipt,
      `compiled SLV ${label} acceptance`,
    )
  }
  if (licenses.log_sha256 !== inputs.noticeSha256) {
    throw new Error(
      'compiled SLV licenses bytes differ from canonical notice input',
    )
  }
  const checks = {
    baseline_probe: {
      passed: true,
      sentinel: {
        input: 0.125,
        output: baselineSentinel.output,
        command: baselineSentinel.receipt,
      },
      control: {
        input: 0.126,
        output: baselineControl.output,
        command: baselineControl.receipt,
      },
    },
    modified_probe: {
      passed: true,
      sentinel: {
        input: 0.125,
        output: modifiedSentinel.output,
        command: modifiedSentinel.receipt,
      },
      control: {
        input: 0.126,
        output: modifiedControl.output,
        command: modifiedControl.receipt,
      },
    },
    slv_version: { passed: true, command: version },
    licenses: {
      passed: true,
      command: licenses,
      canonical_notice_sha256: inputs.noticeSha256,
    },
    slv_help: { passed: true, command: help },
    release_bridge: {
      passed: true,
      compile: object(build.value.checks, 'build receipt checks').slv_compile &&
        object(
          object(build.value.checks, 'build receipt checks').slv_compile,
          'slv compile check',
        ).bridge_compile,
      command: bridge,
    },
  }
  await writeJson(`${out}/execution-receipt.json`, {
    schema_version: 1,
    kind: 'slv-source-execution-receipt',
    target,
    build_mode: buildMode,
    build_receipt_sha256: build.sha256,
    execution_host: executionHost,
    execution_toolchain: {
      pins_sha256: tools.pins_sha256,
      identities: tools.identities,
    },
    host_python: hostPython,
    artifacts,
    checks,
  })
}

function requiredBuildChecks(value: unknown): Record<string, unknown> {
  const checks = object(value, 'build receipt checks')
  for (
    const key of ['baseline_build', 'patch', 'modified_build', 'slv_compile']
  ) {
    if (!checks[key]) throw new Error(`build receipt lacks ${key}`)
  }
  return checks
}

function requiredExecutionChecks(value: unknown): Record<string, unknown> {
  const checks = object(value, 'execution receipt checks')
  for (
    const key of [
      'baseline_probe',
      'modified_probe',
      'slv_version',
      'licenses',
      'slv_help',
      'release_bridge',
    ]
  ) {
    if (!checks[key]) throw new Error(`execution receipt lacks ${key}`)
  }
  return checks
}

function boundedBuildJobs(value: unknown): string {
  const jobs = text(value, 'build receipt jobs')
  if (!/^(?:[1-9]|1[0-6])$/.test(jobs)) {
    throw new Error('build receipt has an invalid bounded jobs value')
  }
  return jobs
}

type NativeProofSourceBindings = {
  sourceCommit: string
  sourceReceiptSha256: string
  sourceAssets: Array<{ name: AssetName; sha256: string; size: number }>
  sourcePinSha256: string
}

type NativeProofBuild = {
  value: Record<string, unknown>
  sha256: string
  artifacts: Artifacts
}

/**
 * Create the proof record consumed unchanged by the release-side parser.
 * Keeping this boundary explicit makes the merge producer testable without a
 * multi-hour native build and prevents build receipt fields from being
 * silently dropped when the proof schema grows.
 */
export function emitNativeTargetProof(
  target: string,
  source: NativeProofSourceBindings,
  build: NativeProofBuild,
  execution: Record<string, unknown>,
  executionReceiptSha256: string,
): Record<string, unknown> {
  const buildChecks = requiredBuildChecks(build.value.checks)
  const executionChecks = requiredExecutionChecks(execution.checks)
  const checks = {
    baseline_build: buildChecks.baseline_build,
    baseline_probe: executionChecks.baseline_probe,
    patch: buildChecks.patch,
    modified_build: buildChecks.modified_build,
    modified_probe: executionChecks.modified_probe,
    slv_compile: buildChecks.slv_compile,
    slv_version: executionChecks.slv_version,
    licenses: executionChecks.licenses,
    slv_help: executionChecks.slv_help,
    release_bridge: executionChecks.release_bridge,
  }
  return {
    schema_version: 1,
    kind: 'slv-source-target-proof',
    target,
    source_commit: source.sourceCommit,
    source_receipt_sha256: source.sourceReceiptSha256,
    source_assets: source.sourceAssets,
    build_mode: build.value.build_mode,
    build_host: build.value.build_host,
    execution_host: execution.execution_host,
    source_pin_sha256: source.sourcePinSha256,
    source_selected_cargo_lock_sha256: text(
      build.value.source_selected_cargo_lock_sha256,
      'build receipt selected Cargo.lock SHA-256',
    ),
    tool_pin_sha256: build.value.tool_pin_sha256,
    patch_sha256: build.value.patch_sha256,
    jobs: boundedBuildJobs(build.value.jobs),
    build_receipt_sha256: build.sha256,
    execution_receipt_sha256: executionReceiptSha256,
    build_artifacts: build.artifacts,
    execution_artifacts: parseArtifacts(
      execution.artifacts,
      'execution receipt artifacts',
    ),
    artifacts: build.artifacts,
    checks,
    status: 'passed',
  }
}

async function mergePhase(args: Args): Promise<void> {
  const target = args['--target']
  if (!TARGETS.has(target)) throw new Error(`unsupported target: ${target}`)
  const out = await ensureDirectory(args['--out'], 'merge proof output')
  await ensureEmptyDirectory(args['--source-root'], 'merge source root')
  await ensureEmptyDirectory(args['--work-dir'], 'merge work directory')
  const inputs = await immutableInputs(args, false)
  const build = await readBuildReceipt(args['--build-receipt'], inputs, target)
  const executionBytes = await Deno.readFile(args['--execution-receipt'])
  const execution = object(
    JSON.parse(decoder.decode(executionBytes)),
    'execution receipt',
  )
  const executionReceiptSha256 = await sha256(args['--execution-receipt'])
  if (
    execution.schema_version !== 1 ||
    execution.kind !== 'slv-source-execution-receipt' ||
    execution.target !== target ||
    execution.build_mode !== build.value.build_mode ||
    execution.build_receipt_sha256 !== build.sha256 ||
    !equalJson(execution.execution_host, targetHost(target)) ||
    !equalJson(
      parseArtifacts(execution.artifacts, 'execution receipt artifacts'),
      build.artifacts,
    )
  ) {
    throw new Error(
      'execution receipt does not bind the build receipt and target',
    )
  }
  const proof = emitNativeTargetProof(
    target,
    {
      sourceCommit: inputs.assembly.source.commit,
      sourceReceiptSha256: inputs.assemblyReceiptSha256,
      sourceAssets: inputs.sourceAssets,
      sourcePinSha256: inputs.pinsSha256,
    },
    build,
    execution,
    executionReceiptSha256,
  )
  verifyNativeSourceRebuildProof(proof)
  const proofPath = `${out}/native-proof.json`
  const existing = await Deno.lstat(proofPath).catch(() => undefined)
  if (existing) throw new Error(`native proof already exists: ${proofPath}`)
  await writeJson(proofPath, proof)
}

export async function verifyNative(args: Args): Promise<void> {
  const phase = phaseOf(args)
  if (phase === 'build') return await buildPhase(args)
  if (phase === 'build-variant') return await buildVariantPhase(args)
  if (phase === 'join-build') return await joinBuildPhase(args)
  if (phase === 'execute') return await executePhase(args)
  await mergePhase(args)
}

if (import.meta.main) {
  try {
    await verifyNative(parseNativeArgs(Deno.args))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    Deno.exit(1)
  }
}
