/**
 * Source-material release gate. This is deliberately separate from notice
 * generation: a notice is not a relinkable source distribution.
 */
import { createHash } from 'node:crypto'
import { buildRuntimeNotices } from './runtime-notices.ts'
import { canonicalTargetDescriptorBytes } from '../../source-rebuild/prepare-tools.ts'

const SHA256 = /^[a-f0-9]{64}$/
const SHA40 = /^[a-f0-9]{40}$/
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

export type Pin = {
  commit: string
  archive: string
  sha256: string
  version?: string
}
export type GitlinkClosurePin = {
  path: 'source-materials/rusty-v8-gitlinks.json'
  sha256: string
}
export type Pins = {
  schema_version: 1
  deno: Pin
  rusty_v8: Pin
  v8: Pin
  gitlink_closure: GitlinkClosurePin
}
export type FileRecord = {
  path: string
  sha256: string
  size: number
  link?: string
}
export type SourceAssetName =
  | 'slv-source.tar.gz'
  | 'deno-source.tar.gz'
  | 'deno-cargo-vendor.tar.gz'
export type SourceAsset = {
  name: SourceAssetName
  sha256: string
  size: number
  embedded_manifest_path: string
}
type RuntimeSecurityReceipt = {
  upstream: {
    cargo_lock: { path: string; sha256: string; package_count: number }
    cargo_manifest: { path: string; sha256: string }
  }
  selected: {
    cargo_lock: { path: string; sha256: string; package_count: number }
    cargo_manifest: { path: string; sha256: string }
  }
  transform: {
    selection: { path: string; sha256: string }
    manifest_patch: { path: string; sha256: string }
    resolution_receipt: { path: string; sha256: string }
    added_identities_osv: { path: string; sha256: string }
  }
  allowed_delta: {
    added: string[]
    removed: string[]
    changed_same_identity: string[]
  }
}
export type SourceMaterialsReceipt = {
  schema_version: 1
  kind: 'slv-source-materials'
  mode: 'reviewed' | 'diagnostic'
  source: {
    commit: string
    tree_sha256: string
    timestamp: string
    timestamp_epoch: number
  }
  canonical_notice: { path: string; sha256: string; size: number }
  pins: Pins & { sha256: string }
  closure: { embedded_path: string; sha256: string; entry_count: number }
  inventory: { embedded_path: string; sha256: string }
  vendor: {
    policy: 'full-locked-vendor'
    lock_path: string
    lock_sha256: string
    crate_count: number
    omissions: []
  }
  /**
   * The checked-in, narrow transform from Deno's upstream Cargo inputs to
   * the security-selected build inputs.  The original files remain in the
   * source archive as evidence; `selected` is the only build/vendor input.
   */
  runtime_security: RuntimeSecurityReceipt
  gitlink_closure: {
    path: 'source-materials/rusty-v8-gitlinks.json'
    sha256: string
    root_tree: string
    gitlink_count: number
  }
  source_legal_evidence: {
    index_path: 'source-materials/rusty-v8-source-license-index.json'
    sha256: string
    source_distributed_extra_tree_count: number
    supplement_count: number
  }
  assets: SourceAsset[]
  rebuild_proof: {
    required: true
    status: 'separate' | 'verified'
    receipt_sha256?: string
  }
}
export type ReceiptExpectation = {
  sourceCommit?: string
  canonicalNoticeSha256?: string
  requireVerifiedRebuildProof?: boolean
}

// These are release-assembly roots observed to hold generated objects or a
// downloaded compiler.  They are deliberately exact roots, rather than a
// blanket `**/target/**` rule: upstream source fixtures are allowed to use a
// directory named `target` when it is part of their tracked source.
export const GENERATED_SOURCE_ROOTS = [
  'deno/target',
  'rusty_v8/target',
  'rusty_v8/v8/out',
  'rusty_v8/third_party/rust-toolchain',
] as const

const GITLINK_DESCRIPTOR_PATH = 'source-materials/rusty-v8-gitlinks.json'
const SOURCE_LICENSE_INDEX_PATH =
  'source-materials/rusty-v8-source-license-index.json'
const SOURCE_LICENSE_SUPPLEMENT_PREFIX =
  'source-materials/source-license-supplements/'

export async function sha256(path: string): Promise<string> {
  const handle = await Deno.open(path)
  const hash = createHash('sha256')
  try {
    const chunk = new Uint8Array(1024 * 1024)
    for (;;) {
      const length = await handle.read(chunk)
      if (length === null) break
      hash.update(chunk.subarray(0, length))
    }
  } finally {
    handle.close()
  }
  return hash.digest('hex')
}

export function assertPins(value: unknown): asserts value is Pins {
  if (!value || typeof value !== 'object') {
    throw new Error('pins must be an object')
  }
  const pins = value as Partial<Pins>
  if (pins.schema_version !== 1) throw new Error('unsupported pins schema')
  for (const name of ['deno', 'rusty_v8', 'v8'] as const) {
    const pin = pins[name]
    if (!pin || !SHA40.test(pin.commit) || !SHA256.test(pin.sha256)) {
      throw new Error(`invalid ${name} pin`)
    }
    let url: URL
    try {
      url = new URL(pin.archive)
    } catch {
      throw new Error(`invalid ${name} archive URL`)
    }
    if (
      url.protocol !== 'https:' ||
      !['github.com', 'codeload.github.com'].includes(url.hostname)
    ) {
      throw new Error(
        `${name} archive must be a public immutable GitHub HTTPS URL`,
      )
    }
    if (
      name === 'deno' &&
      (!pin.version || !url.pathname.includes(`v${pin.version}`))
    ) {
      throw new Error('deno archive does not bind its release version')
    }
    if (name !== 'deno' && !url.pathname.includes(pin.commit)) {
      throw new Error(`${name} archive does not bind its commit`)
    }
  }
  const closure = pins.gitlink_closure
  if (
    !closure || closure.path !== GITLINK_DESCRIPTOR_PATH ||
    typeof closure.sha256 !== 'string' || !SHA256.test(closure.sha256)
  ) {
    throw new Error('invalid rusty_v8 gitlink closure pin')
  }
}

export async function readPins(path: string): Promise<Pins> {
  const pins = JSON.parse(await Deno.readTextFile(path))
  assertPins(pins)
  return pins
}

