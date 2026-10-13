/**
 * Offline native rebuild proof driver.
 *
 * `build` reconstructs baseline and sentinel runtimes from the three source
 * archives and emits a hash-allowlisted transport directory. `execute` runs
 * only those transported artifacts on the target host. `merge` rebinds both
 * phase receipts to the immutable assembly receipt and produces the target
 * proof consumed by the release aggregator.
 */
import {
  sha256,
  type SourceAsset,
  type SourceMaterialsReceipt,
  verifyNativeSourceRebuildProof,
  verifySourceMaterialsReceipt,
} from '../scripts/release/source-materials.ts'

const decoder = new TextDecoder()
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
type AssetName = typeof ASSETS[number]
type Phase = 'build' | 'execute' | 'merge'
type Args = Record<string, string>
type Host = { os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }
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
type Artifacts = {
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

function phaseOf(args: Args): Phase {
  const phase = args['--phase']
  if (phase !== 'build' && phase !== 'execute' && phase !== 'merge') {
    throw new Error('--phase must be build, execute, or merge')
  }
  return phase
}

function parseArgs(argv: string[]): Args {
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
  if (phase !== 'build' && phase !== 'execute' && phase !== 'merge') {
    throw new Error(
      'usage: verify-native.ts --phase build|execute|merge --target TARGET --source-root EMPTY_DIR --work-dir EMPTY_DIR --out PROOF_DIR --pins PINS_JSON --source-receipt RECEIPT_JSON --slv-source ARCHIVE --deno-source ARCHIVE --cargo-vendor ARCHIVE --notice-file THIRD_PARTY_NOTICES [phase inputs]',
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
  if (phase === 'build' && !values['--tools-receipt']) {
    throw new Error('build requires --tools-receipt')
  }
  if (values['--jobs'] !== undefined) {
    if (phase !== 'build' || !/^(?:[1-9]|1[0-6])$/.test(values['--jobs'])) {
      throw new Error(
        '--jobs is permitted only for build and must be 1 through 16',
      )
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
): Promise<CommandReceipt> {
  const environment = await allowedEnvironment(cwd, env)
  const started_at = new Date().toISOString()
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    clearEnv: true,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()
  const finished_at = new Date().toISOString()
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
    if not raw or raw.startswith('/') or '\\' in raw or '\x00' in raw:
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
        not target or target.startswith('/') or '\\' in target or
        '\x00' in target
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
  const listed = await command(
    'tar',
    ['-tzf', archive],
    destination,
    `${log}.list`,
  )
  succeeded(listed, `listing ${archive}`)
  const names = decoder.decode(await Deno.readFile(`${log}.list`)).trim().split(
    '\n',
  ).filter(Boolean)
  if (!names.length) throw new Error(`archive has no entries: ${archive}`)
  for (const name of names) {
    if (
      name.startsWith('/') || name.includes('\\') ||
      name.split('/').includes('..') ||
      !(name === root || name.startsWith(`${root}/`))
    ) {
      throw new Error(`archive has unsafe or unexpected path: ${name}`)
    }
  }
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

async function readTools(
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

async function stageBuild(
  recipeSource: string,
  sources: NativeSources,
  output: string,
  tools: ToolReceipt,
  target: string,
  buildHost: string,
  label: string,
  jobs: string,
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
  const build = await streamingCommand(
    Deno.build.os === 'darwin' ? '/bin/bash' : '/usr/bin/bash',
    // The recipe copies these explicit immutable source paths into its own
    // disposable worktree. Passing their common extraction root here only
    // records the source assembly context; it does not cause a second native
    // input-tree copy in the driver.
    [
      recipe,
      await real(sources.deno.slice(0, sources.deno.lastIndexOf('/'))),
      output,
    ],
    output,
    `${output}/baseline-denort.log`,
    env,
  )
  succeeded(build, `${label} source build`)
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
  return {
    build,
    denort,
    v8,
    ninja,
    recipe_sha256: await sha256(recipe),
    recipe_receipt_sha256: await sha256(recipeReceipt),
    derived_relink_cargo_lock: derivedRelinkCargoLock,
    derived_relink_cargo_lock_sha256: await sha256(derivedRelinkCargoLock),
    runtime_abi: runtimeAbi,
    runtime_abi_receipt_sha256: await sha256(abiReceipt),
  }
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
  const baseline = await stageBuild(
    recipe,
    baselineSources,
    `${out}/baseline`,
    tools,
    target,
    buildHostTarget,
    'baseline',
    jobs,
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
      runtime_abi: modified.runtime_abi,
      runtime_abi_receipt_sha256: modified.runtime_abi_receipt_sha256,
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
  succeeded(receipt, `runtime probe ${input}`)
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
    succeeded(receipt, `compiled SLV ${label} acceptance`)
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
  const proof = {
    schema_version: 1,
    kind: 'slv-source-target-proof',
    target,
    source_commit: inputs.assembly.source.commit,
    source_receipt_sha256: inputs.assemblyReceiptSha256,
    source_assets: inputs.sourceAssets,
    build_mode: build.value.build_mode,
    build_host: build.value.build_host,
    execution_host: execution.execution_host,
    source_pin_sha256: inputs.pinsSha256,
    source_selected_cargo_lock_sha256: text(
      build.value.source_selected_cargo_lock_sha256,
      'build receipt selected Cargo.lock SHA-256',
    ),
    tool_pin_sha256: build.value.tool_pin_sha256,
    patch_sha256: build.value.patch_sha256,
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
  verifyNativeSourceRebuildProof(proof)
  const proofPath = `${out}/native-proof.json`
  const existing = await Deno.lstat(proofPath).catch(() => undefined)
  if (existing) throw new Error(`native proof already exists: ${proofPath}`)
  await writeJson(proofPath, proof)
}

export async function verifyNative(args: Args): Promise<void> {
  const phase = phaseOf(args)
  if (phase === 'build') return await buildPhase(args)
  if (phase === 'execute') return await executePhase(args)
  await mergePhase(args)
}

if (import.meta.main) {
  try {
    await verifyNative(parseArgs(Deno.args))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    Deno.exit(1)
  }
}