export async function verifyPinnedArchive(
  path: string,
  pin: Pin,
): Promise<void> {
  const info = await Deno.stat(path)
  if (!info.isFile || info.size <= 0 || info.size >= MAX_ARCHIVE_BYTES) {
    throw new Error(
      `archive must be a non-empty regular file below 2 GiB: ${path}`,
    )
  }
  if (await sha256(path) !== pin.sha256) {
    throw new Error(`pinned archive checksum mismatch: ${path}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertSafeArchivePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' || !value || value.startsWith('/') ||
    value.includes('..') || value.includes('\\')
  ) {
    throw new Error(`invalid ${label}`)
  }
}

const SECURITY_DELTA = {
  added: [
    'aws-lc-rs@1.18.2',
    'aws-lc-sys@0.46.0',
    'h2@0.4.16',
    'pkg-config@0.3.34',
    'rustls@0.23.45',
    'rustls-webpki@0.103.15',
  ],
  removed: [
    'aws-lc-rs@1.16.3',
    'h2@0.4.7',
    'pkg-config@0.3.30',
    'rustls@0.23.40',
    'rustls-webpki@0.103.13',
  ],
  changed_same_identity: [
    'deno_crypto_provider@0.49.0',
    'deno_node_crypto@0.25.0',
  ],
} as const

function sameStrings(left: string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
}

function parseRuntimeSecurityReceipt(value: unknown): RuntimeSecurityReceipt {
  if (!isRecord(value)) throw new Error('invalid runtime security receipt')
  const parseIdentity = (
    candidate: unknown,
    label: string,
    expectedPath: string,
    withPackageCount: boolean,
  ) => {
    if (
      !isRecord(candidate) || candidate.path !== expectedPath ||
      typeof candidate.sha256 !== 'string' || !SHA256.test(candidate.sha256)
    ) {
      throw new Error(`invalid runtime security ${label}`)
    }
    if (!withPackageCount) {
      if (Object.keys(candidate).length !== 2) {
        throw new Error(`invalid runtime security ${label}`)
      }
      return { path: candidate.path, sha256: candidate.sha256 }
    }
    if (
      Object.keys(candidate).length !== 3 ||
      !Number.isSafeInteger(candidate.package_count) ||
      (candidate.package_count as number) <= 0
    ) {
      throw new Error(`invalid runtime security ${label}`)
    }
    return {
      path: candidate.path,
      sha256: candidate.sha256,
      package_count: candidate.package_count as number,
    }
  }
  const upstream = value.upstream
  const selected = value.selected
  const transform = value.transform
  const allowedDelta = value.allowed_delta
  if (
    !isRecord(upstream) || !isRecord(selected) || !isRecord(transform) ||
    !isRecord(allowedDelta)
  ) {
    throw new Error('invalid runtime security receipt')
  }
  if (
    Object.keys(upstream).length !== 2 || Object.keys(selected).length !== 2 ||
    Object.keys(transform).length !== 4 ||
    Object.keys(allowedDelta).length !== 3
  ) throw new Error('invalid runtime security receipt')
  const parsed = {
    upstream: {
      cargo_lock: parseIdentity(
        upstream.cargo_lock,
        'upstream Cargo.lock',
        'source-materials/security/upstream-Cargo.lock',
        true,
      ) as RuntimeSecurityReceipt['upstream']['cargo_lock'],
      cargo_manifest: parseIdentity(
        upstream.cargo_manifest,
        'upstream Cargo.toml',
        'source-materials/security/upstream-Cargo.toml',
        false,
      ) as RuntimeSecurityReceipt['upstream']['cargo_manifest'],
    },
    selected: {
      cargo_lock: parseIdentity(
        selected.cargo_lock,
        'selected Cargo.lock',
        'deno/Cargo.lock',
        true,
      ) as RuntimeSecurityReceipt['selected']['cargo_lock'],
      cargo_manifest: parseIdentity(
        selected.cargo_manifest,
        'selected Cargo.toml',
        'deno/Cargo.toml',
        false,
      ) as RuntimeSecurityReceipt['selected']['cargo_manifest'],
    },
    transform: {
      selection: parseIdentity(
        transform.selection,
        'selection',
        'source-materials/security/selection.json',
        false,
      ) as RuntimeSecurityReceipt['transform']['selection'],
      manifest_patch: parseIdentity(
        transform.manifest_patch,
        'manifest patch',
        'source-materials/security/manifest-patch.json',
        false,
      ) as RuntimeSecurityReceipt['transform']['manifest_patch'],
      resolution_receipt: parseIdentity(
        transform.resolution_receipt,
        'resolution receipt',
        'source-materials/security/resolution-receipt.json',
        false,
      ) as RuntimeSecurityReceipt['transform']['resolution_receipt'],
      added_identities_osv: parseIdentity(
        transform.added_identities_osv,
        'added identities OSV receipt',
        'source-materials/security/added-identities-osv.json',
        false,
      ) as RuntimeSecurityReceipt['transform']['added_identities_osv'],
    },
    allowed_delta: {
      added: allowedDelta.added,
      removed: allowedDelta.removed,
      changed_same_identity: allowedDelta.changed_same_identity,
    },
  }
  for (const [label, expected] of Object.entries(SECURITY_DELTA)) {
    const actual = parsed.allowed_delta[label as keyof typeof SECURITY_DELTA]
    if (
      !Array.isArray(actual) || !actual.every((item) =>
        typeof item === 'string'
      ) ||
      !sameStrings(actual as string[], expected)
    ) {
      throw new Error(`invalid runtime security ${label} delta`)
    }
  }
  if (
    parsed.selected.cargo_lock.package_count !==
      parsed.upstream.cargo_lock.package_count + 1
  ) {
    throw new Error(
      'security-selected Cargo.lock has an unexpected package count',
    )
  }
  return parsed as RuntimeSecurityReceipt
}

/**
 * Validate the portable source-package contract before a release pack copies
 * any asset.  This checks receipt semantics only; use verifyReceiptFiles to
 * stream-check the three archive bytes at their staging boundary.
 */
export function verifySourceMaterialsReceipt(
  value: unknown,
  expected: ReceiptExpectation = {},
): SourceMaterialsReceipt {
  if (!isRecord(value)) {
    throw new Error('source materials receipt must be an object')
  }
  if (value.schema_version !== 1 || value.kind !== 'slv-source-materials') {
    throw new Error('unsupported source materials receipt')
  }
  if (value.mode !== 'reviewed' && value.mode !== 'diagnostic') {
    throw new Error('invalid source materials receipt mode')
  }
  if (value.mode !== 'reviewed') {
    throw new Error('diagnostic source materials receipt cannot be released')
  }

  const source = value.source
  if (
    !isRecord(source) || typeof source.commit !== 'string' ||
    !SHA40.test(source.commit) ||
    typeof source.tree_sha256 !== 'string' ||
    !SHA256.test(source.tree_sha256) ||
    typeof source.timestamp !== 'string' ||
    !Number.isSafeInteger(source.timestamp_epoch) ||
    (source.timestamp_epoch as number) < 0 ||
    Number.isNaN(Date.parse(source.timestamp))
  ) {
    throw new Error('invalid source identity')
  }
  if (expected.sourceCommit && source.commit !== expected.sourceCommit) {
    throw new Error(
      'source receipt commit differs from expected release commit',
    )
  }

  const notice = value.canonical_notice
  if (
    !isRecord(notice) || typeof notice.sha256 !== 'string' ||
    !SHA256.test(notice.sha256) ||
    !Number.isSafeInteger(notice.size) || (notice.size as number) <= 0
  ) throw new Error('invalid canonical notice identity')
  assertSafeArchivePath(notice.path, 'canonical notice path')
  if (
    expected.canonicalNoticeSha256 &&
    notice.sha256 !== expected.canonicalNoticeSha256
  ) {
    throw new Error(
      'source receipt canonical notice differs from release canonical notice',
    )
  }

  const pins = value.pins
  if (
    !isRecord(pins) || typeof pins.sha256 !== 'string' ||
    !SHA256.test(pins.sha256)
  ) throw new Error('invalid source pin identity')
  assertPins(pins)

  const closure = value.closure
  if (
    !isRecord(closure) || typeof closure.sha256 !== 'string' ||
    !SHA256.test(closure.sha256) ||
    !Number.isSafeInteger(closure.entry_count) ||
    (closure.entry_count as number) <= 0
  ) throw new Error('invalid source closure identity')
  assertSafeArchivePath(closure.embedded_path, 'closure embedded path')
  const inventory = value.inventory
  if (
    !isRecord(inventory) || typeof inventory.sha256 !== 'string' ||
    !SHA256.test(inventory.sha256)
  ) throw new Error('invalid source inventory identity')
  assertSafeArchivePath(inventory.embedded_path, 'inventory embedded path')

  const vendor = value.vendor
  if (
    !isRecord(vendor) || vendor.policy !== 'full-locked-vendor' ||
    typeof vendor.lock_sha256 !== 'string' ||
    !SHA256.test(vendor.lock_sha256) ||
    !Number.isSafeInteger(vendor.crate_count) ||
    (vendor.crate_count as number) <= 0 ||
    !Array.isArray(vendor.omissions) || vendor.omissions.length !== 0
  ) throw new Error('invalid full vendor receipt')
  assertSafeArchivePath(vendor.lock_path, 'vendor lock path')

  parseRuntimeSecurityReceipt(value.runtime_security)

  const gitlinkClosure = value.gitlink_closure
  if (
    !isRecord(gitlinkClosure) ||
    gitlinkClosure.path !== GITLINK_DESCRIPTOR_PATH ||
    typeof gitlinkClosure.sha256 !== 'string' ||
    !SHA256.test(gitlinkClosure.sha256) ||
    typeof gitlinkClosure.root_tree !== 'string' ||
    !SHA40.test(gitlinkClosure.root_tree) ||
    !Number.isSafeInteger(gitlinkClosure.gitlink_count) ||
    (gitlinkClosure.gitlink_count as number) <= 0 ||
    gitlinkClosure.sha256 !== pins.gitlink_closure.sha256
  ) {
    throw new Error('invalid rusty_v8 gitlink closure binding')
  }

  const sourceLegalEvidence = value.source_legal_evidence
  if (
    !isRecord(sourceLegalEvidence) ||
    sourceLegalEvidence.index_path !== SOURCE_LICENSE_INDEX_PATH ||
    typeof sourceLegalEvidence.sha256 !== 'string' ||
    !SHA256.test(sourceLegalEvidence.sha256) ||
    !Number.isSafeInteger(
      sourceLegalEvidence.source_distributed_extra_tree_count,
    ) ||
    (sourceLegalEvidence.source_distributed_extra_tree_count as number) !== 7 ||
    !Number.isSafeInteger(sourceLegalEvidence.supplement_count) ||
    (sourceLegalEvidence.supplement_count as number) < 3
  ) {
    throw new Error(
      'invalid source-distributed extra-tree legal evidence binding',
    )
  }

  const names: SourceAssetName[] = [
    'slv-source.tar.gz',
    'deno-source.tar.gz',
    'deno-cargo-vendor.tar.gz',
  ]
  if (!Array.isArray(value.assets) || value.assets.length !== names.length) {
    throw new Error('source receipt must bind exactly three source archives')
  }
  const seen = new Set<string>()
  for (const asset of value.assets) {
    if (
      !isRecord(asset) || typeof asset.name !== 'string' ||
      !names.includes(asset.name as SourceAssetName) || seen.has(asset.name) ||
      typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      (asset.size as number) <= 0 || (asset.size as number) >= MAX_ARCHIVE_BYTES
    ) throw new Error('invalid source archive receipt')
    assertSafeArchivePath(
      asset.embedded_manifest_path,
      'embedded archive manifest path',
    )
    seen.add(asset.name)
  }
  if (names.some((name) => !seen.has(name))) {
    throw new Error('source archive receipt is missing a required archive')
  }

  const proof = value.rebuild_proof
  if (
    !isRecord(proof) || proof.required !== true ||
    (proof.status !== 'separate' && proof.status !== 'verified') ||
    (proof.receipt_sha256 !== undefined &&
      (typeof proof.receipt_sha256 !== 'string' ||
        !SHA256.test(proof.receipt_sha256)))
  ) {
    throw new Error('invalid rebuild proof binding')
  }
  if (
    expected.requireVerifiedRebuildProof &&
    (proof.status !== 'verified' || !proof.receipt_sha256)
  ) {
    throw new Error('native rebuild proof has not been bound to source receipt')
  }
  return value as unknown as SourceMaterialsReceipt
}

export async function verifyReceiptFiles(
  receiptValue: unknown,
  outputDirectory: string,
  expected: ReceiptExpectation = {},
): Promise<SourceMaterialsReceipt> {
  const receipt = verifySourceMaterialsReceipt(receiptValue, expected)
  for (const asset of receipt.assets) {
    const path = `${outputDirectory}/${asset.name}`
    const info = await Deno.stat(path).catch(() => undefined)
    if (
      !info?.isFile || info.size !== asset.size ||
      info.size >= MAX_ARCHIVE_BYTES || await sha256(path) !== asset.sha256
    ) {
      throw new Error(`source archive bytes differ from receipt: ${asset.name}`)
    }
  }
  return receipt
}

function lexicalSymlinkPath(path: string, label: string): string[] {
  if (
    !path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
  ) {
    throw new Error('unsafe ' + label + ': ' + path)
  }
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segments.length) throw new Error('unsafe ' + label + ': ' + path)
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments
}

async function assertLexicalSymlink(
  root: string,
  linkPath: string,
  target: string,
): Promise<void> {
  if (
    target.startsWith('/') || target.includes('\\') || target.includes('\0')
  ) {
    throw new Error('unsafe source symlink: ' + linkPath + ' -> ' + target)
  }
  // Resolve components in order. Collapsing `..` before expanding a nested
  // symlink is unsafe: `a -> ../target`, followed by `a/../../outside`, can
  // otherwise escape the archive even though the raw target is relative.
  const resolved = linkPath.split('/').slice(0, -1).filter(Boolean)
  let pending = target.split('/')
  const seen = new Set([linkPath])
  while (pending.length) {
    const part = pending.shift()!
    if (!part || part === '.') continue
    if (part === '..') {
      if (!resolved.length) {
        throw new Error('unsafe source symlink target: ' + linkPath)
      }
      resolved.pop()
      continue
    }
    resolved.push(part)
    const current = resolved.join('/')
    const stat = await Deno.lstat(join(root, current)).catch(() => undefined)
    // Pinned upstream test fixtures can intentionally be dangling. Their
    // lexical path is still confined to the source archive, so preserve it.
    if (!stat) {
      lexicalSymlinkPath(
        [...resolved, ...pending].join('/') || '.',
        'source symlink target',
      )
      return
    }
    if (stat.isSymlink) {
      if (seen.has(current)) {
        throw new Error('cyclic source symlink: ' + linkPath + ' -> ' + target)
      }
      seen.add(current)
      const nestedTarget = await Deno.readLink(join(root, current))
      if (
        nestedTarget.startsWith('/') || nestedTarget.includes('\\') ||
        nestedTarget.includes('\0')
      ) {
        throw new Error(
          'unsafe source symlink: ' + current + ' -> ' + nestedTarget,
        )
      }
      resolved.pop()
      pending = [...nestedTarget.split('/'), ...pending]
      continue
    }
    if (pending.length && !stat.isDirectory) {
      throw new Error('source symlink traverses a non-directory: ' + linkPath)
    }
  }
}

async function walk(root: string, relative = ''): Promise<FileRecord[]> {
  const entries: FileRecord[] = []
  for await (
    const child of Deno.readDir(relative ? `${root}/${relative}` : root)
  ) {
    const path = relative ? `${relative}/${child.name}` : child.name
    const absolute = `${root}/${path}`
    const stat = await Deno.lstat(absolute)
    if (!(stat.isFile || stat.isDirectory || stat.isSymlink)) {
      throw new Error(
        `source materials forbid non-file/non-directory entry: ${path}`,
      )
    }
    if (stat.isDirectory) entries.push(...await walk(root, path))
    else if (stat.isSymlink) {
      const target = await Deno.readLink(absolute)
      await assertLexicalSymlink(root, path, target)
      const bytes = new TextEncoder().encode(target)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      entries.push({
        path,
        link: target,
        size: 0,
        sha256: [...new Uint8Array(digest)].map((byte) =>
          byte.toString(16).padStart(2, '0')
        ).join(''),
      })
    } else {entries.push({
        path,
        sha256: await sha256(absolute),
        size: stat.size,
      })}
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

async function hasDirectoryEntry(path: string): Promise<boolean> {
  for await (const _entry of Deno.readDir(path)) return true
  return false
}

/** Reject URL placeholders and missing material before an archive is released. */
export async function assertSourceClosure(
  root: string,
  requiredPaths: string[],
): Promise<void> {
  for (const path of requiredPaths) {
    if (
      !path || path.startsWith('/') || path.includes('..') ||
      path.includes('\\')
    ) {
      throw new Error(`unsafe required source path: ${path}`)
    }
    const source = `${root}/${path}`
    const stat = await Deno.lstat(source).catch(() => undefined)
    if (!stat || !(stat.isFile || stat.isDirectory)) {
      throw new Error(`missing required source material: ${path}`)
    }
    if (stat.isDirectory && !await hasDirectoryEntry(source)) {
      throw new Error(`empty source material directory: ${path}`)
    }
  }
  for (const file of await walk(root)) {
    if (file.link) continue
    const handle = await Deno.open(`${root}/${file.path}`)
    try {
      const bytes = new Uint8Array(Math.min(file.size, 128))
      await handle.read(bytes)
      if (
        new TextDecoder().decode(bytes).startsWith(
          'version https://git-lfs.github.com/spec/v1',
        )
      ) {
        throw new Error(`LFS pointer is not source material: ${file.path}`)
      }
    } finally {
      handle.close()
    }
  }
}

/**
 * Reject release-assembly output and repository metadata from the composite
 * source tree.  Run this after assembly and before inventory/packing; do not
 * use it to decide which upstream source paths to copy.
 */
export async function assertPureSourceTree(root: string): Promise<void> {
  for (const relative of GENERATED_SOURCE_ROOTS) {
    const stat = await Deno.lstat(`${root}/${relative}`).catch(() => undefined)
    if (stat) {
      throw new Error(
        `generated or compiler material is not source: ${relative}`,
      )
    }
  }

  async function check(directory: string, relative = ''): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.name === '.git') {
        throw new Error(`repository metadata is not release source: ${path}`)
      }
      if (entry.isDirectory) await check(`${directory}/${entry.name}`, path)
    }
  }
  await check(root)
}

/** Write a deterministic manifest for an already materialized, public-only tree. */
export async function writeInventory(
  root: string,
  output: string,
): Promise<FileRecord[]> {
  const normalizedRoot = await Deno.realPath(root)
  const parent = output.includes('/')
    ? output.slice(0, output.lastIndexOf('/')) || '/'
    : '.'
  const normalizedOutput = `${await Deno.realPath(parent)}/${
    output.slice(output.lastIndexOf('/') + 1)
  }`
  if (
    normalizedOutput === normalizedRoot ||
    normalizedOutput.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error('write source inventory outside the source material tree')
  }
  const records = await walk(root)
  if (!records.length) throw new Error('source material tree is empty')
  await Deno.writeTextFile(
    output,
    JSON.stringify({ schema_version: 1, files: records }, null, 2) + '\n',
  )
  return records
}

export async function verifyInventory(
  root: string,
  inventory: string,
): Promise<void> {
  const expected = JSON.parse(await Deno.readTextFile(inventory)) as {
    schema_version?: unknown
    files?: FileRecord[]
  }
  if (expected.schema_version !== 1 || !Array.isArray(expected.files)) {
    throw new Error('invalid source inventory')
  }
  const observed = await walk(root)
  if (JSON.stringify(observed) !== JSON.stringify(expected.files)) {
    throw new Error('source tree differs from inventory')
  }
}

const SOURCE_ARCHIVES = [
  'slv-source.tar.gz',
  'deno-source.tar.gz',
  'deno-cargo-vendor.tar.gz',
] as const
const SOURCE_ARCHIVE_ROOTS: Record<SourceAssetName, string> = {
  'slv-source.tar.gz': 'slv-source',
  'deno-source.tar.gz': 'deno-source',
  'deno-cargo-vendor.tar.gz': 'deno-cargo-vendor',
}
/** Archive-relative canonical notice name, shared with the release packer. */
export const CANONICAL_NOTICE_NAME = 'THIRD_PARTY_NOTICES'
const METADATA_DIRECTORY = 'source-materials'
const CARGO_CONFIG = `[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "../vendor"

[net]
offline = true
`

export type SourcePackageOptions = {
  sourceRoot: string
  sourceCommit: string
  pinsPath: string
  cache: string
  workDir: string
  outputDirectory: string
  receiptPath: string
  noticeFile: string
}

type CommandOptions = { cwd?: string; env?: Record<string, string> }
type CommandOutput = { stdout: Uint8Array; stderr: Uint8Array }
type ReviewedSource = {
  root: string
  commit: string
  treeSha256: string
  timestamp: string
  timestampEpoch: number
}
type GitTreeRecord = {
  path: string
  mode: '100644' | '100755' | '120000'
  blob: string
  sha256: string
  size: number
}
type GitTreeInventory = {
  schema_version: 1
  repository: string
  commit: string
  tree: string
  files: GitTreeRecord[]
}
type GitlinkDescriptorEntry = {
  path: string
  repository: string
  commit: string
  tree: string
  inventory_path: string
  inventory_sha256: string
}
type GitlinkClosureDescriptor = {
  schema_version: 1
  kind: 'rusty-v8-gitlink-closure'
  root: Omit<GitlinkDescriptorEntry, 'path'>
  gitlinks: GitlinkDescriptorEntry[]
}
type GitObjectStore = {
  repository: string
  commit: string
  tree: string
  path: string
}
type CargoPackage = { name: string; version: string; checksum: string }
type SourceVendorCoverage = {
  indexSha256: string
  receiptPath: string
  receiptSha256: string
  disposition: 'complete' | 'complete-with-qualification'
  registryPackageCount: number
  qualifiedComponents: Array<{
    component: string
    classification: string
    directLaterLicenseLinked: number
    historicalScopeInferencePaths: string[]
  }>
}

const join = (...parts: string[]) => parts.join('/').replaceAll(/\/{2,}/g, '/')
const decode = (value: Uint8Array) => new TextDecoder().decode(value)
const sha256Bytes = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

async function command(
  program: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandOutput> {
  let result: Deno.CommandOutput
  try {
    result = await new Deno.Command(program, {
      args,
      cwd: options.cwd,
      env: options.env,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
  } catch (error) {
    throw new Error(
      `cannot run ${program}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!result.success) {
    const detail = decode(result.stderr).trim() || decode(result.stdout).trim()
    throw new Error(`${program} failed: ${detail || `exit ${result.code}`}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

async function ensureEmptyDirectory(
  path: string,
  label: string,
): Promise<void> {
  const existing = await Deno.lstat(path).catch(() => undefined)
  if (!existing) {
    await Deno.mkdir(path, { recursive: true })
    return
  }
  if (!existing.isDirectory || existing.isSymlink) {
    throw new Error(`${label} must be an empty directory: ${path}`)
  }
  for await (const _entry of Deno.readDir(path)) {
    throw new Error(`${label} must be empty: ${path}`)
  }
}

async function ensureAbsentFile(path: string, label: string): Promise<void> {
  const existing = await Deno.lstat(path).catch(() => undefined)
  if (existing) throw new Error(`${label} must not already exist: ${path}`)
  const parent = path.slice(0, path.lastIndexOf('/')) || '.'
  await Deno.mkdir(parent, { recursive: true })
}

async function reviewedSource(
  sourceRoot: string,
  sourceCommit: string,
): Promise<ReviewedSource> {
  if (!SHA40.test(sourceCommit)) {
    throw new Error('source commit must be a full SHA-1')
  }
  const root = await Deno.realPath(sourceRoot)
  const stat = await Deno.stat(root)
  if (!stat.isDirectory) throw new Error('source root must be a directory')
  const head = decode(
    (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout,
  ).trim()
  if (head !== sourceCommit) {
    throw new Error('source root HEAD differs from reviewed source commit')
  }
  const status = decode(
    (await command('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ], { cwd: root })).stdout,
  )
  if (status) throw new Error('source root is not clean')
  const timestamp = decode(
    (await command('git', [
      'show',
      '-s',
      '--format=%cI',
      sourceCommit,
    ], { cwd: root })).stdout,
  ).trim()
  const timestampEpoch = Number(
    decode(
      (await command('git', [
        'show',
        '-s',
        '--format=%ct',
        sourceCommit,
      ], { cwd: root })).stdout,
    ).trim(),
  )
  if (
    Number.isNaN(Date.parse(timestamp)) ||
    !Number.isSafeInteger(timestampEpoch) || timestampEpoch < 0
  ) {
    throw new Error('reviewed source commit has an invalid timestamp')
  }
  const tree = (await command('git', [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    sourceCommit,
  ], { cwd: root })).stdout
  if (!tree.length) throw new Error('reviewed source tree is empty')
  return {
    root,
    commit: sourceCommit,
    treeSha256: sha256Bytes(tree),
    timestamp,
    timestampEpoch,
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const info = await Deno.lstat(source)
  if (info.isSymlink) {
    await Deno.symlink(await Deno.readLink(source), destination)
    return
  }
  if (info.isFile) {
    await Deno.copyFile(source, destination)
    return
  }
  if (!info.isDirectory) {
    throw new Error(`unsupported source material entry: ${source}`)
  }
  await Deno.mkdir(destination, { recursive: true })
  const entries: Deno.DirEntry[] = []
  for await (const entry of Deno.readDir(source)) entries.push(entry)
  for (
    const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  ) {
    await copyTree(join(source, entry.name), join(destination, entry.name))
  }
}

async function acquirePinnedArchive(cache: string, pin: Pin): Promise<string> {
  const directory = join(cache, 'archives')
  const path = join(directory, `${pin.sha256}.tar.gz`)
  await Deno.mkdir(directory, { recursive: true })
  const existing = await Deno.lstat(path).catch(() => undefined)
  if (existing) {
    if (!existing.isFile || existing.isSymlink) {
      throw new Error(`cached pin is not a regular file: ${path}`)
    }
    await verifyPinnedArchive(path, pin)
    return path
  }
  const response = await fetch(pin.archive)
  if (!response.ok || !response.body) {
    throw new Error(`pinned source acquisition failed: ${pin.archive}`)
  }
  const temporary = `${path}.partial-${crypto.randomUUID()}`
  try {
    const file = await Deno.open(temporary, { write: true, createNew: true })
    await response.body.pipeTo(file.writable)
    await verifyPinnedArchive(temporary, pin)
    await Deno.rename(temporary, path)
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined)
    throw error
  }
  return path
}

async function extractPinnedArchive(
  archive: string,
  expectedRoot: string,
  destination: string,
): Promise<void> {
  const listed = decode((await command('tar', ['-tzf', archive])).stdout)
  const entries = listed.split('\n').filter(Boolean)
  if (
    !entries.length || entries.some((entry) => {
      const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry
      return !normalized || normalized.startsWith('/') ||
        normalized.includes('\\') ||
        normalized.split('/').some((part) => part === '.' || part === '..') ||
        (normalized !== expectedRoot &&
          !normalized.startsWith(`${expectedRoot}/`))
    })
  ) {
    throw new Error(
      `pinned source archive has an unsafe or unexpected root: ${archive}`,
    )
  }
  await Deno.mkdir(destination, { recursive: true })
  await command('tar', [
    '--no-same-owner',
    '--no-same-permissions',
    '--strip-components=1',
    '-xzf',
    archive,
    '-C',
    destination,
  ])
}

async function archiveGitTree(
  source: ReviewedSource,
  destination: string,
): Promise<void> {
  const temporary = `${destination}.tar`
  await command('git', [
    'archive',
    '--format=tar',
    '--prefix=slv-source/',
    '-o',
    temporary,
    source.commit,
  ], { cwd: source.root })
  try {
    const listed = decode((await command('tar', ['-tf', temporary])).stdout)
    if (
      !listed.split('\n').filter(Boolean).every((entry) =>
        entry === 'slv-source/' || entry.startsWith('slv-source/')
      )
    ) throw new Error('git archive has an unexpected source root')
    await command('tar', ['-xf', temporary, '-C', destination])
  } finally {
    await Deno.remove(temporary).catch(() => undefined)
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) throw new Error(`invalid ${label} shape`)
}

function publicGitRepository(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`invalid ${label} repository`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`invalid ${label} repository`)
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port ||
    url.search || url.hash ||
    !['github.com', 'chromium.googlesource.com'].includes(url.hostname) ||
    !url.pathname.startsWith('/') || url.pathname.includes('..') ||
    url.toString() !== value
  ) throw new Error(`invalid ${label} repository`)
  return value
}

function gitPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || !value || value.startsWith('/') ||
    value.includes('\\') || value.includes('\0') ||
    value.split('/').some((part) =>
      !part || part === '.' || part === '..' || part === '.git'
    )
  ) throw new Error(`invalid ${label} path`)
  return value
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA40.test(value)) {
    throw new Error(`invalid ${label} Git identity`)
  }
  return value
}

function gitInventoryPath(value: unknown, label: string): string {
  const path = gitPath(value, label)
  if (
    !path.startsWith('source-materials/rusty-v8-gitlink-inventories/') ||
    !path.endsWith('.json')
  ) throw new Error(`invalid ${label} path`)
  return path
}

function parseGitlinkDescriptor(
  value: unknown,
  pins: Pins,
): GitlinkClosureDescriptor {
  const descriptor = requiredObject(value, 'rusty_v8 gitlink descriptor')
  exactKeys(
    descriptor,
    ['schema_version', 'kind', 'root', 'gitlinks'],
    'rusty_v8 gitlink descriptor',
  )
  if (
    descriptor.schema_version !== 1 ||
    descriptor.kind !== 'rusty-v8-gitlink-closure'
  ) throw new Error('unsupported rusty_v8 gitlink descriptor')
  const parseEntry = (
    raw: unknown,
    label: string,
    includePath: boolean,
  ): GitlinkDescriptorEntry => {
    const entry = requiredObject(raw, label)
    exactKeys(
      entry,
      includePath
        ? [
          'path',
          'repository',
          'commit',
          'tree',
          'inventory_path',
          'inventory_sha256',
        ]
        : [
          'repository',
          'commit',
          'tree',
          'inventory_path',
          'inventory_sha256',
        ],
      label,
    )
    return {
      ...(includePath ? { path: gitPath(entry.path, label) } : { path: '' }),
      repository: publicGitRepository(entry.repository, label),
      commit: gitSha(entry.commit, label),
      tree: gitSha(entry.tree, label),
      inventory_path: gitInventoryPath(entry.inventory_path, label),
      inventory_sha256: requiredSha256(entry.inventory_sha256, label),
    }
  }
  const root = parseEntry(descriptor.root, 'rusty_v8 gitlink root', false)
  if (
    root.repository !== 'https://github.com/denoland/rusty_v8.git' ||
    root.commit !== pins.rusty_v8.commit ||
    root.inventory_path !==
      'source-materials/rusty-v8-gitlink-inventories/rusty_v8.json'
  ) throw new Error('rusty_v8 gitlink root differs from source pin')
  if (!Array.isArray(descriptor.gitlinks) || !descriptor.gitlinks.length) {
    throw new Error('rusty_v8 gitlink descriptor has no gitlinks')
  }
  const gitlinks = descriptor.gitlinks.map((entry, index) =>
    parseEntry(entry, `rusty_v8 gitlink ${index}`, true)
  )
  const paths = new Set<string>()
  const inventories = new Set<string>()
  for (const entry of gitlinks) {
    if (paths.has(entry.path) || inventories.has(entry.inventory_path)) {
      throw new Error('rusty_v8 gitlink descriptor has duplicate entries')
    }
    paths.add(entry.path)
    inventories.add(entry.inventory_path)
  }
  if (
    gitlinks.some((entry, index) =>
      index > 0 && gitlinks[index - 1].path.localeCompare(entry.path) >= 0
    )
  ) throw new Error('rusty_v8 gitlink descriptor is not canonically ordered')
  const v8 = gitlinks.find((entry) => entry.path === 'v8')
  if (
    !v8 || v8.repository !== 'https://github.com/denoland/v8.git' ||
    v8.commit !== pins.v8.commit
  ) throw new Error('rusty_v8 gitlink descriptor differs from V8 source pin')
  return {
    schema_version: 1,
    kind: 'rusty-v8-gitlink-closure',
    root: {
      repository: root.repository,
      commit: root.commit,
      tree: root.tree,
      inventory_path: root.inventory_path,
      inventory_sha256: root.inventory_sha256,
    },
    gitlinks,
  }
}

async function readGitlinkDescriptor(
  sourceRoot: string,
  pins: Pins,
): Promise<{ descriptor: GitlinkClosureDescriptor; sha256: string }> {
  const path = join(sourceRoot, pins.gitlink_closure.path)
  await requireRegularFile(path, 'rusty_v8 gitlink descriptor')
  const digest = await sha256(path)
  if (digest !== pins.gitlink_closure.sha256) {
    throw new Error(
      'rusty_v8 gitlink descriptor checksum differs from source pin',
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(await Deno.readTextFile(path))
  } catch {
    throw new Error('rusty_v8 gitlink descriptor is not JSON')
  }
  return { descriptor: parseGitlinkDescriptor(raw, pins), sha256: digest }
}

function parseGitTreeRows(
  output: Uint8Array,
  label: string,
): Array<{ mode: string; type: string; object: string; path: string }> {
  const rows: Array<
    { mode: string; type: string; object: string; path: string }
  > = []
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(output)
  for (const record of decoded.split('\0')) {
    if (!record) continue
    const divider = record.indexOf('\t')
    if (divider <= 0) throw new Error(`invalid ${label} tree row`)
    const fields = record.slice(0, divider).split(' ')
    if (fields.length !== 3) throw new Error(`invalid ${label} tree row`)
    rows.push({
      mode: fields[0],
      type: fields[1],
      object: gitSha(fields[2], label),
      path: gitPath(record.slice(divider + 1), label),
    })
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path))
}

async function gitOutput(
  repository: string,
  args: string[],
): Promise<Uint8Array> {
  return (await command('git', [
    '--no-replace-objects',
    '-C',
    repository,
    ...args,
  ])).stdout
}

async function gitTree(
  repository: string,
  commit: string,
): Promise<string> {
  return decode(await gitOutput(repository, ['rev-parse', `${commit}^{tree}`]))
    .trim()
}

async function gitModules(
  repository: string,
  commit: string,
): Promise<Map<string, string>> {
  const output = await gitOutput(repository, [
    'config',
    '--null',
    `--blob=${commit}:.gitmodules`,
    '--get-regexp',
    '^submodule\\..*\\.(path|url)$',
  ])
  const modules = new Map<string, { path?: string; url?: string }>()
  for (const record of decode(output).split('\0')) {
    if (!record) continue
    const divider = record.indexOf('\n')
    if (divider < 0) throw new Error('invalid rusty_v8 .gitmodules entry')
    const key = record.slice(0, divider)
    const value = record.slice(divider + 1)
    const match = /^submodule\.(.+)\.(path|url)$/.exec(key)
    if (!match) throw new Error('invalid rusty_v8 .gitmodules entry')
    const entry = modules.get(match[1]) ?? {}
    if (match[2] === 'path') entry.path = gitPath(value, 'rusty_v8 .gitmodules')
    else entry.url = publicGitRepository(value, 'rusty_v8 .gitmodules')
    modules.set(match[1], entry)
  }
  const paths = new Map<string, string>()
  for (const entry of modules.values()) {
    if (!entry.path || !entry.url || paths.has(entry.path)) {
      throw new Error('rusty_v8 .gitmodules has incomplete entries')
    }
    paths.set(entry.path, entry.url)
  }
  return paths
}

async function ensureGitObjectStore(
  cache: string,
  repository: string,
  commit: string,
  tree: string,
): Promise<GitObjectStore> {
  const directory = join(
    cache,
    'git-objects',
    sha256Bytes(new TextEncoder().encode(repository)),
  )
  const existing = await Deno.lstat(directory).catch(() => undefined)
  if (!existing) {
    await Deno.mkdir(directory.slice(0, directory.lastIndexOf('/')), {
      recursive: true,
    })
    await command('git', ['init', '--bare', directory])
  } else if (!existing.isDirectory || existing.isSymlink) {
    throw new Error('git object cache path is not a real directory')
  }
  let present = true
  try {
    await gitOutput(directory, ['cat-file', '-e', `${commit}^{commit}`])
  } catch {
    present = false
  }
  if (!present) {
    await command('git', [
      '--no-replace-objects',
      '-C',
      directory,
      'fetch',
      '--no-tags',
      '--depth=1',
      repository,
      commit,
    ])
  }
  const resolved = decode(
    await gitOutput(directory, ['rev-parse', `${commit}^{commit}`]),
  ).trim()
  if (resolved !== commit || await gitTree(directory, commit) !== tree) {
    throw new Error('pinned Git object differs from descriptor commit or tree')
  }
  return { repository, commit, tree, path: directory }
}

async function gitTreeInventory(
  store: GitObjectStore,
  expected: Pick<GitlinkDescriptorEntry, 'inventory_sha256'>,
  allowGitlinks: boolean,
): Promise<GitTreeInventory> {
  const rows = parseGitTreeRows(
    await gitOutput(store.path, ['ls-tree', '-r', '-z', store.commit]),
    'pinned Git',
  )
  const commits = rows.filter((row) => row.type === 'commit')
  if (
    (!allowGitlinks && commits.length) ||
    rows.some((row) => row.type !== 'blob' && row.type !== 'commit')
  ) {
    throw new Error(
      'pinned Git tree has unexpected nested gitlinks or object type',
    )
  }
  const files: GitTreeRecord[] = []
  for (const row of rows) {
    if (row.type === 'commit') continue
    if (!['100644', '100755', '120000'].includes(row.mode)) {
      throw new Error('pinned Git tree has unsupported mode')
    }
    const bytes = await gitOutput(store.path, ['cat-file', 'blob', row.object])
    files.push({
      path: row.path,
      mode: row.mode as GitTreeRecord['mode'],
      blob: row.object,
      sha256: sha256Bytes(bytes),
      size: bytes.length,
    })
  }
  const inventory: GitTreeInventory = {
    schema_version: 1,
    repository: store.repository,
    commit: store.commit,
    tree: store.tree,
    files,
  }
  const digest = sha256Bytes(
    new TextEncoder().encode(JSON.stringify(inventory, null, 2) + '\n'),
  )
  if (digest !== expected.inventory_sha256) {
    throw new Error('pinned Git tree inventory differs from descriptor')
  }
  return inventory
}

async function writeGitTree(
  store: GitObjectStore,
  inventory: GitTreeInventory,
  destination: string,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true })
  for (const file of inventory.files) {
    const path = join(destination, file.path)
    const parent = path.slice(0, path.lastIndexOf('/'))
    if (parent) await Deno.mkdir(parent, { recursive: true })
    if (await Deno.lstat(path).catch(() => undefined)) {
      throw new Error(
        'pinned Git export would overwrite an existing source path',
      )
    }
    const bytes = await gitOutput(store.path, ['cat-file', 'blob', file.blob])
    if (bytes.length !== file.size || sha256Bytes(bytes) !== file.sha256) {
      throw new Error('pinned Git blob differs from inventory')
    }
    if (file.mode === '120000') {
      let target: string
      try {
        target = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('pinned Git symlink target is not UTF-8')
      }
      if (
        target.startsWith('/') || target.includes('\\') || target.includes('\0')
      ) {
        throw new Error('pinned Git symlink target is unsafe')
      }
      await Deno.symlink(target, path)
    } else {
      await Deno.writeFile(path, bytes, { createNew: true })
      await Deno.chmod(path, file.mode === '100755' ? 0o755 : 0o644)
    }
  }
  const observed = await walk(destination)
  if (observed.length !== inventory.files.length) {
    throw new Error('pinned Git export has unexpected tracked paths')
  }
  for (const file of inventory.files) {
    const path = join(destination, file.path)
    const stat = await Deno.lstat(path)
    if (file.mode === '120000') {
      if (
        !stat.isSymlink || sha256Bytes(new TextEncoder().encode(
            await Deno.readLink(path),
          )) !== file.sha256
      ) throw new Error('pinned Git symlink differs from inventory')
    } else if (
      !stat.isFile || stat.isSymlink || stat.size !== file.size ||
      await sha256(path) !== file.sha256 ||
      (stat.mode! & 0o777) !== (file.mode === '100755' ? 0o755 : 0o644)
    ) throw new Error('pinned Git file differs from inventory')
  }
}

async function verifyDirectGitlinks(
  root: GitObjectStore,
  descriptor: GitlinkClosureDescriptor,
): Promise<void> {
  const [rows, modules] = await Promise.all([
    parseGitTreeRows(
      await gitOutput(root.path, ['ls-tree', '-r', '-z', root.commit]),
      'rusty_v8 pinned Git',
    ),
    gitModules(root.path, root.commit),
  ])
  const actual = rows.filter((row) => row.type === 'commit').map((row) => ({
    path: row.path,
    repository: modules.get(row.path),
    commit: row.object,
  }))
  if (
    actual.length !== modules.size ||
    actual.length !== descriptor.gitlinks.length
  ) {
    throw new Error('rusty_v8 gitlink set differs from descriptor')
  }
  for (let index = 0; index < actual.length; index++) {
    const observed = actual[index]
    const expected = descriptor.gitlinks[index]
    if (
      !observed.repository || observed.path !== expected.path ||
      observed.repository !== expected.repository ||
      observed.commit !== expected.commit
    ) {
      throw new Error(
        'rusty_v8 gitlink descriptor differs from pinned Git tree',
      )
    }
  }
}

async function writeGitInventory(
  inventory: GitTreeInventory,
  path: string,
): Promise<void> {
  await ensureAbsentFile(path, 'pinned Git inventory')
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  await Deno.writeTextFile(path, JSON.stringify(inventory, null, 2) + '\n')
  // Generated closure metadata must not inherit the caller's umask.
  await Deno.chmod(path, 0o644)
}

export async function materializeRustyV8GitlinkClosure(
  sourceRoot: string,
  pins: Pins,
  cache: string,
  rustyV8Destination: string,
  metadataDestination: string,
  temporaryReceipt: string,
): Promise<{
  descriptorSha256: string
  rootTree: string
  gitlinkCount: number
  descriptor: GitlinkClosureDescriptor
}> {
  const { descriptor, sha256: descriptorSha256 } = await readGitlinkDescriptor(
    sourceRoot,
    pins,
  )
  const root = await ensureGitObjectStore(
    cache,
    descriptor.root.repository,
    descriptor.root.commit,
    descriptor.root.tree,
  )
  await verifyDirectGitlinks(root, descriptor)
  const stores: GitObjectStore[] = [root]
  const rootInventory = await gitTreeInventory(root, descriptor.root, true)
  await writeGitTree(root, rootInventory, rustyV8Destination)
  await writeGitInventory(
    rootInventory,
    join(metadataDestination, descriptor.root.inventory_path),
  )
  for (const entry of descriptor.gitlinks) {
    const store = await ensureGitObjectStore(
      cache,
      entry.repository,
      entry.commit,
      entry.tree,
    )
    const inventory = await gitTreeInventory(store, entry, false)
    await writeGitTree(store, inventory, join(rustyV8Destination, entry.path))
    await writeGitInventory(
      inventory,
      join(metadataDestination, entry.inventory_path),
    )
    stores.push(store)
  }
  await Deno.copyFile(
    join(sourceRoot, pins.gitlink_closure.path),
    join(metadataDestination, pins.gitlink_closure.path),
  )
  // The descriptor is generated archive metadata, not upstream RustyV8 source.
  await Deno.chmod(join(metadataDestination, pins.gitlink_closure.path), 0o644)
  await Deno.writeTextFile(
    temporaryReceipt,
    JSON.stringify(
      {
        schema_version: 1,
        kind: 'rusty-v8-git-object-stores',
        descriptor: {
          path: pins.gitlink_closure.path,
          sha256: descriptorSha256,
        },
        stores: stores.map((store) => ({
          repository: store.repository,
          commit: store.commit,
          tree: store.tree,
          path: store.path,
        })),
      },
      null,
      2,
    ) + '\n',
  )
  return {
    descriptorSha256,
    rootTree: descriptor.root.tree,
    gitlinkCount: descriptor.gitlinks.length,
    descriptor,
  }
}

type SourceLegalEvidence = SourceMaterialsReceipt['source_legal_evidence']

/**
 * Keep source-distributed attribution distinct from the runtime notice aggregate.
 * Every original legal file remains in its pinned Git tree; these small,
 * separately labeled texts resolve only the two split-tree references found
 * during the source distribution audit.
 */
async function materializeSourceLegalEvidence(
  sourceRoot: string,
  destination: string,
  descriptor: GitlinkClosureDescriptor,
): Promise<SourceLegalEvidence> {
  const indexSource = join(sourceRoot, SOURCE_LICENSE_INDEX_PATH)
  await requireRegularFile(
    indexSource,
    'source-distributed extra-tree legal evidence index',
  )
  const digest = await sha256(indexSource)
  let value: Record<string, unknown>
  try {
    value = requiredObject(
      JSON.parse(await Deno.readTextFile(indexSource)),
      'source-distributed extra-tree legal evidence index',
    )
  } catch {
    throw new Error(
      'source-distributed extra-tree legal evidence index is not JSON',
    )
  }
  exactKeys(
    value,
    [
      'schema_version',
      'kind',
      'scope',
      'source_distributed_extra_trees',
      'supplements',
    ],
    'source-distributed extra-tree legal evidence index',
  )
  if (
    value.schema_version !== 1 ||
    value.kind !== 'rusty-v8-source-license-index' ||
    value.scope !== 'source-distributed-extra-trees' ||
    !Array.isArray(value.source_distributed_extra_trees) ||
    !Array.isArray(value.supplements)
  ) {
    throw new Error(
      'invalid source-distributed extra-tree legal evidence index',
    )
  }
  const byPath = new Map(
    descriptor.gitlinks.map((entry) => [entry.path, entry]),
  )
  const expectedFamilies = [
    'build',
    'buildtools',
    'third_party/jinja2',
    'third_party/markupsafe',
    'third_party/rust',
    'tools/clang',
    'tools/win',
  ]
  if (value.source_distributed_extra_trees.length !== expectedFamilies.length) {
    throw new Error(
      'source-distributed extra-tree legal evidence has an incomplete family set',
    )
  }
  const familyPaths = new Set<string>()
  for (const raw of value.source_distributed_extra_trees) {
    const family = requiredObject(raw, 'source-distributed extra-tree family')
    exactKeys(
      family,
      [
        'path',
        'commit',
        'inventory_path',
        'legal_file_count',
        'runtime_linkage',
      ],
      'source-distributed extra-tree family',
    )
    const path = gitPath(family.path, 'source-distributed extra-tree family')
    const expected = byPath.get(path)
    if (
      !expected || family.commit !== expected.commit ||
      family.inventory_path !== expected.inventory_path ||
      !Number.isSafeInteger(family.legal_file_count) ||
      (family.legal_file_count as number) < 0 ||
      family.runtime_linkage !== 'not-determined' || familyPaths.has(path)
    ) {
      throw new Error(
        'source-distributed extra-tree family differs from pinned closure',
      )
    }
    familyPaths.add(path)
  }
  if (expectedFamilies.some((path) => !familyPaths.has(path))) {
    throw new Error(
      'source-distributed extra-tree legal evidence omits an audited family',
    )
  }

  const copied = new Set<string>()
  for (const raw of value.supplements) {
    const supplement = requiredObject(
      raw,
      'source-distributed extra-tree supplement',
    )
    const path = gitPath(
      supplement.path,
      'source-distributed extra-tree supplement',
    )
    if (
      !path.startsWith(SOURCE_LICENSE_SUPPLEMENT_PREFIX) ||
      copied.has(path) || typeof supplement.sha256 !== 'string' ||
      !SHA256.test(supplement.sha256) ||
      !Number.isSafeInteger(supplement.size) ||
      (supplement.size as number) <= 0 ||
      typeof supplement.purpose !== 'string' || !supplement.purpose ||
      !Array.isArray(supplement.provenance) || !supplement.provenance.length
    ) throw new Error('invalid source-distributed extra-tree supplement')
    const source = join(sourceRoot, path)
    const info = await requireRegularFile(
      source,
      'source-distributed extra-tree supplement',
    )
    if (
      info.size !== supplement.size ||
      await sha256(source) !== supplement.sha256
    ) {
      throw new Error(
        'source-distributed extra-tree supplement differs from its index',
      )
    }
    const output = join(destination, path)
    await ensureAbsentFile(
      output,
      'source-distributed extra-tree supplement output',
    )
    await Deno.copyFile(source, output)
    // Archive metadata has a deterministic mode independent of the caller's umask.
    await Deno.chmod(output, 0o644)
    copied.add(path)
  }
  if (copied.size < 3) {
    throw new Error(
      'source-distributed extra-tree legal evidence omits required supplements',
    )
  }
  const indexOutput = join(destination, SOURCE_LICENSE_INDEX_PATH)
  await ensureAbsentFile(
    indexOutput,
    'source-distributed extra-tree legal evidence output',
  )
  await Deno.copyFile(indexSource, indexOutput)
  // Archive metadata has a deterministic mode independent of the caller's umask.
  await Deno.chmod(indexOutput, 0o644)
  return {
    index_path: SOURCE_LICENSE_INDEX_PATH,
    sha256: digest,
    source_distributed_extra_tree_count: familyPaths.size,
    supplement_count: copied.size,
  }
}

export async function materializeRustyV8Source(
  sourceRoot: string,
  pinsPath: string,
  cache: string,
  sourceDestination: string,
  temporaryReceipt: string,
): Promise<{
  gitlinkClosure: {
    descriptorSha256: string
    rootTree: string
    gitlinkCount: number
  }
  sourceLegalEvidence: SourceLegalEvidence
}> {
  await ensureEmptyDirectory(sourceDestination, 'rusty_v8 source destination')
  await ensureAbsentFile(temporaryReceipt, 'rusty_v8 Git object store receipt')
  const pins = await readPins(pinsPath)
  const gitlinkClosure = await materializeRustyV8GitlinkClosure(
    sourceRoot,
    pins,
    cache,
    join(sourceDestination, 'rusty_v8'),
    sourceDestination,
    temporaryReceipt,
  )
  const sourceLegalEvidence = await materializeSourceLegalEvidence(
    sourceRoot,
    sourceDestination,
    gitlinkClosure.descriptor,
  )
  return {
    gitlinkClosure: {
      descriptorSha256: gitlinkClosure.descriptorSha256,
      rootTree: gitlinkClosure.rootTree,
      gitlinkCount: gitlinkClosure.gitlinkCount,
    },
    sourceLegalEvidence,
  }
}

async function assertDenoVersion(): Promise<void> {
  const version = decode((await command('deno', ['--version'])).stdout)
  if (!version.startsWith('deno 2.9.3 ')) {
    throw new Error(
      'source package requires Deno 2.9.3 to materialize offline application dependencies',
    )
  }
}

const DENO_EPHEMERAL_CACHE_ENTRIES = [
  ['gen', 'directory'],
  ['dep_analysis_cache_v2', 'file'],
  ['dep_analysis_cache_v2-shm', 'file'],
  ['dep_analysis_cache_v2-wal', 'file'],
  ['node_analysis_cache_v2', 'file'],
  ['node_analysis_cache_v2-shm', 'file'],
  ['node_analysis_cache_v2-wal', 'file'],
  ['v8_code_cache_v2', 'file'],
  ['v8_code_cache_v2-shm', 'file'],
  ['v8_code_cache_v2-wal', 'file'],
] as const

/**
 * Deno's resolved dependency material is portable, but its generated JS and
 * SQLite analysis/code caches embed the absolute assembly directory and can
 * differ run to run. Keep the former for offline reconstruction and remove
 * only the known Deno 2.9.3 ephemeral entries before source inventorying.
 */
export async function pruneDenoEphemeralCache(
  cacheDirectory: string,
): Promise<void> {
  for (const [name, kind] of DENO_EPHEMERAL_CACHE_ENTRIES) {
    const path = join(cacheDirectory, name)
    const info = await Deno.lstat(path).catch(() => undefined)
    if (!info) continue
    if (
      info.isSymlink ||
      (kind === 'directory' ? !info.isDirectory : !info.isFile)
    ) {
      throw new Error(`unexpected Deno ephemeral cache entry: ${name}`)
    }
    await Deno.remove(path, { recursive: kind === 'directory' })
  }
}

const DENO_CACHE_METADATA = '\n// denoCacheMetadata='
const DENO_CACHE_HEADERS = new Set([
  'content-type',
  'location',
  'x-deno-types',
  'x-typescript-types',
])

/**
 * Deno appends HTTP response metadata to cached remote modules. Dates, CDN
 * trace IDs, and response-header ordering vary for the same locked fetch, so
 * they must not enter a reproducible source archive. Preserve the cache URL
 * and only headers Deno uses to identify a module or its types; the following
 * cached-only CLI invocation validates the normalized cache before archiving.
 */
export async function normalizeDenoRemoteMetadata(
  cacheDirectory: string,
): Promise<void> {
  const remote = join(cacheDirectory, 'remote')
  const remoteInfo = await Deno.lstat(remote).catch(() => undefined)
  if (!remoteInfo) return
  if (!remoteInfo.isDirectory || remoteInfo.isSymlink) {
    throw new Error('Deno remote cache must be a real directory')
  }
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name)
      if (entry.isDirectory) {
        if (entry.isSymlink) throw new Error('Deno remote cache has a symlink')
        await visit(path)
        continue
      }
      if (!entry.isFile || entry.isSymlink) {
        throw new Error('Deno remote cache has a non-regular module entry')
      }
      const bytes = await Deno.readFile(path)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        continue
      }
      const marker = text.lastIndexOf(DENO_CACHE_METADATA)
      if (marker < 0) continue
      let metadata: Record<string, unknown>
      try {
        metadata = requiredObject(
          JSON.parse(text.slice(marker + DENO_CACHE_METADATA.length)),
          'Deno cache metadata',
        )
      } catch {
        throw new Error(`Deno remote cache has invalid metadata: ${path}`)
      }
      const url = requiredString(metadata.url, 'Deno cache metadata URL')
      const rawHeaders = requiredObject(
        metadata.headers,
        'Deno cache metadata headers',
      )
      const headers: Record<string, string> = {}
      for (const name of Object.keys(rawHeaders).sort()) {
        const value = rawHeaders[name]
        if (!DENO_CACHE_HEADERS.has(name.toLowerCase())) continue
        if (typeof value !== 'string') {
          throw new Error(`Deno cache metadata header is not text: ${name}`)
        }
        headers[name.toLowerCase()] = value
      }
      const normalized = text.slice(0, marker) + DENO_CACHE_METADATA +
        JSON.stringify({ headers, url, time: 0 })
      if (normalized !== text) await Deno.writeTextFile(path, normalized)
    }
  }
  await visit(remote)
}

async function materializeApplicationDependencies(
  slvRoot: string,
  cacheDirectory: string,
): Promise<void> {
  const lock = join(slvRoot, 'deno.lock')
  const entrypoint = join(slvRoot, 'cli/src/index.ts')
  for (const path of [lock, entrypoint]) {
    const info = await Deno.stat(path).catch(() => undefined)
    if (!info?.isFile) {
      throw new Error(`source application dependency input is missing: ${path}`)
    }
  }
  await assertDenoVersion()
  const env = { DENO_DIR: cacheDirectory, DENO_AUTH_TOKENS: '', NO_COLOR: '1' }
  await command('deno', [
    'cache',
    '--frozen',
    '--lock=deno.lock',
    'cli/src/index.ts',
  ], { cwd: slvRoot, env })
  await normalizeDenoRemoteMetadata(cacheDirectory)
  await pruneDenoEphemeralCache(cacheDirectory)
  await command('deno', [
    'run',
    '--cached-only',
    '--frozen',
    '--lock=deno.lock',
    '--allow-read',
    '--allow-env',
    'cli/src/index.ts',
    '--help',
  ], { cwd: slvRoot, env })
  await pruneDenoEphemeralCache(cacheDirectory)
}

async function materializeCargoVendor(
  denoRoot: string,
  cache: string,
  destination: string,
): Promise<void> {
  const manifest = join(denoRoot, 'Cargo.toml')
  const lock = join(denoRoot, 'Cargo.lock')
  for (const path of [manifest, lock]) {
    const info = await Deno.stat(path).catch(() => undefined)
    if (!info?.isFile) throw new Error(`Deno source input is missing: ${path}`)
  }
  const env = {
    CARGO_HOME: join(cache, 'cargo-home'),
    CARGO_NET_OFFLINE: 'true',
  }
  const vendorArgs = [
    'vendor',
    '--locked',
    '--offline',
    '--versioned-dirs',
    '--manifest-path',
    manifest,
    destination,
  ]
  try {
    await command('cargo', vendorArgs, { cwd: denoRoot, env })
  } catch {
    // A failed offline vendor invocation can leave a partial destination.
    // Never let a subsequent online, checksum-locked acquisition merge into
    // those bytes.
    await Deno.remove(destination, { recursive: true }).catch(() => undefined)
    await command('cargo', [
      'fetch',
      '--locked',
      '--manifest-path',
      manifest,
    ], { cwd: denoRoot, env: { CARGO_HOME: join(cache, 'cargo-home') } })
    await command('cargo', vendorArgs, { cwd: denoRoot, env })
  }
  await assertSourceClosure(destination, [])
}

function tomlString(body: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm').exec(body)
  return match?.[1]
}

async function cargoLockPackageCount(path: string): Promise<number> {
  const body = await Deno.readTextFile(path)
  const count = (body.match(/^\[\[package\]\]$/gm) ?? []).length
  if (!count) throw new Error('Cargo.lock has no package records')
  return count
}

function registryPackages(lock: string): CargoPackage[] {
  const packages: CargoPackage[] = []
  for (const block of lock.split(/\n\[\[package\]\]\n/).slice(1)) {
    const source = tomlString(block, 'source')
    if (!source?.startsWith('registry+')) continue
    const name = tomlString(block, 'name')
    const version = tomlString(block, 'version')
    const checksum = tomlString(block, 'checksum')
    if (!name || !version || !checksum || !SHA256.test(checksum)) {
      throw new Error('Cargo.lock has an invalid registry package identity')
    }
    packages.push({ name, version, checksum })
  }
  if (!packages.length) throw new Error('Cargo.lock has no registry packages')
  const names = new Set(
    packages.map((entry) => `${entry.name}@${entry.version}`),
  )
  if (names.size !== packages.length) {
    throw new Error('Cargo.lock has duplicate registry package identities')
  }
  return packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    )
  )
}

async function vendorPackages(root: string): Promise<Set<string>> {
  const packages = new Set<string>()
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || entry.isSymlink) continue
    const manifest = join(root, entry.name, 'Cargo.toml')
    const source = await Deno.readTextFile(manifest).catch(() => undefined)
    if (!source) {
      throw new Error(`vendored crate is missing Cargo.toml: ${entry.name}`)
    }
    const name = tomlString(source, 'name')
    const version = tomlString(source, 'version')
    if (!name || !version) {
      throw new Error(`vendored crate has an invalid Cargo.toml: ${entry.name}`)
    }
    const key = `${name}@${version}`
    if (packages.has(key)) {
      throw new Error(`duplicate vendored crate identity: ${key}`)
    }
    packages.add(key)
  }
  if (!packages.size) throw new Error('Cargo vendor output is empty')
  return packages
}

type SelectedVendorCoverage = {
  v8: { component: 'rusty_v8@149.4.0'; sourcePin: string }
  identities: Map<string, { component: string; archiveSha256: string }>
}

/**
 * The runtime index deliberately renders only the binary closure as
 * `actual-shipped`. The separately hash-bound selected-lock receipt is the
 * authority for every crate redistributed in the source-vendor archive.
 */
export function parseSelectedVendorCoverage(
  value: unknown,
  expectedCargoLockSha256: string,
): SelectedVendorCoverage {
  const coverage = requiredObject(value, 'selected source-vendor coverage')
  if (
    coverage.schema_version !== 1 ||
    requiredSha256(
        coverage.cargo_lock_sha256,
        'selected source-vendor Cargo.lock',
      ) !==
      expectedCargoLockSha256 ||
    (coverage.disposition !== 'complete' &&
      coverage.disposition !== 'complete-with-qualification')
  ) {
    throw new Error('selected source-vendor coverage has an invalid identity')
  }
  const rawV8 = requiredObject(
    coverage.v8_native_mapping,
    'selected source-vendor v8 mapping',
  )
  if (
    rawV8.cargo_package !== 'v8@149.4.0' ||
    rawV8.component !== 'rusty_v8@149.4.0'
  ) throw new Error('selected source-vendor v8 mapping is invalid')
  const v8 = {
    component: 'rusty_v8@149.4.0' as const,
    sourcePin: requiredString(
      rawV8.source_pin,
      'selected source-vendor v8 pin',
    ),
  }
  const rawIdentities = coverage.resolved_identities
  if (!Array.isArray(rawIdentities) || !rawIdentities.length) {
    throw new Error(
      'selected source-vendor coverage has no resolved identities',
    )
  }
  const identities = new Map<
    string,
    { component: string; archiveSha256: string }
  >()
  for (const rawIdentity of rawIdentities) {
    const identity = requiredObject(
      rawIdentity,
      'selected source-vendor identity',
    )
    const pkg = requiredString(
      identity.package,
      'selected source-vendor package',
    )
    const component = requiredString(
      identity.component,
      'selected source-vendor component',
    )
    const archive = requiredObject(
      identity.archive,
      'selected source-vendor archive',
    )
    if (
      !pkg.includes('@') || component !== `cargo:${pkg}` || identities.has(pkg)
    ) {
      throw new Error('selected source-vendor identity is invalid or duplicate')
    }
    identities.set(pkg, {
      component,
      archiveSha256: requiredSha256(
        archive.sha256,
        'selected source-vendor archive SHA-256',
      ),
    })
  }
  return { v8, identities }
}

async function selectedVendorCoverage(
  runtimeRoot: string,
  receipt: { path: string; sha256: string },
  expectedCargoLockSha256: string,
): Promise<SelectedVendorCoverage> {
  const path = join(runtimeRoot, receipt.path)
  if (await sha256(path) !== receipt.sha256) {
    throw new Error('selected source-vendor coverage receipt digest differs')
  }
  return parseSelectedVendorCoverage(
    JSON.parse(await Deno.readTextFile(path)),
    expectedCargoLockSha256,
  )
}

async function validateSourceVendorCoverage(
  sourceRoot: string,
  cargoLockPath: string,
  pins: Pins,
  vendored: Set<string>,
): Promise<SourceVendorCoverage> {
  const runtimeRoot = join(sourceRoot, 'scripts/release/runtime-notices')
  const runtime = await buildRuntimeNotices(runtimeRoot)
  const lockSha256 = await sha256(cargoLockPath)
  if (
    runtime.unresolvedRequired.length ||
    runtime.unresolvedConservative.length ||
    !runtime.sourceVendorCoverage.complete ||
    !runtime.selectedLockCoverage.complete ||
    (runtime.sourceVendorCoverage.disposition !== 'complete' &&
      runtime.sourceVendorCoverage.disposition !==
        'complete-with-qualification') ||
    !runtime.sourceVendorCoverage.receipt ||
    runtime.index.runtime.cargo_lock.sha256 !== lockSha256
  ) throw new Error('runtime source-vendor notice coverage is incomplete')
  const packages = registryPackages(await Deno.readTextFile(cargoLockPath))
  if (
    runtime.selectedLockCoverage.registryPackageCount !== packages.length ||
    runtime.selectedLockCoverage.resolvedRegistryPackages.length + 1 !==
      packages.length ||
    !runtime.selectedLockCoverage.receipt
  ) {
    throw new Error('selected-lock source-vendor coverage population differs')
  }
  const selectedCoverage = await selectedVendorCoverage(
    runtimeRoot,
    runtime.selectedLockCoverage.receipt,
    lockSha256,
  )
  for (const item of packages) {
    if (item.name === 'v8' && item.version === '149.4.0') {
      if (
        selectedCoverage.v8.component !== 'rusty_v8@149.4.0' ||
        selectedCoverage.v8.sourcePin !== pins.rusty_v8.commit
      ) {
        throw new Error(
          'Cargo v8 package is not mapped to the pinned rusty_v8 source component',
        )
      }
    } else {
      const component = selectedCoverage.identities.get(
        `${item.name}@${item.version}`,
      )
      if (
        !component ||
        component.component !== `cargo:${item.name}@${item.version}` ||
        component.archiveSha256 !== item.checksum
      ) {
        throw new Error(
          `Cargo package lacks matching runtime notice evidence: ${item.name}@${item.version}`,
        )
      }
    }
    if (!vendored.has(`${item.name}@${item.version}`)) {
      throw new Error(
        `Cargo package is absent from the source vendor archive: ${item.name}@${item.version}`,
      )
    }
  }
  if (vendored.size !== packages.length) {
    throw new Error(
      'source vendor archive differs from the locked registry package population',
    )
  }
  const receipt = runtime.sourceVendorCoverage.receipt
  return {
    indexSha256: await sha256(join(runtimeRoot, 'evidence-index.json')),
    receiptPath: receipt.path,
    receiptSha256: receipt.sha256,
    disposition: runtime.sourceVendorCoverage.disposition,
    registryPackageCount: packages.length,
    qualifiedComponents: runtime.sourceVendorCoverage.qualifications.map((
      item,
    ) => ({
      component: item.component,
      classification: item.classification,
      directLaterLicenseLinked: item.directLaterLicenseLinked,
      historicalScopeInferencePaths: item.historicalScopeInferencePaths,
    })),
  }
}

function archiveRootFor(pin: Pin): string {
  const url = new URL(pin.archive)
  const parts = url.pathname.split('/').filter(Boolean)
  const archive = parts.indexOf('archive')
  const tarball = parts.indexOf('tar.gz')
  const repository = archive > 0
    ? parts[archive - 1]
    : tarball > 0
    ? parts[tarball - 1]
    : undefined
  if (!repository) {
    throw new Error(`cannot derive archive root from pin: ${pin.archive}`)
  }
  return `${repository}-${pin.commit}`
}

async function requireRegularFile(
  path: string,
  label: string,
): Promise<Deno.FileInfo> {
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink || info.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`)
  }
  return info
}

async function copyCanonicalNotice(
  source: string,
  destinationRoot: string,
): Promise<void> {
  const destination = join(destinationRoot, CANONICAL_NOTICE_NAME)
  if (await Deno.lstat(destination).catch(() => undefined)) {
    throw new Error(
      `source material already has a canonical notice path: ${destination}`,
    )
  }
  await Deno.copyFile(source, destination)
}

type SecuritySelection = {
  upstreamLockSha256: string
  upstreamLockPackageCount: number
  upstreamManifestSha256: string
  selectedLockSha256: string
  selectedLockPackageCount: number
  selectedManifestSha256: string
  selectionSha256: string
  manifestPatchSha256: string
  resolutionReceiptSha256: string
  addedIdentitiesOsvSha256: string
  replacement: { from: string; to: string }
  allowedDelta: RuntimeSecurityReceipt['allowed_delta']
}

const SECURITY_INPUTS = {
  selection: 'selection.json',
  selectedLock: 'selected-Cargo.lock',
  manifestPatch: 'manifest-patch.json',
  resolutionReceipt: 'resolution-receipt.json',
  addedIdentitiesOsv: 'added-identities-osv.json',
} as const

function requiredObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(label + ' must be an object')
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(label + ' is missing')
  }
  return value
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label)
  if (!SHA256.test(digest)) throw new Error(label + ' must be a SHA-256 digest')
  return digest
}

function requiredPackageCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(label + ' must be a positive package count')
  }
  return value as number
}

function requiredExactStringList(
  value: unknown,
  label: string,
  expected: readonly string[],
): string[] {
  if (
    !Array.isArray(value) || !value.every((item) => typeof item === 'string') ||
    !sameStrings(value as string[], expected)
  ) {
    throw new Error(label + ' differs from the approved security delta')
  }
  return [...value] as string[]
}

function readSelectionIdentity(
  value: unknown,
  label: string,
  expectedPath: string,
  packageCount = false,
): { sha256: string; package_count?: number } {
  const identity = requiredObject(value, label)
  if (identity.archive_path !== expectedPath) {
    throw new Error(label + ' has an unexpected archive path')
  }
  const expectedKeys = packageCount
    ? ['archive_path', 'sha256', 'package_count']
    : ['archive_path', 'sha256']
  if (
    Object.keys(identity).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in identity))
  ) throw new Error(label + ' has an invalid shape')
  const parsed: { sha256: string; package_count?: number } = {
    sha256: requiredSha256(identity.sha256, label + ' SHA-256'),
  }
  if (packageCount) {
    parsed.package_count = requiredPackageCount(
      identity.package_count,
      label + ' package count',
    )
  }
  return parsed
}

async function securityInput(
  directory: string,
  name: string,
  expectedSha256?: string,
): Promise<{ path: string; bytes: Uint8Array; sha256: string }> {
  const path = join(directory, name)
  await requireRegularFile(path, 'security transform input ' + name)
  const bytes = await Deno.readFile(path)
  const digest = sha256Bytes(bytes)
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error('security transform input checksum mismatch: ' + name)
  }
  return { path, bytes, sha256: digest }
}

function packagesFromResolution(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array')
  return value.map((item) => {
    const entry = requiredObject(item, label)
    return requiredString(entry.name, label + ' name') + '@' +
      requiredString(entry.version, label + ' version')
  })
}

function changedIdentitiesFromResolution(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('security resolution changed identities must be an array')
  }
  return value.map((item) => {
    const entry = requiredObject(item, 'security resolution changed identity')
    if (
      !Array.isArray(entry.identity) || entry.identity.length < 2 ||
      typeof entry.identity[0] !== 'string' ||
      typeof entry.identity[1] !== 'string'
    ) throw new Error('security resolution changed identity is invalid')
    return entry.identity[0] + '@' + entry.identity[1]
  })
}

function parseSecuritySelection(
  value: unknown,
  selectionSha256: string,
): SecuritySelection {
  const selection = requiredObject(value, 'security selection')
  if (
    selection.schema_version !== 1 ||
    selection.kind !== 'slv-deno-security-selection'
  ) throw new Error('unsupported security selection')
  const upstream = requiredObject(selection.upstream, 'security upstream')
  const selected = requiredObject(selection.selected, 'security selected')
  const transform = requiredObject(selection.transform, 'security transform')
  const allowed = requiredObject(
    selection.allowed_delta,
    'security allowed delta',
  )
  const upstreamLock = readSelectionIdentity(
    upstream.cargo_lock,
    'upstream Cargo.lock',
    'deno/Cargo.lock',
    true,
  )
  const upstreamManifest = readSelectionIdentity(
    upstream.cargo_manifest,
    'upstream Cargo.toml',
    'deno/Cargo.toml',
  )
  const selectedLock = requiredObject(
    selected.cargo_lock,
    'selected Cargo.lock',
  )
  if (
    selectedLock.input_path !== 'security/' + SECURITY_INPUTS.selectedLock ||
    selectedLock.archive_path !== 'deno/Cargo.lock' ||
    Object.keys(selectedLock).length !== 4
  ) throw new Error('selected Cargo.lock has an invalid shape')
  const selectedManifest = readSelectionIdentity(
    selected.cargo_manifest,
    'selected Cargo.toml',
    'deno/Cargo.toml',
  )
  const parsedTransform = (name: keyof typeof SECURITY_INPUTS) => {
    const jsonName = name.replace(
      /[A-Z]/g,
      (letter) => '_' + letter.toLowerCase(),
    )
    const record = requiredObject(transform[jsonName], 'security ' + name)
    const expectedInput = 'security/' + SECURITY_INPUTS[name]
    const expectedArchive = 'source-materials/security/' + SECURITY_INPUTS[name]
    if (
      record.input_path !== expectedInput ||
      record.archive_path !== expectedArchive ||
      Object.keys(record).length !== (name === 'manifestPatch' ? 4 : 3)
    ) throw new Error('security ' + name + ' has an invalid shape')
    return {
      sha256: requiredSha256(record.sha256, 'security ' + name + ' SHA-256'),
      record,
    }
  }
  const manifestPatch = parsedTransform('manifestPatch')
  const resolutionReceipt = parsedTransform('resolutionReceipt')
  const addedIdentitiesOsv = parsedTransform('addedIdentitiesOsv')
  const replacement = requiredObject(
    manifestPatch.record.replace,
    'security replacement',
  )
  if (
    Object.keys(replacement).length !== 2 ||
    typeof replacement.from !== 'string' || typeof replacement.to !== 'string'
  ) throw new Error('security replacement is invalid')
  const allowedDelta = {
    added: requiredExactStringList(
      allowed.added,
      'security added',
      SECURITY_DELTA.added,
    ),
    removed: requiredExactStringList(
      allowed.removed,
      'security removed',
      SECURITY_DELTA.removed,
    ),
    changed_same_identity: requiredExactStringList(
      allowed.changed_same_identity,
      'security changed identities',
      SECURITY_DELTA.changed_same_identity,
    ),
  }
  const selectedPackageCount = requiredPackageCount(
    selectedLock.package_count,
    'selected Cargo.lock package count',
  )
  const selectedLockSha256 = requiredSha256(
    selectedLock.sha256,
    'selected Cargo.lock SHA-256',
  )
  if (selectedPackageCount !== upstreamLock.package_count! + 1) {
    throw new Error(
      'selected Cargo.lock package count is not the approved delta',
    )
  }
  return {
    upstreamLockSha256: upstreamLock.sha256,
    upstreamLockPackageCount: upstreamLock.package_count!,
    upstreamManifestSha256: upstreamManifest.sha256,
    selectedLockSha256,
    selectedLockPackageCount: selectedPackageCount,
    selectedManifestSha256: selectedManifest.sha256,
    selectionSha256,
    manifestPatchSha256: manifestPatch.sha256,
    resolutionReceiptSha256: resolutionReceipt.sha256,
    addedIdentitiesOsvSha256: addedIdentitiesOsv.sha256,
    replacement: { from: replacement.from, to: replacement.to },
    allowedDelta,
  }
}

/**
 * Validate the checked-in, hash-bound runtime security selection before its
 * files are copied into a source archive. Kept separate for a focused
 * selection-shape regression test; package assembly still verifies every
 * referenced file and pinned upstream input.
 */
export function assertSecuritySelection(
  value: unknown,
  selectionSha256: string,
): void {
  parseSecuritySelection(value, selectionSha256)
}

async function applyRuntimeSecuritySelection(
  sourceRoot: string,
  denoSourceRoot: string,
): Promise<RuntimeSecurityReceipt> {
  const inputDirectory = join(sourceRoot, 'source-materials/security')
  const selectionInput = await securityInput(
    inputDirectory,
    SECURITY_INPUTS.selection,
  )
  const selection = parseSecuritySelection(
    JSON.parse(new TextDecoder().decode(selectionInput.bytes)),
    selectionInput.sha256,
  )
  const [selectedLock, manifestPatch, resolutionReceipt, osv] = await Promise
    .all([
      securityInput(
        inputDirectory,
        SECURITY_INPUTS.selectedLock,
        selection.selectedLockSha256,
      ),
      securityInput(
        inputDirectory,
        SECURITY_INPUTS.manifestPatch,
        selection.manifestPatchSha256,
      ),
      securityInput(
        inputDirectory,
        SECURITY_INPUTS.resolutionReceipt,
        selection.resolutionReceiptSha256,
      ),
      securityInput(
        inputDirectory,
        SECURITY_INPUTS.addedIdentitiesOsv,
        selection.addedIdentitiesOsvSha256,
      ),
    ])
  const patch = requiredObject(
    JSON.parse(new TextDecoder().decode(manifestPatch.bytes)),
    'security manifest patch',
  )
  if (
    patch.before_sha256 !== selection.upstreamManifestSha256 ||
    patch.after_sha256 !== selection.selectedManifestSha256 ||
    !isRecord(patch.replace) ||
    patch.replace.from !== selection.replacement.from ||
    patch.replace.to !== selection.replacement.to
  ) {
    throw new Error(
      'security manifest patch differs from the approved selection',
    )
  }
  const resolution = requiredObject(
    JSON.parse(new TextDecoder().decode(resolutionReceipt.bytes)),
    'security resolution receipt',
  )
  const originalLock = requiredObject(
    resolution.original_lock,
    'resolution original lock',
  )
  const securityLock = requiredObject(
    resolution.security_lock,
    'resolution security lock',
  )
  if (
    originalLock.sha256 !== selection.upstreamLockSha256 ||
    originalLock.packages !== selection.upstreamLockPackageCount ||
    securityLock.sha256 !== selection.selectedLockSha256 ||
    securityLock.packages !== selection.selectedLockPackageCount ||
    !sameStrings(
      packagesFromResolution(resolution.added, 'resolution added'),
      selection.allowedDelta.added,
    ) ||
    !sameStrings(
      packagesFromResolution(resolution.removed, 'resolution removed'),
      selection.allowedDelta.removed,
    ) ||
    !sameStrings(
      changedIdentitiesFromResolution(resolution.changed_same_identity),
      selection.allowedDelta.changed_same_identity,
    )
  ) {
    throw new Error(
      'security resolution receipt differs from the approved selection',
    )
  }
  const osvReceipt = requiredObject(
    JSON.parse(new TextDecoder().decode(osv.bytes)),
    'security OSV receipt',
  )
  if (osvReceipt.source_security_lock_sha256 !== selection.selectedLockSha256) {
    throw new Error(
      'security OSV receipt does not bind the selected Cargo.lock',
    )
  }
  const queries =
    requiredObject(osvReceipt.request, 'security OSV request').queries
  const results =
    requiredObject(osvReceipt.response, 'security OSV response').results
  if (
    !Array.isArray(queries) || !Array.isArray(results) ||
    queries.length !== SECURITY_DELTA.added.length ||
    results.length !== SECURITY_DELTA.added.length ||
    !results.every((result) =>
      isRecord(result) && Object.keys(result).length === 0
    )
  ) {
    throw new Error(
      'security OSV receipt is incomplete or has advisory results',
    )
  }
  const queried = queries.map((query) => {
    const record = requiredObject(query, 'security OSV query')
    const pkg = requiredObject(record.package, 'security OSV package')
    if (pkg.ecosystem !== 'crates.io') {
      throw new Error('security OSV ecosystem differs')
    }
    return requiredString(pkg.name, 'security OSV package name') + '@' +
      requiredString(record.version, 'security OSV package version')
  })
  if (!sameStrings(queried, SECURITY_DELTA.added)) {
    throw new Error(
      'security OSV receipt does not cover the approved additions',
    )
  }

  const cargoRoot = join(denoSourceRoot, 'deno')
  const upstreamLock = join(cargoRoot, 'Cargo.lock')
  const upstreamManifest = join(cargoRoot, 'Cargo.toml')
  if (
    await sha256(upstreamLock) !== selection.upstreamLockSha256 ||
    await sha256(upstreamManifest) !== selection.upstreamManifestSha256
  ) {
    throw new Error(
      'pinned Deno source differs from the approved upstream inputs',
    )
  }
  const archiveEvidence = join(denoSourceRoot, 'source-materials/security')
  await Deno.mkdir(archiveEvidence, { recursive: true })
  await Deno.copyFile(
    upstreamLock,
    join(archiveEvidence, 'upstream-Cargo.lock'),
  )
  await Deno.copyFile(
    upstreamManifest,
    join(archiveEvidence, 'upstream-Cargo.toml'),
  )
  for (
    const input of [
      selectionInput,
      manifestPatch,
      resolutionReceipt,
      osv,
    ]
  ) {
    await Deno.copyFile(
      input.path,
      join(archiveEvidence, input.path.split('/').at(-1)!),
    )
  }
  await Deno.copyFile(
    selectedLock.path,
    join(archiveEvidence, 'selected-Cargo.lock'),
  )
  const originalManifest = await Deno.readTextFile(upstreamManifest)
  if (
    originalManifest.split(selection.replacement.from).length !== 2 ||
    originalManifest.includes(selection.replacement.to)
  ) {
    throw new Error(
      'approved Cargo.toml replacement is not uniquely applicable',
    )
  }
  await Deno.writeTextFile(
    upstreamManifest,
    originalManifest.replace(
      selection.replacement.from,
      selection.replacement.to,
    ),
  )
  await Deno.copyFile(selectedLock.path, upstreamLock)
  if (
    await sha256(upstreamManifest) !== selection.selectedManifestSha256 ||
    await sha256(upstreamLock) !== selection.selectedLockSha256 ||
    (await cargoLockPackageCount(upstreamLock)) !==
      selection.selectedLockPackageCount
  ) throw new Error('security-selected Cargo build inputs differ from approval')
  const receipt: RuntimeSecurityReceipt = {
    upstream: {
      cargo_lock: {
        path: 'source-materials/security/upstream-Cargo.lock',
        sha256: selection.upstreamLockSha256,
        package_count: selection.upstreamLockPackageCount,
      },
      cargo_manifest: {
        path: 'source-materials/security/upstream-Cargo.toml',
        sha256: selection.upstreamManifestSha256,
      },
    },
    selected: {
      cargo_lock: {
        path: 'deno/Cargo.lock',
        sha256: selection.selectedLockSha256,
        package_count: selection.selectedLockPackageCount,
      },
      cargo_manifest: {
        path: 'deno/Cargo.toml',
        sha256: selection.selectedManifestSha256,
      },
    },
    transform: {
      selection: {
        path: 'source-materials/security/selection.json',
        sha256: selection.selectionSha256,
      },
      manifest_patch: {
        path: 'source-materials/security/manifest-patch.json',
        sha256: selection.manifestPatchSha256,
      },
      resolution_receipt: {
        path: 'source-materials/security/resolution-receipt.json',
        sha256: selection.resolutionReceiptSha256,
      },
      added_identities_osv: {
        path: 'source-materials/security/added-identities-osv.json',
        sha256: selection.addedIdentitiesOsvSha256,
      },
    },
    allowed_delta: selection.allowedDelta,
  }
  parseRuntimeSecurityReceipt(receipt)
  return receipt
}

type CompositeInventory = {
  schema_version: 1
  trees: Array<{ root: string; files: FileRecord[] }>
}

async function writeCompositeInventory(
  roots: Array<{ name: string; path: string }>,
  output: string,
): Promise<{ sha256: string; entryCount: number }> {
  const trees: CompositeInventory['trees'] = []
  for (
    const root of [...roots].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  ) {
    const files = await walk(root.path)
    if (!files.length) {
      throw new Error(`source package tree is empty: ${root.name}`)
    }
    trees.push({ root: root.name, files })
  }
  await Deno.writeTextFile(
    output,
    JSON.stringify({ schema_version: 1, trees }, null, 2) + '\n',
  )
  return {
    sha256: await sha256(output),
    entryCount: trees.reduce((count, tree) => count + tree.files.length, 0),
  }
}

async function writeEmbeddedManifests(
  roots: Array<{ name: string; path: string; archive: SourceAssetName }>,
  closurePath: string,
  inventoryPath: string,
  closureSha256: string,
  inventorySha256: string,
  gitlinkClosure: SourceMaterialsReceipt['gitlink_closure'],
  sourceLegalEvidence: SourceMaterialsReceipt['source_legal_evidence'],
): Promise<void> {
  for (const root of roots) {
    const metadata = join(root.path, METADATA_DIRECTORY)
    await Deno.mkdir(metadata, { recursive: true })
    await Deno.copyFile(closurePath, join(metadata, 'closure.json'))
    await Deno.copyFile(inventoryPath, join(metadata, 'inventory.json'))
    await Deno.writeTextFile(
      join(metadata, 'pack-manifest.json'),
      JSON.stringify(
        {
          schema_version: 1,
          root: root.name,
          archive: root.archive,
          canonical_notice: CANONICAL_NOTICE_NAME,
          closure: { path: 'closure.json', sha256: closureSha256 },
          inventory: { path: 'inventory.json', sha256: inventorySha256 },
          gitlink_closure: gitlinkClosure,
          source_legal_evidence: sourceLegalEvidence,
        },
        null,
        2,
      ) + '\n',
    )
  }
}

export async function deterministicArchive(
  parent: string,
  root: string,
  output: string,
  timestampEpoch: number,
): Promise<void> {
  await command('tar', [
    '--sort=name',
    `--mtime=@${timestampEpoch}`,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--format=posix',
    '--pax-option=delete=atime,delete=ctime',
    // Deno creates inode aliases between its npm cache and node_modules. A
    // hardlink record requires a consumer to preserve archive ordering and
    // link semantics, while the native source extractor deliberately rejects
    // links it cannot validate. Store each alias as ordinary file bytes; keep
    // symbolic links untouched because upstream sources contain real links.
    '--hard-dereference',
    '-C',
    parent,
    '-czf',
    output,
    root,
  ])
  const info = await requireRegularFile(output, `source archive ${root}`)
  if (info.size >= MAX_ARCHIVE_BYTES) {
    throw new Error(`source archive exceeds the strict 2 GiB limit: ${output}`)
  }
}

async function removeSourceOutputs(
  outputDirectory: string,
  receiptPath: string,
): Promise<void> {
  for (const name of SOURCE_ARCHIVES) {
    await Deno.remove(join(outputDirectory, name)).catch(() => undefined)
  }
  await Deno.remove(receiptPath).catch(() => undefined)
}

/**
 * Assemble three relinkable source archives. This is deliberately a separate,
 * explicit operation: normal notice preparation never fetches source or
 * silently turns a local worktree into a release input.
 */
export async function packageSourceMaterials(
  options: SourcePackageOptions,
): Promise<SourceMaterialsReceipt> {
  await ensureEmptyDirectory(options.workDir, 'source assembly work directory')
  await ensureEmptyDirectory(
    options.outputDirectory,
    'source archive output directory',
  )
  await ensureAbsentFile(options.receiptPath, 'source materials receipt')

  const source = await reviewedSource(options.sourceRoot, options.sourceCommit)
  const pins = await readPins(options.pinsPath)
  const pinsSha256 = await sha256(options.pinsPath)
  const noticeInfo = await requireRegularFile(
    options.noticeFile,
    'canonical notice',
  )
  const noticeSha256 = await sha256(options.noticeFile)
  const work = await Deno.realPath(options.workDir)
  const output = await Deno.realPath(options.outputDirectory)
  const slvRoot = join(work, 'slv-source')
  const denoSourceRoot = join(work, 'deno-source')
  const vendorRoot = join(work, 'deno-cargo-vendor')
  const metadata = join(work, 'metadata')

  try {
    const [denoArchive] = await Promise.all([
      acquirePinnedArchive(options.cache, pins.deno),
      acquirePinnedArchive(options.cache, pins.rusty_v8),
      acquirePinnedArchive(options.cache, pins.v8),
    ])
    await archiveGitTree(source, work)
    await materializeApplicationDependencies(
      slvRoot,
      join(slvRoot, 'deno-cache'),
    )

    await Deno.mkdir(denoSourceRoot, { recursive: true })
    await extractPinnedArchive(
      denoArchive,
      'deno',
      join(denoSourceRoot, 'deno'),
    )
    const gitlinkClosure = await materializeRustyV8GitlinkClosure(
      source.root,
      pins,
      options.cache,
      join(denoSourceRoot, 'rusty_v8'),
      denoSourceRoot,
      join(work, 'rusty-v8-git-object-stores.json'),
    )
    const sourceLegalEvidence = await materializeSourceLegalEvidence(
      source.root,
      denoSourceRoot,
      gitlinkClosure.descriptor,
    )
    await assertPureSourceTree(denoSourceRoot)
    await assertSourceClosure(denoSourceRoot, [
      'deno/Cargo.toml',
      'deno/Cargo.lock',
      'deno/rust-toolchain.toml',
      'rusty_v8/Cargo.toml',
      'rusty_v8/Cargo.lock',
      'rusty_v8/src/binding.hpp',
      'rusty_v8/v8/BUILD.gn',
      'rusty_v8/v8/third_party/glibc/src/sysdeps/ieee754/dbl-64/s_sin.c',
    ])
    // Keep the immutable upstream files in the source archive, then use only
    // the approved selected security inputs for vendor and native builds.
    const runtimeSecurity = await applyRuntimeSecuritySelection(
      source.root,
      denoSourceRoot,
    )

    await materializeCargoVendor(
      join(denoSourceRoot, 'deno'),
      options.cache,
      join(vendorRoot, 'vendor'),
    )
    const cargoLock = join(denoSourceRoot, 'deno', 'Cargo.lock')
    const vendored = await vendorPackages(join(vendorRoot, 'vendor'))
    const coverage = await validateSourceVendorCoverage(
      source.root,
      cargoLock,
      pins,
      vendored,
    )
    await Deno.copyFile(cargoLock, join(vendorRoot, 'Cargo.lock'))
    await Deno.mkdir(join(vendorRoot, '.cargo'), { recursive: true })
    await Deno.writeTextFile(
      join(vendorRoot, '.cargo', 'config.toml'),
      CARGO_CONFIG,
    )

    const roots: Array<
      { name: string; path: string; archive: SourceAssetName }
    > = [
      { name: 'slv-source', path: slvRoot, archive: 'slv-source.tar.gz' },
      {
        name: 'deno-source',
        path: denoSourceRoot,
        archive: 'deno-source.tar.gz',
      },
      {
        name: 'deno-cargo-vendor',
        path: vendorRoot,
        archive: 'deno-cargo-vendor.tar.gz',
      },
    ]
    for (const root of roots) {
      await copyCanonicalNotice(options.noticeFile, root.path)
    }

    await Deno.mkdir(metadata, { recursive: true })
    const inventoryPath = join(metadata, 'inventory.json')
    const inventory = await writeCompositeInventory(roots, inventoryPath)
    const closurePath = join(metadata, 'closure.json')
    const vendorLockSha256 = await sha256(cargoLock)
    await Deno.writeTextFile(
      closurePath,
      JSON.stringify(
        {
          schema_version: 1,
          source: {
            commit: source.commit,
            tree_sha256: source.treeSha256,
            timestamp: source.timestamp,
            timestamp_epoch: source.timestampEpoch,
          },
          pins: {
            sha256: pinsSha256,
            deno: pins.deno,
            rusty_v8: pins.rusty_v8,
            v8: pins.v8,
            gitlink_closure: pins.gitlink_closure,
          },
          rusty_v8_gitlink_closure: {
            path: pins.gitlink_closure.path,
            sha256: gitlinkClosure.descriptorSha256,
            root_tree: gitlinkClosure.rootTree,
            gitlink_count: gitlinkClosure.gitlinkCount,
          },
          source_legal_evidence: sourceLegalEvidence,
          canonical_notice: {
            path: CANONICAL_NOTICE_NAME,
            sha256: noticeSha256,
            size: noticeInfo.size,
          },
          application_dependencies: {
            path: 'deno-cache',
            lock_sha256: await sha256(join(slvRoot, 'deno.lock')),
            deno_version: '2.9.3',
            offline_verified: true,
          },
          vendor: {
            policy: 'full-locked-vendor',
            lock_path: 'Cargo.lock',
            lock_sha256: vendorLockSha256,
            crate_count: vendored.size,
            registry_package_count: coverage.registryPackageCount,
            source_vendor_coverage: coverage,
          },
          runtime_security: runtimeSecurity,
          inventory: {
            path: 'source-materials/inventory.json',
            sha256: inventory.sha256,
            entry_count: inventory.entryCount,
          },
        },
        null,
        2,
      ) + '\n',
    )
    const closureSha256 = await sha256(closurePath)
    await writeEmbeddedManifests(
      roots,
      closurePath,
      inventoryPath,
      closureSha256,
      inventory.sha256,
      {
        path: pins.gitlink_closure.path,
        sha256: gitlinkClosure.descriptorSha256,
        root_tree: gitlinkClosure.rootTree,
        gitlink_count: gitlinkClosure.gitlinkCount,
      },
      sourceLegalEvidence,
    )

    for (const root of roots) {
      await deterministicArchive(
        work,
        root.name,
        join(output, root.archive),
        source.timestampEpoch,
      )
    }
    const assets: SourceAsset[] = []
    for (const name of SOURCE_ARCHIVES) {
      const path = join(output, name)
      const info = await requireRegularFile(path, `source asset ${name}`)
      if (info.size >= MAX_ARCHIVE_BYTES) {
        throw new Error(`source asset reaches the 2 GiB limit: ${name}`)
      }
      assets.push({
        name,
        sha256: await sha256(path),
        size: info.size,
        embedded_manifest_path: 'source-materials/pack-manifest.json',
      })
    }
    const receipt: SourceMaterialsReceipt = {
      schema_version: 1,
      kind: 'slv-source-materials',
      mode: 'reviewed',
      source: {
        commit: source.commit,
        tree_sha256: source.treeSha256,
        timestamp: source.timestamp,
        timestamp_epoch: source.timestampEpoch,
      },
      canonical_notice: {
        path: CANONICAL_NOTICE_NAME,
        sha256: noticeSha256,
        size: noticeInfo.size,
      },
      pins: { ...pins, sha256: pinsSha256 },
      closure: {
        embedded_path: 'source-materials/closure.json',
        sha256: closureSha256,
        entry_count: inventory.entryCount,
      },
      inventory: {
        embedded_path: 'source-materials/inventory.json',
        sha256: inventory.sha256,
      },
      vendor: {
        policy: 'full-locked-vendor',
        lock_path: 'Cargo.lock',
        lock_sha256: vendorLockSha256,
        crate_count: vendored.size,
        omissions: [],
      },
      runtime_security: runtimeSecurity,
      gitlink_closure: {
        path: pins.gitlink_closure.path,
        sha256: gitlinkClosure.descriptorSha256,
        root_tree: gitlinkClosure.rootTree,
        gitlink_count: gitlinkClosure.gitlinkCount,
      },
      source_legal_evidence: sourceLegalEvidence,
      assets,
      // The assembly receipt is immutable. Target-specific native proofs are
      // separate records bound to these exact archive bytes.
      rebuild_proof: { required: true, status: 'separate' },
    }
    verifySourceMaterialsReceipt(receipt, {
      sourceCommit: source.commit,
      canonicalNoticeSha256: noticeSha256,
    })
    await Deno.writeTextFile(
      options.receiptPath,
      JSON.stringify(receipt, null, 2) + '\n',
    )
    await verifyReceiptFiles(receipt, output, {
      sourceCommit: source.commit,
      canonicalNoticeSha256: noticeSha256,
    })
    return receipt
  } catch (error) {
    await removeSourceOutputs(output, options.receiptPath)
    throw error
  }
}

export const SOURCE_PROOF_TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
] as const

type SourceProofTarget = typeof SOURCE_PROOF_TARGETS[number]
type ProofHost = { os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' }
type ProofArtifacts = {
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
export type SourceProofSetOptions = {
  sourceReceiptPath: string
  sourceDirectory: string
  proofDirectory: string
  sourceCommit: string
  sourcePinsPath: string
  toolPinsDirectory: string
  canonicalNoticePath: string
  /** Test-only override; production derives this from source-materials/pins. */
  reviewedToolPinsPath?: string
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function defaultReviewedToolPinsPath(sourcePinsPath: string): string {
  return join(
    parentDirectory(parentDirectory(sourcePinsPath)),
    'source-rebuild/tool-prereqs.json',
  )
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index])
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(value[key])}`
      ).join(',')
    }}`
  }
  return JSON.stringify(value)
}

function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function objectField(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function shaField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`)
  }
  return value
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function positiveSize(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) || (value as number) <= 0 ||
    (value as number) >= MAX_ARCHIVE_BYTES
  ) {
    throw new Error(`${label} must be a positive size below 2 GiB`)
  }
  return value as number
}

function expectedProofHost(target: SourceProofTarget): ProofHost {
  if (target === 'x86_64-unknown-linux-gnu') return { os: 'linux', arch: 'x64' }
  if (target === 'aarch64-unknown-linux-gnu') {
    return { os: 'linux', arch: 'arm64' }
  }
  if (target === 'x86_64-apple-darwin') return { os: 'darwin', arch: 'x64' }
  return { os: 'darwin', arch: 'arm64' }
}

function parseProofHost(value: unknown, label: string): ProofHost {
  const host = objectField(value, label)
  if (
    (host.os !== 'linux' && host.os !== 'darwin') ||
    (host.arch !== 'x64' && host.arch !== 'arm64')
  ) {
    throw new Error(`invalid ${label}`)
  }
  return { os: host.os, arch: host.arch }
}

function parseProofAssets(value: unknown, label: string): ProofArtifacts {
  const root = objectField(value, label)
  const parse = (part: 'baseline' | 'modified', fields: string[]) => {
    const record = objectField(root[part], `${label}.${part}`)
    if (
      Object.keys(record).length !== fields.length ||
      fields.some((field) => !(field in record))
    ) {
      throw new Error(`invalid ${label}.${part} artifact set`)
    }
    for (const field of fields) {
      shaField(record[field], `${label}.${part}.${field}`)
    }
    return record
  }
  const baseline = parse('baseline', [
    'denort_sha256',
    'v8_archive_sha256',
    'ninja_sha256',
    'probe_standalone_sha256',
    'derived_relink_cargo_lock_sha256',
    'slv_executable_sha256',
    'bridge_standalone_sha256',
  ])
  const modified = parse('modified', [
    'denort_sha256',
    'v8_archive_sha256',
    'ninja_sha256',
    'probe_standalone_sha256',
  ])
  return {
    baseline: baseline as ProofArtifacts['baseline'],
    modified: modified as ProofArtifacts['modified'],
  }
}

function parseProofSourceAssets(value: unknown): SourceAsset[] {
  if (!Array.isArray(value) || value.length !== SOURCE_ARCHIVES.length) {
    throw new Error('native proof must bind exactly three source archives')
  }
  const expected = new Set<string>(SOURCE_ARCHIVES)
  const assets: SourceAsset[] = []
  for (const entry of value) {
    const asset = objectField(entry, 'native proof source asset')
    const name = asset.name
    if (typeof name !== 'string' || !expected.has(name)) {
      throw new Error('native proof has an invalid source archive name')
    }
    assets.push({
      name: name as SourceAssetName,
      sha256: shaField(asset.sha256, `native proof ${name} SHA-256`),
      size: positiveSize(asset.size, `native proof ${name} size`),
      embedded_manifest_path: 'source-materials/pack-manifest.json',
    })
  }
  if (
    new Set(assets.map((asset) => asset.name)).size !== SOURCE_ARCHIVES.length
  ) {
    throw new Error('native proof duplicates a source archive')
  }
  return assets.sort((left, right) =>
    SOURCE_ARCHIVES.indexOf(left.name) - SOURCE_ARCHIVES.indexOf(right.name)
  )
}

function commandReceipt(value: unknown, label: string): void {
  const receipt = objectField(value, label)
  if (
    !Array.isArray(receipt.command) ||
    !receipt.command.every((part) => typeof part === 'string' && part) ||
    typeof receipt.cwd !== 'string' || !receipt.cwd ||
    Number.isNaN(Date.parse(String(receipt.started_at))) ||
    Number.isNaN(Date.parse(String(receipt.finished_at))) ||
    receipt.exit_code !== 0 || typeof receipt.log !== 'string' ||
    !receipt.log ||
    !SHA256.test(String(receipt.log_sha256))
  ) {
    throw new Error(`invalid successful ${label}`)
  }
}

function passedCheck(value: unknown, label: string): Record<string, unknown> {
  const check = objectField(value, label)
  if (check.passed !== true) throw new Error(`${label} did not pass`)
  return check
}

type ProbeResult = {
  sentinel: { input: number; output: number }
  control: { input: number; output: number }
}

function probeCheck(value: unknown, label: string): ProbeResult {
  const check = passedCheck(value, label)
  const result = {} as ProbeResult
  for (const kind of ['sentinel', 'control'] as const) {
    const probe = objectField(check[kind], `${label}.${kind}`)
    if (!Number.isFinite(probe.input) || !Number.isFinite(probe.output)) {
      throw new Error(`invalid ${label}.${kind} result`)
    }
    commandReceipt(probe.command, `${label}.${kind}.command`)
    result[kind] = {
      input: probe.input as number,
      output: probe.output as number,
    }
  }
  return result
}

function parseRuntimeAbi(
  value: unknown,
  receiptSha256: unknown,
  target: SourceProofTarget,
  denortSha256: string,
  label: string,
): void {
  shaField(receiptSha256, `${label} runtime ABI receipt SHA-256`)
  const abi = objectField(value, `${label} runtime ABI`)
  if (
    abi.schema_version !== 1 || abi.status !== 'passed' ||
    shaField(abi.denort_sha256, `${label} runtime ABI denort SHA-256`) !==
      denortSha256
  ) {
    throw new Error(`${label} runtime ABI does not bind its denort`)
  }
  if (target.endsWith('linux-gnu')) {
    const expected = [
      'schema_version',
      'kind',
      'denort_sha256',
      'glibc_versions',
      'glibc_private',
      'rpath_or_runpath',
      'needed',
      'logs',
      'status',
    ]
    if (
      Object.keys(abi).length !== expected.length ||
      expected.some((field) => !(field in abi)) ||
      abi.kind !== 'slv-linux-denort-abi' ||
      abi.glibc_private !== 'absent' || abi.rpath_or_runpath !== 'absent' ||
      !Array.isArray(abi.glibc_versions) || !abi.glibc_versions.length ||
      !Array.isArray(abi.needed) || !abi.needed.length
    ) {
      throw new Error(`invalid ${label} Linux runtime ABI receipt`)
    }
    const versions = abi.glibc_versions as unknown[]
    const parsedVersions = versions.map((version) => {
      if (typeof version !== 'string') {
        throw new Error(`invalid ${label} Linux GLIBC version`)
      }
      const match = /^(\d+)\.(\d+)$/.exec(version)
      if (!match) throw new Error(`invalid ${label} Linux GLIBC version`)
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > 2 || (major === 2 && minor > 27)) {
        throw new Error(`${label} Linux runtime ABI exceeds GLIBC 2.27`)
      }
      return { version, major, minor }
    })
    const ordered = [...parsedVersions].sort((left, right) =>
      left.major - right.major || left.minor - right.minor
    )
    if (
      ordered.some((entry, index) => entry.version !== versions[index]) ||
      new Set(versions).size !== versions.length ||
      !(abi.needed as unknown[]).every((needed) =>
        typeof needed === 'string' && needed
      )
    ) {
      throw new Error(`invalid ${label} Linux runtime ABI coverage`)
    }
    const logs = objectField(abi.logs, `${label} Linux runtime ABI logs`)
    if (
      Object.keys(logs).length !== 2 || !('version-info.log' in logs) ||
      !('dynamic.log' in logs)
    ) {
      throw new Error(`invalid ${label} Linux runtime ABI logs`)
    }
    shaField(logs['version-info.log'], `${label} Linux version log SHA-256`)
    shaField(logs['dynamic.log'], `${label} Linux dynamic log SHA-256`)
    return
  }
  const expected = [
    'schema_version',
    'kind',
    'denort_sha256',
    'minimum_os',
    'load_commands_sha256',
    'status',
  ]
  if (
    Object.keys(abi).length !== expected.length ||
    expected.some((field) => !(field in abi)) ||
    abi.kind !== 'slv-macos-denort-abi' || abi.minimum_os !== '12.0'
  ) {
    throw new Error(`invalid ${label} macOS runtime ABI receipt`)
  }
  shaField(abi.load_commands_sha256, `${label} macOS load commands SHA-256`)
}

type CargoFingerprintPhase = 'baseline' | 'modified'
type CargoFingerprintContext = 'host-release' | 'target-release'

function expectedCargoFingerprintContexts(
  target: SourceProofTarget,
): readonly CargoFingerprintContext[] {
  // The selected Linux recipe always invokes Cargo with --target while also
  // compiling host tools. The macOS recipe does not use --target, so target
  // output there would be stale or unrelated evidence.
  return target.endsWith('linux-gnu')
    ? ['host-release', 'target-release']
    : ['host-release']
}

function cargoFingerprintPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || !value || value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`invalid ${label} path`)
  }
  return value
}

function canonicalFingerprintBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || !value) {
    throw new Error(`invalid ${label} content`)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error(`invalid ${label} canonical base64`)
  }
  if (btoa(binary) !== value) {
    throw new Error(`invalid ${label} canonical base64`)
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`invalid ${label} JSON`)
  }
  return bytes
}

function parseCargoFingerprintCollection(
  value: unknown,
  expected: {
    phase: CargoFingerprintPhase
    target: SourceProofTarget
    runtimeSha256: string
    derivedRelinkCargoLockSha256: string
  },
): void {
  const collection = objectField(value, 'Cargo fingerprint collection')
  exactKeys(
    collection,
    [
      'schema_version',
      'kind',
      'phase',
      'target',
      'runtime_sha256',
      'derived_relink_cargo_lock_sha256',
      'records',
    ],
    'Cargo fingerprint collection',
  )
  if (
    collection.schema_version !== 1 ||
    collection.kind !== 'slv-cargo-fingerprint-records' ||
    collection.phase !== expected.phase ||
    collection.target !== expected.target ||
    shaField(collection.runtime_sha256, 'Cargo fingerprint runtime SHA-256') !==
      expected.runtimeSha256 ||
    shaField(
        collection.derived_relink_cargo_lock_sha256,
        'Cargo fingerprint derived Cargo.lock SHA-256',
      ) !== expected.derivedRelinkCargoLockSha256 ||
    !Array.isArray(collection.records) || !collection.records.length
  ) {
    throw new Error('Cargo fingerprint collection does not bind its build')
  }
  const identities = new Set<string>()
  const contexts = new Set<CargoFingerprintContext>()
  for (const [index, value] of collection.records.entries()) {
    const record = objectField(value, `Cargo fingerprint record ${index}`)
    exactKeys(
      record,
      ['context', 'path', 'sha256', 'content_base64'],
      `Cargo fingerprint record ${index}`,
    )
    if (
      record.context !== 'host-release' && record.context !== 'target-release'
    ) {
      throw new Error(`invalid Cargo fingerprint record ${index} context`)
    }
    const context = record.context as CargoFingerprintContext
    const path = cargoFingerprintPath(
      record.path,
      `Cargo fingerprint record ${index}`,
    )
    if (!path.endsWith('.json')) {
      throw new Error(`invalid Cargo fingerprint record ${index} JSON path`)
    }
    const bytes = canonicalFingerprintBytes(
      record.content_base64,
      `Cargo fingerprint record ${index}`,
    )
    if (
      createHash('sha256').update(bytes).digest('hex') !==
        shaField(record.sha256, `Cargo fingerprint record ${index} SHA-256`)
    ) {
      throw new Error(`Cargo fingerprint record ${index} digest differs`)
    }
    const identity = `${context}/${path}`
    if (identities.has(identity)) {
      throw new Error(`duplicate Cargo fingerprint record: ${identity}`)
    }
    identities.add(identity)
    contexts.add(context)
  }
  const expectedContexts = expectedCargoFingerprintContexts(expected.target)
  if (
    contexts.size !== expectedContexts.length ||
    expectedContexts.some((context) => !contexts.has(context))
  ) {
    throw new Error(
      `Cargo fingerprint contexts differ for ${expected.target}`,
    )
  }
}

function parseProofChecks(
  value: unknown,
  target: SourceProofTarget,
  artifacts: ProofArtifacts,
): Record<string, unknown> {
  const checks = objectField(value, 'native proof checks')
  const required = [
    'baseline_build',
    'baseline_probe',
    'patch',
    'modified_build',
    'modified_probe',
    'slv_compile',
    'slv_version',
    'slv_help',
    'release_bridge',
    'licenses',
  ]
  if (
    Object.keys(checks).length !== required.length ||
    required.some((name) => !(name in checks))
  ) {
    throw new Error('native proof has an incomplete check set')
  }
  const baselineBuild = passedCheck(checks.baseline_build, 'baseline build')
  commandReceipt(
    baselineBuild.command,
    'baseline build command',
  )
  parseRuntimeAbi(
    baselineBuild.runtime_abi,
    baselineBuild.runtime_abi_receipt_sha256,
    target,
    artifacts.baseline.denort_sha256,
    'baseline build',
  )
  const baselineDerivedLock = shaField(
    baselineBuild.derived_relink_cargo_lock_sha256,
    'baseline build derived Cargo.lock SHA-256',
  )
  if (
    baselineDerivedLock !==
      artifacts.baseline.derived_relink_cargo_lock_sha256
  ) {
    throw new Error('baseline build derived Cargo.lock differs from artifacts')
  }
  parseCargoFingerprintCollection(baselineBuild.cargo_fingerprints, {
    phase: 'baseline',
    target,
    runtimeSha256: artifacts.baseline.denort_sha256,
    derivedRelinkCargoLockSha256:
      artifacts.baseline.derived_relink_cargo_lock_sha256,
  })
  const baselineProbe = probeCheck(checks.baseline_probe, 'baseline probe')
  const patch = passedCheck(checks.patch, 'sentinel patch')
  const before = shaField(patch.before_sha256, 'sentinel patch before SHA-256')
  const after = shaField(patch.after_sha256, 'sentinel patch after SHA-256')
  if (before === after) {
    throw new Error('sentinel patch did not change source bytes')
  }
  commandReceipt(patch.command, 'sentinel patch command')
  const modifiedBuild = passedCheck(checks.modified_build, 'modified build')
  commandReceipt(
    modifiedBuild.command,
    'modified build command',
  )
  parseRuntimeAbi(
    modifiedBuild.runtime_abi,
    modifiedBuild.runtime_abi_receipt_sha256,
    target,
    artifacts.modified.denort_sha256,
    'modified build',
  )
  const modifiedDerivedLock = shaField(
    modifiedBuild.derived_relink_cargo_lock_sha256,
    'modified build derived Cargo.lock SHA-256',
  )
  parseCargoFingerprintCollection(modifiedBuild.cargo_fingerprints, {
    phase: 'modified',
    target,
    runtimeSha256: artifacts.modified.denort_sha256,
    derivedRelinkCargoLockSha256: modifiedDerivedLock,
  })
  const modifiedProbe = probeCheck(checks.modified_probe, 'modified probe')
  if (
    baselineProbe.sentinel.input !== 0.125 ||
    baselineProbe.control.input !== 0.126 ||
    modifiedProbe.sentinel.input !== 0.125 ||
    modifiedProbe.control.input !== 0.126
  ) {
    throw new Error('native proof probes have unexpected sentinel inputs')
  }
  if (baselineProbe.sentinel.output === 0.5) {
    throw new Error(
      'baseline native probe unexpectedly returned sentinel value',
    )
  }
  if (modifiedProbe.sentinel.output !== 0.5) {
    throw new Error('modified native probe did not return sentinel value')
  }
  if (
    baselineProbe.control.output !== modifiedProbe.control.output ||
    modifiedProbe.control.output === 0.5
  ) {
    throw new Error(
      'native probe controls do not establish an unchanged runtime',
    )
  }
  commandReceipt(
    passedCheck(checks.slv_compile, 'SLV compile').command,
    'SLV compile command',
  )
  commandReceipt(
    passedCheck(checks.slv_version, 'SLV version').command,
    'SLV version command',
  )
  commandReceipt(
    passedCheck(checks.slv_help, 'SLV help').command,
    'SLV help command',
  )
  const bridge = passedCheck(checks.release_bridge, 'release bridge')
  commandReceipt(bridge.compile, 'release bridge compile command')
  commandReceipt(bridge.command, 'release bridge command')
  const licenses = passedCheck(checks.licenses, 'embedded licenses')
  shaField(
    licenses.canonical_notice_sha256,
    'embedded licenses canonical notice SHA-256',
  )
  commandReceipt(licenses.command, 'embedded licenses command')
  return checks
}

function proofCanonicalNoticeSha256(checks: Record<string, unknown>): string {
  return shaField(
    objectField(checks.licenses, 'embedded licenses')
      .canonical_notice_sha256,
    'embedded licenses canonical notice SHA-256',
  )
}

type ParsedTargetProof = {
  target: SourceProofTarget
  sourceCommit: string
  sourceReceiptSha256: string
  sourceAssets: SourceAsset[]
  buildMode: 'native' | 'cross'
  buildHost: ProofHost
  executionHost: ProofHost
  sourcePinSha256: string
  sourceSelectedCargoLockSha256: string
  toolPinSha256: string
  patchSha256: string
  buildReceiptSha256: string
  executionReceiptSha256: string
  jobs: string
  artifacts: ProofArtifacts
  checks: Record<string, unknown>
}

function parseTargetProof(value: unknown): ParsedTargetProof {
  const proof = objectField(value, 'native target proof')
  if (
    proof.schema_version !== 1 || proof.kind !== 'slv-source-target-proof' ||
    proof.status !== 'passed'
  ) {
    throw new Error('unsupported or unsuccessful native target proof')
  }
  if (
    typeof proof.jobs !== 'string' || !/^(?:[1-9]|1[0-6])$/.test(proof.jobs)
  ) {
    throw new Error(
      'native target proof has an invalid bounded build jobs value',
    )
  }
  const target = proof.target
  if (
    typeof target !== 'string' ||
    !(SOURCE_PROOF_TARGETS as readonly string[]).includes(target)
  ) {
    throw new Error('native target proof has an unsupported target')
  }
  const typedTarget = target as SourceProofTarget
  const buildMode = proof.build_mode
  if (buildMode !== 'native' && buildMode !== 'cross') {
    throw new Error('native target proof has an invalid build mode')
  }
  const buildHost = parseProofHost(proof.build_host, 'native target build host')
  const executionHost = parseProofHost(
    proof.execution_host,
    'native target execution host',
  )
  const expectedHost = expectedProofHost(typedTarget)
  const isApprovedCross = typedTarget === 'aarch64-unknown-linux-gnu' &&
    buildHost.os === 'linux' && buildHost.arch === 'x64' &&
    executionHost.os === 'linux' && executionHost.arch === 'arm64'
  if (
    (buildMode === 'cross' && !isApprovedCross) ||
    (buildMode === 'native' &&
      (!equalJson(buildHost, expectedHost) ||
        !equalJson(executionHost, expectedHost)))
  ) {
    throw new Error(
      'native target proof has an unapproved build/execution host pair',
    )
  }

  const artifacts = parseProofAssets(
    proof.artifacts,
    'native target proof artifacts',
  )
  const buildArtifacts = parseProofAssets(
    proof.build_artifacts,
    'native target build artifacts',
  )
  const executionArtifacts = parseProofAssets(
    proof.execution_artifacts,
    'native target execution artifacts',
  )
  if (
    !equalJson(artifacts, buildArtifacts) ||
    !equalJson(artifacts, executionArtifacts)
  ) {
    throw new Error(
      'native target proof execution artifacts differ from its build artifacts',
    )
  }
  return {
    target: typedTarget,
    sourceCommit: nonemptyString(
      proof.source_commit,
      'native target source commit',
    ),
    sourceReceiptSha256: shaField(
      proof.source_receipt_sha256,
      'native target source receipt SHA-256',
    ),
    sourceAssets: parseProofSourceAssets(proof.source_assets),
    buildMode,
    buildHost,
    executionHost,
    sourcePinSha256: shaField(
      proof.source_pin_sha256,
      'native target source pin SHA-256',
    ),
    sourceSelectedCargoLockSha256: shaField(
      proof.source_selected_cargo_lock_sha256,
      'native target selected Cargo.lock SHA-256',
    ),
    toolPinSha256: shaField(
      proof.tool_pin_sha256,
      'native target tool pin SHA-256',
    ),
    patchSha256: shaField(proof.patch_sha256, 'native target patch SHA-256'),
    buildReceiptSha256: shaField(
      proof.build_receipt_sha256,
      'native target build receipt SHA-256',
    ),
    executionReceiptSha256: shaField(
      proof.execution_receipt_sha256,
      'native target execution receipt SHA-256',
    ),
    jobs: proof.jobs,
    artifacts,
    checks: parseProofChecks(proof.checks, typedTarget, artifacts),
  }
}

/** Validate one target-proof record before its phase receipts are published. */
export function verifyNativeSourceRebuildProof(value: unknown): void {
  parseTargetProof(value)
}

function verifyPhaseReceipts(
  proof: ParsedTargetProof,
  build: unknown,
  execution: unknown,
): void {
  const buildReceipt = objectField(build, 'native build receipt')
  if (
    buildReceipt.schema_version !== 1 ||
    buildReceipt.kind !== 'slv-source-build-receipt' ||
    buildReceipt.target !== proof.target ||
    buildReceipt.build_mode !== proof.buildMode ||
    !equalJson(buildReceipt.build_host, proof.buildHost) ||
    buildReceipt.source_commit !== proof.sourceCommit ||
    buildReceipt.source_receipt_sha256 !== proof.sourceReceiptSha256 ||
    buildReceipt.source_pin_sha256 !== proof.sourcePinSha256 ||
    buildReceipt.source_selected_cargo_lock_sha256 !==
      proof.sourceSelectedCargoLockSha256 ||
    buildReceipt.tool_pin_sha256 !== proof.toolPinSha256 ||
    buildReceipt.patch_sha256 !== proof.patchSha256 ||
    buildReceipt.jobs !== proof.jobs ||
    !equalJson(
      parseProofSourceAssets(buildReceipt.source_assets),
      proof.sourceAssets,
    ) ||
    !equalJson(
      parseProofAssets(
        buildReceipt.artifacts,
        'native build receipt artifacts',
      ),
      proof.artifacts,
    )
  ) {
    throw new Error(
      `native build receipt does not bind ${proof.target} proof inputs`,
    )
  }
  const executionReceipt = objectField(execution, 'native execution receipt')
  if (
    executionReceipt.schema_version !== 1 ||
    executionReceipt.kind !== 'slv-source-execution-receipt' ||
    executionReceipt.target !== proof.target ||
    executionReceipt.build_mode !== proof.buildMode ||
    executionReceipt.build_receipt_sha256 !== proof.buildReceiptSha256 ||
    !equalJson(executionReceipt.execution_host, proof.executionHost) ||
    !equalJson(
      parseProofAssets(
        executionReceipt.artifacts,
        'native execution receipt artifacts',
      ),
      proof.artifacts,
    )
  ) {
    throw new Error(
      `native execution receipt does not bind ${proof.target} build artifacts`,
    )
  }
  const buildChecks = objectField(
    buildReceipt.checks,
    'native build receipt checks',
  )
  const executionChecks = objectField(
    executionReceipt.checks,
    'native execution receipt checks',
  )
  for (
    const name of ['baseline_build', 'patch', 'modified_build', 'slv_compile']
  ) {
    if (!equalJson(buildChecks[name], proof.checks[name])) {
      throw new Error(`native build receipt check differs: ${name}`)
    }
  }
  for (
    const name of [
      'baseline_probe',
      'modified_probe',
      'slv_version',
      'slv_help',
      'release_bridge',
      'licenses',
    ]
  ) {
    if (!equalJson(executionChecks[name], proof.checks[name])) {
      throw new Error(`native execution receipt check differs: ${name}`)
    }
  }
}

/**
 * Verify the four independently-produced native target proofs against the
 * immutable source receipt. Proofs are inputs to publication, never assets.
 */
export async function verifySourceProofSet(
  options: SourceProofSetOptions,
): Promise<void> {
  const notice = await requireRegularFile(
    options.canonicalNoticePath,
    'canonical notice',
  )
  const noticeSha256 = await sha256(options.canonicalNoticePath)
  const receiptBytes = await Deno.readFile(options.sourceReceiptPath)
  const receiptSha256 = sha256Bytes(receiptBytes)
  const receipt = await verifyReceiptFiles(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)),
    options.sourceDirectory,
    { sourceCommit: options.sourceCommit, canonicalNoticeSha256: noticeSha256 },
  )
  if (
    receipt.canonical_notice.size !== notice.size ||
    await sha256(options.sourcePinsPath) !== receipt.pins.sha256
  ) {
    throw new Error('source proof inputs differ from immutable source receipt')
  }
  const reviewedToolPins = JSON.parse(
    await Deno.readTextFile(
      options.reviewedToolPinsPath ??
        defaultReviewedToolPinsPath(options.sourcePinsPath),
    ),
  )
  const directories: string[] = []
  for await (const entry of Deno.readDir(options.proofDirectory)) {
    if (!entry.isDirectory || entry.isSymlink) {
      throw new Error('source proof directory has an unexpected entry')
    }
    directories.push(entry.name)
  }
  if (
    directories.length !== SOURCE_PROOF_TARGETS.length ||
    SOURCE_PROOF_TARGETS.some((target) => !directories.includes(target))
  ) {
    throw new Error(
      'source proof directory must contain exactly four target proofs',
    )
  }
  let patchSha256: string | undefined
  for (const target of SOURCE_PROOF_TARGETS) {
    const root = join(options.proofDirectory, target)
    const [proofText, buildText, executionText] = await Promise.all([
      Deno.readTextFile(join(root, 'native-proof.json')),
      Deno.readTextFile(join(root, 'build-receipt.json')),
      Deno.readTextFile(join(root, 'execution-receipt.json')),
    ])
    const proof = parseTargetProof(JSON.parse(proofText))
    if (
      proof.target !== target || proof.sourceCommit !== receipt.source.commit ||
      proof.sourceReceiptSha256 !== receiptSha256 ||
      !equalJson(proof.sourceAssets, receipt.assets) ||
      proof.sourcePinSha256 !== receipt.pins.sha256
    ) {
      throw new Error(`native target proof is stale or mismatched: ${target}`)
    }
    if (
      proof.sourceSelectedCargoLockSha256 !==
        receipt.runtime_security.selected.cargo_lock.sha256
    ) {
      throw new Error(
        `native target proof selected Cargo.lock differs from source receipt: ${target}`,
      )
    }
    if (
      proofCanonicalNoticeSha256(proof.checks) !==
        receipt.canonical_notice.sha256
    ) {
      throw new Error(
        `native target proof licenses differ from canonical notice: ${target}`,
      )
    }
    const expectedToolPins = join(options.toolPinsDirectory, `${target}.json`)
    const canonicalDescriptor = canonicalTargetDescriptorBytes(
      reviewedToolPins,
      target,
    )
    const transportedDescriptor = await Deno.readFile(expectedToolPins)
    if (!equalBytes(transportedDescriptor, canonicalDescriptor)) {
      throw new Error(
        `native target descriptor differs from reviewed tool pins: ${target}`,
      )
    }
    if (sha256Bytes(canonicalDescriptor) !== proof.toolPinSha256) {
      throw new Error(`native target proof tool pin differs: ${target}`)
    }
    if (patchSha256 && patchSha256 !== proof.patchSha256) {
      throw new Error(
        'native target proofs do not share one sentinel patch identity',
      )
    }
    patchSha256 = proof.patchSha256
    const buildPath = join(root, 'build-receipt.json')
    const executionPath = join(root, 'execution-receipt.json')
    if (
      await sha256(buildPath) !== proof.buildReceiptSha256 ||
      await sha256(executionPath) !== proof.executionReceiptSha256
    ) {
      throw new Error(
        `native target proof phase receipt checksum differs: ${target}`,
      )
    }
    verifyPhaseReceipts(proof, JSON.parse(buildText), JSON.parse(executionText))
  }
}

function parsePackageArguments(args: string[]): SourcePackageOptions {
  const flags: Record<string, string> = {}
  const allowed = new Set([
    '--source-root',
    '--source-commit',
    '--pins',
    '--cache',
    '--work-dir',
    '--out',
    '--receipt',
    '--notice-file',
  ])
  if (args.length !== allowed.size * 2) {
    throw new Error('invalid source package arguments')
  }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (
      !flag || !allowed.has(flag) || !value || value.startsWith('--') ||
      flags[flag]
    ) {
      throw new Error(`invalid source package argument: ${flag ?? '<missing>'}`)
    }
    flags[flag] = value
  }
  if ([...allowed].some((flag) => !flags[flag])) {
    throw new Error('source package arguments are incomplete')
  }
  return {
    sourceRoot: flags['--source-root'],
    sourceCommit: flags['--source-commit'],
    pinsPath: flags['--pins'],
    cache: flags['--cache'],
    workDir: flags['--work-dir'],
    outputDirectory: flags['--out'],
    receiptPath: flags['--receipt'],
    noticeFile: flags['--notice-file'],
  }
}

if (import.meta.main) {
  const [action, ...args] = Deno.args
  if (action === 'verify-source-proofs' && args.length === 7) {
    await verifySourceProofSet({
      sourceReceiptPath: args[0],
      sourceDirectory: args[1],
      proofDirectory: args[2],
      sourceCommit: args[3],
      sourcePinsPath: args[4],
      toolPinsDirectory: args[5],
      canonicalNoticePath: args[6],
    })
  } else if (action === 'package') {
    await packageSourceMaterials(parsePackageArguments(args))
  } else if (action === 'materialize-rusty-v8-source' && args.length === 5) {
    await materializeRustyV8Source(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
    )
  } else if (action === 'verify-pin' && args.length === 2) {
    const pins = await readPins(args[0])
    const name = args[1]
    if (name !== 'deno' && name !== 'rusty_v8' && name !== 'v8') {
      throw new Error(`unknown pin: ${args[1]}`)
    }
    await verifyPinnedArchive(Deno.env.get('SOURCE_ARCHIVE') ?? '', pins[name])
  } else if (action === 'inventory' && args.length === 2) {
    await writeInventory(args[0], args[1])
  } else if (action === 'verify-inventory' && args.length === 2) {
    await verifyInventory(args[0], args[1])
  } else if (action === 'assert-pure-source' && args.length === 1) {
    await assertPureSourceTree(args[0])
  } else if (action === 'verify-receipt' && args.length === 2) {
    await verifyReceiptFiles(
      JSON.parse(await Deno.readTextFile(args[0])),
      args[1],
    )
  } else {
    throw new Error(
      'usage: source-materials.ts verify-source-proofs RECEIPT SOURCE_DIR PROOF_ROOT SOURCE_SHA SOURCE_PINS TOOL_PINS NOTICE_PATH | package --source-root SLV_TREE --source-commit REVIEWED_SHA --pins PINS_JSON --cache ACQUISITION_CACHE --work-dir EMPTY_ASSEMBLY_DIR --out OUTPUT_DIR --receipt RECEIPT_JSON --notice-file CANONICAL_NOTICE | materialize-rusty-v8-source SOURCE_ROOT PINS CACHE EMPTY_DESTINATION OBJECT_STORE_RECEIPT | verify-pin PINS deno|rusty_v8|v8 (SOURCE_ARCHIVE=FILE) | inventory TREE OUTPUT | verify-inventory TREE INVENTORY | assert-pure-source TREE | verify-receipt RECEIPT OUTPUT_DIR',
    )
  }
}
