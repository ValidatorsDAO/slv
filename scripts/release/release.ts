/** Offline, deterministic construction of the files uploaded by a release. */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import {
  checkFreshRuntimeRevocation,
  checkReviewedRuntimeRevocation,
  verifyRuntimeRevocationBinding,
} from './runtime-revocations.ts'
import { buildRuntimeNotices } from './runtime-notices.ts'
import { materializeApplicationNotices } from './application-notices.ts'
import {
  type CurrentProductReceipt,
  embeddingRecipeSha256,
  inspectMachO,
  parseCurrentProductReceipt,
  verifyCurrentProductFiles,
} from './build-product.ts'
import {
  githubQualificationAdapter,
  qualificationIdentity,
  readQualificationManifest,
  verifyPublishedQualification,
  verifyQualificationBinding,
} from './runtime-qualification.ts'
import {
  CANONICAL_NOTICE_NAME,
  readPins,
  type SourceMaterialsReceipt,
  verifyLinuxSourceProofSet,
  verifyReceiptFiles,
  verifySourceMaterialsReceipt,
  verifySourceProofSet,
} from './source-materials.ts'

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export const TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
] as const
export const SKILLS = [
  'slv-validator',
  'slv-rpc',
  'slv-grpc-geyser',
  'slv-benchmark',
  'slv-app',
  'slv-bot-trade-app',
  'slv-server-procurement',
  'slv-backup',
  'slv-firewall',
  'slv-wireguard',
] as const
/**
 * These archives are independently verified source/relink materials.  They
 * are release payload identities, but never install or upgrade inputs.
 */
export const SOURCE_ASSETS = [
  'slv-source.tar.gz',
  'deno-source.tar.gz',
  'deno-cargo-vendor.tar.gz',
] as const
export const SOURCE_ASSET_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const SOURCE_MATERIALS_DIRECTORY = 'dist/release-inputs/source-materials'
export const SOURCE_MATERIALS_RECEIPT =
  'dist/release-inputs/source-materials-receipt.json'
export type AssetKind =
  | 'executable'
  | 'template'
  | 'skill'
  | 'installer'
  | 'sbom'
  | 'notices'
  | 'source'
export type Asset = {
  name: string
  kind: AssetKind
  target?: string
  sha256: string
  size: number
}
type AssetSpec = Omit<Asset, 'sha256' | 'size'>
type LockPackage = { integrity?: unknown }
export type Lockfile = {
  version?: unknown
  jsr?: Record<string, LockPackage>
  npm?: Record<string, LockPackage>
  remote?: Record<string, unknown>
}

const CALVER = /^\d{4}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12]\d|3[01])\.\d{4}$/
const SHA256 = /^[a-f0-9]{64}$/
const SHA40 = /^[a-f0-9]{40}$/
const DECIMAL = /^[1-9]\d*$/
const PR_MERGE_REF = /^refs\/pull\/[1-9]\d*\/merge$/
const NOTICE_FILE =
  /^(?:(?:licen[cs]e|notice|copying)(?:\.(?:txt|md))?|(?:licen[cs]e|notice|copying)[-_](?:apache(?:-2(?:\.0)?)?|mit|bsd(?:-[0-9]-clause)?|gpl(?:-[0-9](?:\.0)?(?:-or-later)?)?|lgpl(?:-[0-9](?:\.0)?(?:-or-later)?)?|mpl(?:-2(?:\.0)?))(?:\.(?:txt|md))?|mit-license(?:\.(?:txt|md))?)$/i
const DENO_RUNTIME_VERSION = '2.9.3'
const DENO_RUNTIME_SOURCE =
  `https://github.com/denoland/deno/releases/tag/v${DENO_RUNTIME_VERSION}`
const SOURCE_MATERIALS_PINS = 'source-materials/pins.json'
const join = (...parts: string[]) => parts.join('/').replaceAll(/\/{2,}/g, '/')

type CompiledModuleGraph = {
  schema_version: 1
  npm: string[]
  jsr: string[]
  remote: string[]
}

type DenoInfo = {
  modules?: Array<{ specifier?: unknown; mediaType?: unknown }>
  npmPackages?: Record<string, unknown>
}

type ComponentNamespace = 'npm' | 'jsr' | 'remote'
type Component = {
  namespace: ComponentNamespace
  key: string
  name: string
  version: string
}

export const payloadSpecs = (): AssetSpec[] => [
  ...TARGETS.map((target) => ({
    name: `slv-${target}-exe.tar.gz`,
    kind: 'executable' as const,
    target,
  })),
  { name: 'template.tar.gz', kind: 'template' },
  ...SKILLS.map((name) => ({ name: `${name}.tar.gz`, kind: 'skill' as const })),
  { name: 'install', kind: 'installer' },
  { name: 'sbom.spdx.json', kind: 'sbom' },
  { name: 'THIRD_PARTY_NOTICES', kind: 'notices' },
  ...SOURCE_ASSETS.map((name) => ({ name, kind: 'source' as const })),
]

export type QualificationReference = {
  identity: string
  tag: string
  manifest_sha256: string
  state: 'candidate-validation' | 'final-qualified'
  products: Array<{ receipt_sha256: string; receipt: CurrentProductReceipt }>
}
/** Language-independent receipt encoding, also used by the Python consumer. */
export function canonicalReceipt(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalReceipt).join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    ).map(([key, entry]) =>
      JSON.stringify(key) + ':' + canonicalReceipt(entry)
    ).join(',') + '}'
  }
  return JSON.stringify(value)
}
export function validateQualificationReference(
  value: unknown,
  expected?: {
    sourceSha: string
    sourceRef: string
    runId: string
    runAttempt: string
    release: boolean
  },
): QualificationReference {
  const r = value as QualificationReference
  if (
    !r || typeof r !== 'object' || Array.isArray(r) ||
    Object.keys(r).sort().join(',') !==
      ['identity', 'tag', 'manifest_sha256', 'state', 'products'].sort().join(
        ',',
      ) ||
    !SHA256.test(r.identity) || r.manifest_sha256 !== r.identity ||
    r.tag !== `runtime-deno-v2.9.3-${r.identity}` ||
    !['candidate-validation', 'final-qualified'].includes(r.state) ||
    !Array.isArray(r.products) || r.products.length !== TARGETS.length
  ) throw new Error('invalid runtime qualification reference')
  for (const [index, entry] of r.products.entries()) {
    if (
      !entry || Object.keys(entry).sort().join(',') !== 'receipt,receipt_sha256'
    ) throw new Error('invalid qualified product reference')
    const product = parseCurrentProductReceipt(entry.receipt)
    if (
      product.target !== TARGETS[index] ||
      product.qualification.identity !== r.identity ||
      product.qualification.state !== r.state ||
      createHash('sha256').update(canonicalReceipt(product)).digest('hex') !==
        entry.receipt_sha256
    ) throw new Error('qualified product receipt digest or target differs')
    if (
      expected &&
      (product.source.commit !== expected.sourceSha ||
        product.source.ref !== expected.sourceRef ||
        product.producer.run_id !== expected.runId ||
        BigInt(product.producer.run_attempt) > BigInt(expected.runAttempt) ||
        (expected.release && r.state !== 'final-qualified'))
    ) throw new Error('qualified product release identity differs')
    if (
      expected?.release &&
      product.producer.profile !==
        (product.target === 'aarch64-unknown-linux-gnu'
          ? 'linux-arm64-4'
          : 'linux-16')
    ) {
      throw new Error(
        'final release product was not built on the required self-hosted profile',
      )
    }
    if (
      index &&
      (canonicalReceipt(product.source) !==
          canonicalReceipt(r.products[0].receipt.source) ||
        product.producer.workflow_sha !==
          r.products[0].receipt.producer.workflow_sha)
    ) {
      throw new Error(
        'qualified products do not bind one current application input set',
      )
    }
  }
  return r
}

export function assertVersion(version: string): void {
  if (!CALVER.test(version)) throw new Error(`invalid CalVer: ${version}`)
  const [year, month, day, time] = version.split('.').map(Number)
  const date = new Date(
    Date.UTC(year, month - 1, day, Math.floor(time / 100), time % 100),
  )
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== Math.floor(time / 100) ||
    date.getUTCMinutes() !== time % 100
  ) throw new Error(`invalid CalVer date: ${version}`)
}

export async function hashFile(path: string): Promise<string> {
  const file = await Deno.open(path)
  const hash = createHash('sha256')
  const chunk = new Uint8Array(1024 * 1024)
  try {
    for (;;) {
      const size = await file.read(chunk)
      if (size === null) break
      hash.update(chunk.subarray(0, size))
    }
  } finally {
    file.close()
  }
  return hash.digest('hex')
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Uint8Array(
    await new Response(source.pipeThrough(
      new CompressionStream('gzip') as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    )).arrayBuffer(),
  )
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    return new Uint8Array(
      await new Response(source.pipeThrough(
        new DecompressionStream('gzip') as unknown as TransformStream<
          Uint8Array,
          Uint8Array
        >,
      )).arrayBuffer(),
    )
  } catch (error) {
    throw new Error(
      `invalid gzip archive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
function isZeroBlock(bytes: Uint8Array, start: number): boolean {
  for (let i = start; i < start + 512; i += 1) if (bytes[i] !== 0) return false
  return true
}
function tarString(bytes: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && bytes[end] !== 0) end += 1
  return decoder.decode(bytes.slice(start, end))
}
function tarOctal(
  bytes: Uint8Array,
  start: number,
  length: number,
  field: string,
): number {
  const raw = tarString(bytes, start, length).trim()
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${field}`)
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid tar ${field}`)
  }
  return value
}
export type TarEntry = {
  path: string
  type: 'file' | 'directory'
  size: number
}

/** Binary USTAR parser: types and paths never depend on `tar -tv` formatting. */
export async function readTar(path: string): Promise<TarEntry[]> {
  const bytes = await gunzip(await Deno.readFile(path))
  const entries: TarEntry[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 512 > bytes.length) {
      throw new Error(`${path}: truncated tar header`)
    }
    if (isZeroBlock(bytes, offset)) {
      if (offset + 1024 > bytes.length || !isZeroBlock(bytes, offset + 512)) {
        throw new Error(`${path}: missing tar terminator`)
      }
      for (let i = offset + 1024; i < bytes.length; i += 1) {
        if (bytes[i] !== 0) {
          throw new Error(`${path}: data after tar terminator`)
        }
      }
      if (!entries.length) throw new Error(`${path}: empty archive`)
      return entries
    }
    const stored = tarOctal(bytes, offset + 148, 8, 'checksum')
    let actual = 0
    for (let i = 0; i < 512; i += 1) {
      actual += i >= 148 && i < 156 ? 32 : bytes[offset + i]
    }
    if (stored !== actual) throw new Error(`${path}: invalid tar checksum`)
    const name = tarString(bytes, offset, 100)
    const prefix = tarString(bytes, offset + 345, 155)
    const flag = bytes[offset + 156]
    const type = flag === 0 || flag === 48
      ? 'file'
      : flag === 53
      ? 'directory'
      : undefined
    if (!type) {
      throw new Error(
        `${path}: forbidden tar entry type ${String.fromCharCode(flag || 48)}`,
      )
    }
    const size = tarOctal(bytes, offset + 124, 12, 'size')
    if (type === 'directory' && size !== 0) {
      throw new Error(`${path}: directory has data`)
    }
    entries.push({ path: prefix ? `${prefix}/${name}` : name, type, size })
    offset += 512 + Math.ceil(size / 512) * 512
    if (offset > bytes.length) throw new Error(`${path}: truncated tar data`)
  }
  throw new Error(`${path}: missing tar terminator`)
}
function archivePath(value: string): string {
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value
  if (
    !normalized || normalized.startsWith('/') || normalized.includes('\\') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error(`unsafe archive path: ${value}`)
  return normalized
}
export async function assertArchive(
  path: string,
  root: string,
  options: { singleFile?: boolean; requireContents?: boolean } = {},
): Promise<void> {
  const expected = archivePath(root)
  const seen = new Set<string>()
  const directories = new Set<string>()
  let content = false
  for (const entry of await readTar(path)) {
    const name = archivePath(entry.path)
    if (seen.has(name)) {
      throw new Error(`${path}: duplicate archive entry ${name}`)
    }
    seen.add(name)
    if (name !== expected && !name.startsWith(`${expected}/`)) {
      throw new Error(`${path}: entry outside ${expected}: ${name}`)
    }
    if (options.singleFile) {
      if (entry.type !== 'file' || name !== expected || seen.size !== 1) {
        throw new Error(`${path}: requires exactly one regular ${expected}`)
      }
      continue
    }
    if (entry.type === 'directory') directories.add(name)
    if (entry.type === 'file' && name !== expected) content = true
  }
  if (options.singleFile && seen.size !== 1) {
    throw new Error(`${path}: requires exactly one regular ${expected}`)
  }
  if (!options.singleFile) {
    if (!directories.has(expected)) {
      throw new Error(`${path}: missing root directory ${expected}`)
    }
    for (const name of seen) {
      let parent = name.includes('/')
        ? name.slice(0, name.lastIndexOf('/'))
        : ''
      while (parent && parent.startsWith(expected)) {
        if (!directories.has(parent)) {
          throw new Error(
            `${path}: missing explicit parent directory ${parent}`,
          )
        }
        parent = parent.includes('/')
          ? parent.slice(0, parent.lastIndexOf('/'))
          : ''
      }
    }
    if (options.requireContents !== false && !content) {
      throw new Error(`${path}: archive has no files below ${expected}`)
    }
  }
}

function assertAssets(assets: Asset[]): void {
  const specs = payloadSpecs()
  if (assets.length !== specs.length) {
    throw new Error(`expected ${specs.length} payloads, got ${assets.length}`)
  }
  for (let i = 0; i < specs.length; i += 1) {
    const asset = assets[i]
    const spec = specs[i]
    if (
      !asset || asset.name !== spec.name || asset.kind !== spec.kind ||
      asset.target !== spec.target || !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      (spec.kind === 'source' && asset.size >= SOURCE_ASSET_MAX_BYTES)
    ) throw new Error(`invalid payload inventory entry at ${i}`)
  }
}
export async function inventory(releaseDir: string): Promise<Asset[]> {
  const assets: Asset[] = []
  for (const spec of payloadSpecs()) {
    const info = await Deno.stat(join(releaseDir, spec.name))
    if (!info.isFile || info.size <= 0) {
      throw new Error(`missing or empty payload ${spec.name}`)
    }
    assets.push({
      ...spec,
      sha256: await hashFile(join(releaseDir, spec.name)),
      size: info.size,
    })
  }
  assertAssets(assets)
  return assets
}
export function manifest(
  version: string,
  sourceSha: string,
  sourceRef: string,
  runId: string,
  runAttempt: string,
  assets: Asset[],
  qualification?: QualificationReference,
) {
  assertVersion(version)
  if (!SHA40.test(sourceSha)) throw new Error('invalid source commit')
  if (
    sourceRef !== 'refs/heads/main' && sourceRef !== `refs/tags/v${version}`
  ) throw new Error('invalid source ref')
  if (!DECIMAL.test(runId) || !DECIMAL.test(runAttempt)) {
    throw new Error('invalid workflow identity')
  }
  assertAssets(assets)
  return {
    schema_version: qualification ? 2 : 1,
    repository: 'ValidatorsDAO/slv',
    version,
    tag: `v${version}`,
    source: { commit: sourceSha, ref: sourceRef },
    workflow: {
      path: '.github/workflows/slv-remote-build.yml',
      run_id: runId,
      run_attempt: Number(runAttempt),
    },
    assets,
    ...(qualification
      ? {
        runtime_qualification: validateQualificationReference(qualification, {
          sourceSha,
          sourceRef,
          runId,
          runAttempt,
          release: true,
        }),
      }
      : {}),
  }
}

/** CI packages are inspectable artifacts only; they are never publishable. */
export function ciManifest(
  version: string,
  sourceSha: string,
  sourceRef: string,
  runId: string,
  runAttempt: string,
  assets: Asset[],
  qualification?: QualificationReference,
) {
  assertVersion(version)
  if (!SHA40.test(sourceSha)) throw new Error('invalid source commit')
  if (
    !PR_MERGE_REF.test(sourceRef) &&
    !(qualification && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef))
  ) {
    throw new Error('CI package requires an exact pull-request merge ref')
  }
  if (!DECIMAL.test(runId) || !DECIMAL.test(runAttempt)) {
    throw new Error('invalid workflow identity')
  }
  assertAssets(assets)
  return {
    schema_version: qualification ? 2 : 1,
    artifact_kind: 'ci-only',
    unsigned: true,
    repository: 'ValidatorsDAO/slv',
    version,
    tag: `v${version}`,
    source: { commit: sourceSha, ref: sourceRef },
    workflow: {
      path: '.github/workflows/slv-remote-build.yml',
      run_id: runId,
      run_attempt: Number(runAttempt),
    },
    assets,
    ...(qualification
      ? {
        runtime_qualification: validateQualificationReference(qualification, {
          sourceSha,
          sourceRef,
          runId,
          runAttempt,
          release: false,
        }),
      }
      : {}),
  }
}

function packageKey(value: string): { name: string; version: string } {
  const separator = value.startsWith('@')
    ? value.indexOf('@', value.indexOf('/') + 1)
    : value.indexOf('@')
  if (separator <= 0) throw new Error(`invalid package key: ${value}`)
  const name = value.slice(0, separator)
  const version = value.slice(separator + 1).split('_', 1)[0]
  if (!name || !version) throw new Error(`invalid package key: ${value}`)
  return { name, version }
}
function hexFromSRI(
  value: unknown,
): { algorithm: string; checksumValue: string } {
  if (typeof value !== 'string') {
    throw new Error('npm package is missing integrity')
  }
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) throw new Error(`invalid SRI integrity: ${value}`)
  let decoded: string
  try {
    decoded = atob(match[2])
  } catch {
    throw new Error(`invalid SRI base64: ${value}`)
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  if (bytes.length !== Number(match[1].slice(3)) / 8) {
    throw new Error(`invalid SRI digest length: ${value}`)
  }
  return {
    algorithm: match[1].toUpperCase(),
    checksumValue: [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  }
}
function hexChecksum(
  value: unknown,
  label: string,
): { algorithm: 'SHA256'; checksumValue: string } {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`invalid ${label} integrity`)
  }
  return { algorithm: 'SHA256', checksumValue: value }
}
function npmLocation(name: string, version: string): string {
  const basename = name.includes('/')
    ? name.slice(name.lastIndexOf('/') + 1)
    : name
  return `https://registry.npmjs.org/${
    encodeURIComponent(name)
  }/-/${basename}-${version}.tgz`
}
function lockInventory(lock: Lockfile): Component[] {
  if (lock.version !== '5' || !lock.jsr || !lock.npm || !lock.remote) {
    throw new Error(
      'deno.lock must be version 5 with JSR, NPM, and remote inventories',
    )
  }
  return [
    ...Object.keys(lock.jsr).sort().map((key) => {
      const { name, version } = packageKey(key)
      return { namespace: 'jsr' as const, key, name, version }
    }),
    ...Object.keys(lock.npm).sort().map((key) => {
      const { name, version } = packageKey(key)
      return { namespace: 'npm' as const, key, name, version }
    }),
    ...Object.keys(lock.remote).sort().map((key) => {
      let parsed: URL
      try {
        parsed = new URL(key)
      } catch {
        throw new Error(`invalid remote dependency URL: ${key}`)
      }
      if (parsed.protocol !== 'https:') {
        throw new Error(`remote dependency must use HTTPS: ${key}`)
      }
      return {
        namespace: 'remote' as const,
        key,
        name: key,
        version: 'NOASSERTION',
      }
    }),
  ]
}

function lockedComponents(lock: Lockfile): Array<Record<string, unknown>> {
  const inventory = lockInventory(lock)
  const components: Array<Record<string, unknown>> = []
  const add = (entry: Record<string, unknown>) =>
    components.push({
      SPDXID: `SPDXRef-Dependency-${components.length + 1}`,
      ...entry,
    })
  for (const component of inventory) {
    const { namespace, key, name, version } = component
    if (namespace === 'jsr') {
      const detail = lock.jsr![key]
      const { name, version } = packageKey(key)
      add({
        name,
        versionInfo: version,
        downloadLocation: `https://jsr.io/${name}@${version}`,
        checksums: [hexChecksum(detail.integrity, 'JSR')],
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        supplier: 'NOASSERTION',
        externalRefs: [{
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: `pkg:jsr/${name}@${version}`,
        }],
      })
    } else if (namespace === 'npm') {
      const detail = lock.npm![key]
      add({
        name,
        versionInfo: version,
        downloadLocation: npmLocation(name, version),
        checksums: [hexFromSRI(detail.integrity)],
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        supplier: 'NOASSERTION',
        externalRefs: [{
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: `pkg:npm/${name}@${version}`,
        }],
      })
    } else {
      const integrity = lock.remote![key]
      add({
        name,
        versionInfo: 'NOASSERTION',
        downloadLocation: key,
        checksums: [hexChecksum(integrity, 'remote')],
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        supplier: 'NOASSERTION',
        externalRefs: [{
          referenceCategory: 'OTHER',
          referenceType: 'other',
          referenceLocator: key,
        }],
      })
    }
  }
  if (!components.length) {
    throw new Error('deno.lock has no dependency components')
  }
  return components
}
function graphKey(namespace: ComponentNamespace, key: string): string {
  return `${namespace}:${key}`
}

function sortedUnique(
  values: unknown,
  field: string,
): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new Error(`compiled module graph has invalid ${field}`)
  }
  const sorted = [...values].sort()
  if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
    throw new Error(`compiled module graph has duplicate ${field} entry`)
  }
  return sorted
}

export function compiledModuleGraphFromDenoInfo(
  value: unknown,
): CompiledModuleGraph {
  if (!value || typeof value !== 'object') {
    throw new Error('deno info must be an object')
  }
  const info = value as DenoInfo
  if (
    !Array.isArray(info.modules) || !info.npmPackages ||
    typeof info.npmPackages !== 'object'
  ) {
    throw new Error('deno info is missing modules or npmPackages')
  }
  const jsr = new Set<string>()
  const remote = new Set<string>()
  for (const module of info.modules) {
    // Declaration files contribute type information while compiling but are
    // not executable bytes embedded in the resulting SLV binary.
    if (module.mediaType === 'Dts') continue
    if (typeof module.specifier !== 'string') continue
    if (module.specifier.startsWith('jsr:')) {
      jsr.add(module.specifier.slice('jsr:'.length))
    } else if (module.specifier.startsWith('https://')) {
      const packageKey = jsrPackageKeyFromResolvedUrl(module.specifier)
      if (packageKey) jsr.add(packageKey)
      else remote.add(module.specifier)
    }
  }
  return {
    schema_version: 1,
    npm: Object.keys(info.npmPackages).sort(),
    jsr: [...jsr].sort(),
    remote: [...remote].sort(),
  }
}

/**
 * `deno info --json` records resolved JSR modules as jsr.io URLs. Preserve the
 * JSR package identity instead of misclassifying every resolved module as an
 * unrelated remote dependency. The URL includes the resolved, lockfile-pinned
 * version, unlike an import range in a source-level `jsr:` specifier.
 */
function jsrPackageKeyFromResolvedUrl(specifier: string): string | undefined {
  const url = new URL(specifier)
  if (url.protocol !== 'https:' || url.hostname !== 'jsr.io') return undefined
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new Error(`resolved JSR module has no package version: ${specifier}`)
  }
  if (segments[0].startsWith('@')) {
    if (segments.length < 3 || !segments[1] || !segments[2]) {
      throw new Error(
        `resolved JSR module has an invalid scoped package: ${specifier}`,
      )
    }
    return `${segments[0]}/${segments[1]}@${segments[2]}`
  }
  if (!segments[0] || !segments[1]) {
    throw new Error(`resolved JSR module has an invalid package: ${specifier}`)
  }
  return `${segments[0]}@${segments[1]}`
}

export async function writeCompiledModuleGraph(
  denoInfoPath: string,
  outputPath: string,
): Promise<void> {
  const graph = compiledModuleGraphFromDenoInfo(
    JSON.parse(await Deno.readTextFile(denoInfoPath)),
  )
  await Deno.mkdir(outputPath.slice(0, outputPath.lastIndexOf('/')), {
    recursive: true,
  })
  await Deno.writeTextFile(outputPath, JSON.stringify(graph, null, 2) + '\n')
}

async function compiledModuleGraph(root: string): Promise<CompiledModuleGraph> {
  const source = JSON.parse(
    await Deno.readTextFile(
      join(root, 'dist/release-inputs/compiled-module-graph.json'),
    ),
  ) as Partial<CompiledModuleGraph>
  if (source.schema_version !== 1) {
    throw new Error('compiled module graph must have schema_version 1')
  }
  return {
    schema_version: 1,
    npm: sortedUnique(source.npm, 'npm'),
    jsr: sortedUnique(source.jsr, 'jsr'),
    remote: sortedUnique(source.remote, 'remote'),
  }
}

function graphComponents(
  lock: Lockfile,
  graph: CompiledModuleGraph,
): Component[] {
  const byKey = new Map(
    lockInventory(lock).map((component) => [
      graphKey(component.namespace, component.key),
      component,
    ]),
  )
  const result: Component[] = []
  for (
    const [namespace, keys] of [
      ['npm', graph.npm],
      ['jsr', graph.jsr],
      ['remote', graph.remote],
    ] as const
  ) {
    for (const key of keys) {
      const component = byKey.get(graphKey(namespace, key))
      if (!component) {
        throw new Error(
          `compiled module graph ${namespace} entry is absent from deno.lock: ${key}`,
        )
      }
      result.push(component)
    }
  }
  return result
}

export function sbomFromLock(
  lock: Lockfile,
  version: string,
  sourceSha: string,
  sourceTimestamp: string,
  graph?: CompiledModuleGraph,
  sourceMaterialsReceipt?: string,
): Record<string, unknown> {
  assertVersion(version)
  if (!SHA40.test(sourceSha) || Number.isNaN(Date.parse(sourceTimestamp))) {
    throw new Error('invalid SBOM source identity')
  }
  const packages = [{
    SPDXID: 'SPDXRef-SLV',
    name: 'slv',
    versionInfo: version,
    downloadLocation: `git+https://github.com/ValidatorsDAO/slv@${sourceSha}`,
    filesAnalyzed: false,
    licenseConcluded: 'Apache-2.0',
    licenseDeclared: 'Apache-2.0',
    supplier: 'NOASSERTION',
  }, {
    SPDXID: 'SPDXRef-DenoRuntime',
    name: 'Deno runtime',
    versionInfo: DENO_RUNTIME_VERSION,
    downloadLocation: DENO_RUNTIME_SOURCE,
    filesAnalyzed: false,
    // The release knows the exact compiler runtime source, but does not make a
    // legal conclusion without carrying the upstream license text as evidence.
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    supplier: 'NOASSERTION',
  }, ...lockedComponents(lock)]
  const annotations = [{
    annotationType: 'OTHER',
    annotator: 'Tool: slv-release',
    annotationDate: new Date(sourceTimestamp).toISOString(),
    comment: graph
      ? `Inventory contains every deno.lock JSR, NPM, and remote identity. The separately measured compiled module graph contains ${graph.npm.length} npm, ${graph.jsr.length} JSR, and ${graph.remote.length} remote components; lockfile entries outside that graph are recorded but are not asserted shipped. The Deno runtime ${DENO_RUNTIME_VERSION} source is ${DENO_RUNTIME_SOURCE}; license conclusions remain NOASSERTION unless independently evidenced.`
      : `Inventory contains every deno.lock JSR, NPM, and remote identity. No compiled module graph was supplied to this pure SBOM function, so it does not assert which lockfile entries were compiled. The Deno runtime ${DENO_RUNTIME_VERSION} source is ${DENO_RUNTIME_SOURCE}; license conclusions remain NOASSERTION unless independently evidenced.`,
  }]
  if (sourceMaterialsReceipt !== undefined) {
    let receipt: unknown
    try {
      receipt = JSON.parse(sourceMaterialsReceipt)
    } catch {
      throw new Error('source materials receipt annotation is not JSON')
    }
    verifySourceMaterialsReceipt(receipt, { sourceCommit: sourceSha })
    const receiptSha256 = createHash('sha256')
      .update(encoder.encode(sourceMaterialsReceipt))
      .digest('hex')
    annotations.push({
      annotationType: 'OTHER',
      annotator: 'Tool: slv-release',
      annotationDate: new Date(sourceTimestamp).toISOString(),
      // The suffix after this delimiter is the exact UTF-8 receipt read from
      // the source-materials staging file.  Do not parse/re-stringify it:
      // proof records bind this byte-level digest after CI artifacts expire.
      comment:
        `SLV source-materials receipt (verbatim UTF-8; SHA-256 ${receiptSha256}). Extract every byte after the delimiter and verify it against the three source archives.\n---BEGIN SLV SOURCE MATERIALS RECEIPT---\n${sourceMaterialsReceipt}`,
    })
  }
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `slv-${version}`,
    documentNamespace:
      `https://github.com/ValidatorsDAO/slv/releases/tag/v${version}/sbom/${sourceSha}`,
    creationInfo: {
      creators: ['Tool: slv-release'],
      created: new Date(sourceTimestamp).toISOString(),
    },
    documentDescribes: ['SPDXRef-SLV'],
    packages,
    relationships: packages.slice(1).map((pkg) => ({
      spdxElementId: 'SPDXRef-SLV',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: pkg.SPDXID,
    })),
    annotations,
  }
}
export async function lockedSbom(
  root: string,
  version: string,
  sourceSha: string,
  sourceTimestamp: string,
  sourceMaterialsReceipt?: string,
): Promise<Record<string, unknown>> {
  const lock = JSON.parse(
    await Deno.readTextFile(join(root, 'deno.lock')),
  ) as Lockfile
  const graph = await compiledModuleGraph(root)
  graphComponents(lock, graph)
  return sbomFromLock(
    lock,
    version,
    sourceSha,
    sourceTimestamp,
    graph,
    sourceMaterialsReceipt,
  )
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}
async function nodePackageDirectory(
  root: string,
  name: string,
  version: string,
): Promise<string | undefined> {
  const direct = join(root, 'node_modules', name)
  const matches = async (path: string) => {
    const source = await readOptional(join(path, 'package.json'))
    if (!source) return false
    try {
      return (JSON.parse(source) as { version?: unknown }).version === version
    } catch {
      return false
    }
  }
  if (await matches(direct)) return direct
  try {
    for await (const entry of Deno.readDir(join(root, 'node_modules/.deno'))) {
      if (!entry.isDirectory) continue
      const candidate = join(
        root,
        'node_modules/.deno',
        entry.name,
        'node_modules',
        name,
      )
      if (await matches(candidate)) return candidate
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return undefined
}
type NoticeText = { path: string; sha256: string; text: string }
type SupplementMetadata = {
  originalArchiveIntegrity: string
  originalEvidenceReceipt: string
  supplementSourceCommit: string
  sameSourceVerified: boolean
  rationale: string
  maintainerStatement?: string
}
type DerivedUnicodeData = {
  npmKey: string
  outputPath: string
  outputSha256: string
  outputBytes: number
  outputRows: number
  generatorPath: string
  generatorSha256: string
  sourceDataPath: string
  sourceDataSha256: string
  originalAttribution: string
  transformDescription: string
  historicalModificationNotice: string
  currentDistributionPermission: string
}
type NoticeRecord = {
  subject: string
  declaredLicense?: string
  evidence: NoticeText[]
  inclusionBasis: 'actual-shipped' | 'conservative-extra'
  supplement?: SupplementMetadata
  derivedUnicodeData?: DerivedUnicodeData
}
type LicenseEvidenceIndex = {
  schema_version?: unknown
  components?: Array<{
    namespace?: unknown
    key?: unknown
    files?: unknown
    declared_license?: unknown
    inclusion_basis?: unknown
    supplement?: unknown
  }>
  additional_components?: Array<{
    id?: unknown
    files?: unknown
    inclusion_basis?: unknown
    derived_unicode_data?: unknown
  }>
}
type ExternalComponentEvidence = {
  declaredLicense?: string
  evidence: NoticeText[]
  inclusionBasis: 'actual-shipped' | 'conservative-extra'
  supplement?: SupplementMetadata
}
type ExternalLicenseEvidence = {
  components: Map<string, ExternalComponentEvidence>
  additional: NoticeRecord[]
}
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const SHA40_LOWER = /^[a-f0-9]{40}$/

function evidencePath(root: string, path: string): string {
  if (
    !path || path.startsWith('/') || path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe license evidence path: ${path}`)
  }
  const prefix = 'dist/release-inputs/'
  if (!path.startsWith(prefix)) {
    throw new Error(`license evidence must be below ${prefix}: ${path}`)
  }
  return join(root, path)
}

async function nonemptyNotice(
  root: string,
  path: string,
): Promise<NoticeText | undefined> {
  const text = await readOptional(evidencePath(root, path))
  if (!text || !text.trim()) return undefined
  return { path, sha256: await hashFile(evidencePath(root, path)), text }
}

function safeRelativeMetadataPath(path: unknown): path is string {
  return typeof path === 'string' && Boolean(path) && !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
}

function parseSupplement(value: unknown): SupplementMetadata | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') {
    throw new Error('license evidence has an invalid supplement')
  }
  const source = value as Record<string, unknown>
  if (
    typeof source.original_archive_integrity !== 'string' ||
    !SHA512_INTEGRITY.test(source.original_archive_integrity) ||
    !safeRelativeMetadataPath(source.original_evidence_receipt) ||
    typeof source.supplement_source_commit !== 'string' ||
    !SHA40_LOWER.test(source.supplement_source_commit) ||
    typeof source.same_source_verified !== 'boolean' ||
    typeof source.rationale !== 'string' || !source.rationale.trim() ||
    (source.maintainer_statement !== undefined &&
      (typeof source.maintainer_statement !== 'string' ||
        !source.maintainer_statement.startsWith('https://')))
  ) throw new Error('license evidence has an invalid supplement')
  return {
    originalArchiveIntegrity: source.original_archive_integrity,
    originalEvidenceReceipt: source.original_evidence_receipt,
    supplementSourceCommit: source.supplement_source_commit,
    sameSourceVerified: source.same_source_verified,
    rationale: source.rationale,
    ...(typeof source.maintainer_statement === 'string'
      ? { maintainerStatement: source.maintainer_statement }
      : {}),
  }
}

function parseDerivedUnicodeData(value: unknown): DerivedUnicodeData {
  if (!value || typeof value !== 'object') {
    throw new Error('license evidence has invalid Unicode data provenance')
  }
  const source = value as Record<string, unknown>
  const strings = [
    'npm_key',
    'output_path',
    'output_sha256',
    'generator_path',
    'generator_sha256',
    'source_data_path',
    'source_data_sha256',
    'original_attribution',
    'transform_description',
    'historical_modification_notice',
    'current_distribution_permission',
  ]
  if (
    strings.some((key) =>
      typeof source[key] !== 'string' || !(source[key] as string).trim()
    ) ||
    !safeRelativeMetadataPath(source.output_path) ||
    !safeRelativeMetadataPath(source.generator_path) ||
    !safeRelativeMetadataPath(source.source_data_path) ||
    !SHA256.test(source.output_sha256 as string) ||
    !SHA256.test(source.generator_sha256 as string) ||
    !SHA256.test(source.source_data_sha256 as string) ||
    !Number.isSafeInteger(source.output_bytes) ||
    !Number.isSafeInteger(source.output_rows) ||
    (source.output_bytes as number) <= 0 || (source.output_rows as number) <= 0
  ) throw new Error('license evidence has invalid Unicode data provenance')
  return {
    npmKey: source.npm_key as string,
    outputPath: source.output_path as string,
    outputSha256: source.output_sha256 as string,
    outputBytes: source.output_bytes as number,
    outputRows: source.output_rows as number,
    generatorPath: source.generator_path as string,
    generatorSha256: source.generator_sha256 as string,
    sourceDataPath: source.source_data_path as string,
    sourceDataSha256: source.source_data_sha256 as string,
    originalAttribution: source.original_attribution as string,
    transformDescription: source.transform_description as string,
    historicalModificationNotice: source
      .historical_modification_notice as string,
    currentDistributionPermission: source
      .current_distribution_permission as string,
  }
}

async function externalLicenseEvidence(
  root: string,
): Promise<ExternalLicenseEvidence> {
  const source = JSON.parse(
    await Deno.readTextFile(
      join(root, 'dist/release-inputs/license-evidence.json'),
    ),
  ) as LicenseEvidenceIndex
  if (source.schema_version !== 1 || !Array.isArray(source.components)) {
    throw new Error('license evidence index must have schema_version 1')
  }
  const result = new Map<string, ExternalComponentEvidence>()
  for (const item of source.components) {
    if (
      (item.namespace !== 'jsr' && item.namespace !== 'remote' &&
        item.namespace !== 'npm') ||
      typeof item.key !== 'string' || !Array.isArray(item.files) ||
      item.files.some((file) => typeof file !== 'string') ||
      (item.declared_license !== undefined &&
        (typeof item.declared_license !== 'string' ||
          !item.declared_license.trim())) ||
      (item.inclusion_basis !== undefined &&
        item.inclusion_basis !== 'actual-shipped' &&
        item.inclusion_basis !== 'conservative-extra')
    ) {
      throw new Error('license evidence index has an invalid component')
    }
    const id = graphKey(item.namespace, item.key)
    if (result.has(id)) throw new Error(`duplicate license evidence: ${id}`)
    const files = [...item.files].sort()
    if (files.some((file, index) => index > 0 && file === files[index - 1])) {
      throw new Error(`duplicate license evidence file: ${id}`)
    }
    const evidence = (await Promise.all(files.map((file) =>
      nonemptyNotice(root, file)
    ))).filter((file): file is NoticeText => Boolean(file))
    result.set(id, {
      declaredLicense: typeof item.declared_license === 'string'
        ? item.declared_license.trim()
        : undefined,
      evidence,
      inclusionBasis: item.inclusion_basis === 'conservative-extra'
        ? 'conservative-extra'
        : 'actual-shipped',
      ...(parseSupplement(item.supplement)
        ? { supplement: parseSupplement(item.supplement) }
        : {}),
    })
  }
  const additional: NoticeRecord[] = []
  const additionalSource = source.additional_components ?? []
  if (!Array.isArray(additionalSource)) {
    throw new Error('license evidence index has invalid additional components')
  }
  const additionalIds = new Set<string>()
  for (const item of additionalSource) {
    if (
      !item || typeof item.id !== 'string' || !item.id ||
      result.has(item.id) || additionalIds.has(item.id) ||
      !Array.isArray(item.files) || !item.files.length ||
      item.files.some((file) => typeof file !== 'string') ||
      item.inclusion_basis !== 'actual-shipped'
    ) {
      throw new Error(
        'license evidence index has an invalid additional component',
      )
    }
    const files = [...item.files].sort()
    if (files.some((file, index) => index > 0 && file === files[index - 1])) {
      throw new Error(`duplicate additional license evidence file: ${item.id}`)
    }
    const evidence = (await Promise.all(files.map((file) =>
      nonemptyNotice(root, file)
    ))).filter((file): file is NoticeText => Boolean(file))
    additional.push({
      subject: item.id,
      evidence,
      inclusionBasis: 'actual-shipped',
      derivedUnicodeData: parseDerivedUnicodeData(item.derived_unicode_data),
    })
    additionalIds.add(item.id)
  }
  return { components: result, additional }
}

async function materializedNotices(
  root: string,
  components: Component[],
  external: Map<string, ExternalComponentEvidence>,
): Promise<NoticeRecord[]> {
  const records: NoticeRecord[] = []
  for (const component of components) {
    const id = graphKey(component.namespace, component.key)
    const supplied = external.get(id)
    if (supplied) {
      records.push({
        subject: id,
        declaredLicense: supplied.declaredLicense,
        evidence: supplied.evidence,
        inclusionBasis: supplied.inclusionBasis,
        ...(supplied.supplement ? { supplement: supplied.supplement } : {}),
      })
      continue
    }
    if (component.namespace !== 'npm') {
      records.push({
        subject: id,
        evidence: [],
        inclusionBasis: 'actual-shipped',
      })
      continue
    }
    const directory = await nodePackageDirectory(
      root,
      component.name,
      component.version,
    )
    let declaredLicense: string | undefined
    const evidence: NoticeText[] = []
    if (directory) {
      const packageJson = await readOptional(join(directory, 'package.json'))
      if (packageJson) {
        try {
          const value =
            (JSON.parse(packageJson) as { license?: unknown }).license
          if (typeof value === 'string' && value.trim()) {
            declaredLicense = value.trim()
          }
        } catch { /* declaration is optional; actual text remains required */ }
      }
      const files: string[] = []
      for await (const file of Deno.readDir(directory)) {
        if (file.isFile && NOTICE_FILE.test(file.name)) files.push(file.name)
      }
      for (const name of files.sort()) {
        const path = join(directory, name)
        const text = await readOptional(path)
        if (text?.trim()) {
          evidence.push({
            path: path.slice(`${root}/`.length),
            sha256: await hashFile(path),
            text,
          })
        }
      }
    }
    records.push({
      subject: id,
      declaredLicense,
      evidence,
      inclusionBasis: 'actual-shipped',
    })
  }
  return records
}

export type LegalEvidence = { notices: string; unresolved: string[] }
export async function collectLegalEvidence(
  root: string,
): Promise<LegalEvidence> {
  const lock = JSON.parse(
    await Deno.readTextFile(join(root, 'deno.lock')),
  ) as Lockfile
  const graph = await compiledModuleGraph(root)
  const compiled = graphComponents(lock, graph)
  const all = lockInventory(lock)
  const outsideGraph = all.filter((component) =>
    !compiled.some((used) =>
      graphKey(used.namespace, used.key) ===
        graphKey(component.namespace, component.key)
    )
  )
  const ownLicense = await Deno.readTextFile(join(root, 'LICENSE.txt'))
  const external = await externalLicenseEvidence(root)
  const records = [
    ...await materializedNotices(root, compiled, external.components),
    ...external.additional,
  ]
  const unresolved = records.filter((record) =>
    record.inclusionBasis === 'actual-shipped' && record.evidence.length === 0
  ).map((record) => record.subject)
    .sort()
  const lines = [
    'SLV THIRD-PARTY NOTICES',
    '',
    'SLV is licensed under Apache-2.0:',
    ownLicense.trimEnd(),
    '',
    'Compiled module graph (measured from deno info):',
    ...compiled.map((component) =>
      `- ${graphKey(component.namespace, component.key)}`
    ),
    '',
    'Lockfile components outside the compiled graph (recorded in the SBOM; not asserted shipped):',
    ...(outsideGraph.length
      ? outsideGraph.map((component) =>
        `- ${graphKey(component.namespace, component.key)}`
      )
      : ['- none']),
    '',
  ]
  const bodyByHash = new Map<string, string>()
  const addEvidence = (subject: string, evidence: NoticeText) => {
    lines.push(
      '',
      `Component: ${subject}`,
      `Evidence path: ${evidence.path}`,
      `SHA-256: ${evidence.sha256}`,
    )
    const original = bodyByHash.get(evidence.sha256)
    if (original) {
      lines.push(`License text: identical to ${original}; not repeated.`)
    } else {
      bodyByHash.set(evidence.sha256, `${subject} (${evidence.path})`)
      lines.push('', evidence.text.trimEnd())
    }
  }
  for (const record of records) {
    const subject = record.subject
    lines.push(
      '',
      `Component: ${subject}`,
      `Inclusion basis: ${record.inclusionBasis}`,
    )
    if (record.declaredLicense) {
      lines.push(
        `Declared license expression (not license text): ${record.declaredLicense}`,
      )
    }
    if (record.supplement) {
      const supplement = record.supplement
      lines.push(
        'Supplemental legal-text provenance:',
        `Original archive integrity: ${supplement.originalArchiveIntegrity}`,
        `Original omission receipt: scripts/release/application-notices/${supplement.originalEvidenceReceipt}`,
        `Supplement source commit: ${supplement.supplementSourceCommit}`,
        `Same source verified: ${supplement.sameSourceVerified}`,
        `Rationale: ${supplement.rationale}`,
      )
      if (supplement.maintainerStatement) {
        lines.push(`Maintainer statement: ${supplement.maintainerStatement}`)
      }
    }
    if (record.derivedUnicodeData) {
      const derived = record.derivedUnicodeData
      lines.push(
        'Derived Unicode data provenance:',
        `Published package: ${derived.npmKey}`,
        `Published output: ${derived.outputPath}`,
        `Published output SHA-256: ${derived.outputSha256}`,
        `Published output bytes: ${derived.outputBytes}`,
        `Published output rows: ${derived.outputRows}`,
        `Generator evidence: scripts/release/application-notices/${derived.generatorPath}`,
        `Generator SHA-256: ${derived.generatorSha256}`,
        `Source data evidence: scripts/release/application-notices/${derived.sourceDataPath}`,
        `Source data SHA-256: ${derived.sourceDataSha256}`,
        `Original attribution: ${derived.originalAttribution}`,
        `Transformation: ${derived.transformDescription}`,
        `Historical modification notice: ${derived.historicalModificationNotice}`,
        `Current distribution permission: ${derived.currentDistributionPermission}`,
      )
    }
    for (const evidence of record.evidence) addEvidence(subject, evidence)
  }
  if (unresolved.length) {
    lines.push(
      '',
      'Unresolved required shipped-license evidence:',
      ...unresolved.map((entry) => `- ${entry}`),
    )
  }
  lines.push('')
  return { notices: lines.join('\n'), unresolved }
}

export async function thirdPartyNotices(root: string): Promise<string> {
  const [application, runtime] = await Promise.all([
    collectLegalEvidence(root),
    buildRuntimeNotices(join(root, 'scripts/release/runtime-notices')),
  ])
  const unresolved = [
    ...application.unresolved,
    ...runtime.unresolvedRequired.map((gap) => `runtime:${gap}`),
  ].sort()
  if (unresolved.length) {
    throw new Error(
      `unresolved required shipped-license evidence: ${unresolved.join(', ')}`,
    )
  }
  return `${application.notices.trimEnd()}\n\n${runtime.text.trimEnd()}\n`
}

type LicenseBundle = {
  schema_version: 1
  source_sha: string
  producer_run_id: string
  producer_run_attempt: number
  filename: 'THIRD_PARTY_NOTICES'
  size: number
  sha256: string
}

const canonicalNoticePath = (root: string) =>
  join(root, 'dist/release-inputs/THIRD_PARTY_NOTICES')
const canonicalNoticeBindingPath = (root: string) =>
  join(root, 'dist/release-inputs/license-bundle.json')

function sourceVersion(source: string): string {
  const match = /export const VERSION = '([^']+)'/.exec(source)
  if (!match) {
    throw new Error('cmn/constants/version.ts does not export VERSION')
  }
  assertVersion(match[1])
  return match[1]
}

/** Read the product version from the reviewed checkout, without a release tag. */
export async function reviewedSourceVersion(
  root = Deno.cwd(),
): Promise<string> {
  const version = sourceVersion(
    await Deno.readTextFile(join(root, 'cmn/constants/version.ts')),
  )
  const cli = JSON.parse(await Deno.readTextFile(join(root, 'cli/deno.json')))
  if (cli.version !== version) {
    throw new Error(
      'cli/deno.json version differs from cmn/constants/version.ts',
    )
  }
  return version
}

function parseLicenseBundle(value: unknown): LicenseBundle {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid canonical license bundle')
  }
  const bundle = value as Partial<LicenseBundle>
  if (
    bundle.schema_version !== 1 || !SHA40.test(bundle.source_sha ?? '') ||
    !DECIMAL.test(bundle.producer_run_id ?? '') ||
    !Number.isSafeInteger(bundle.producer_run_attempt) ||
    bundle.producer_run_attempt! <= 0 ||
    bundle.filename !== 'THIRD_PARTY_NOTICES' ||
    typeof bundle.size !== 'number' || !Number.isSafeInteger(bundle.size) ||
    bundle.size <= 0 ||
    !SHA256.test(bundle.sha256 ?? '')
  ) throw new Error('invalid canonical license bundle')
  return bundle as LicenseBundle
}

async function canonicalLicenseBundle(
  root: string,
  sourceSha: string,
): Promise<{ bytes: Uint8Array; bundle: LicenseBundle }> {
  const bundle = parseLicenseBundle(JSON.parse(
    await Deno.readTextFile(
      canonicalNoticeBindingPath(root),
    ),
  ))
  if (bundle.source_sha !== sourceSha) {
    throw new Error(
      'canonical license bundle source SHA differs from package source',
    )
  }
  const path = canonicalNoticePath(root)
  const info = await Deno.stat(path)
  if (!info.isFile || info.size !== bundle.size || info.size <= 0) {
    throw new Error('canonical license bundle size differs from its binding')
  }
  if (await hashFile(path) !== bundle.sha256) {
    throw new Error('canonical license bundle digest differs from its binding')
  }
  return { bytes: await Deno.readFile(path), bundle }
}

/**
 * Source material is verified at its staging boundary, then copied as opaque
 * bytes.  Source archives intentionally do not use the executable tar parser:
 * their own receipt validates source inventory and may legitimately contain
 * symlinks, large expansion, and more than the binary archive member limit.
 */
async function copyVerifiedSourceMaterials(
  root: string,
  releaseDirectory: string,
  sourceSha: string,
  bundle: LicenseBundle,
): Promise<{ receipt: SourceMaterialsReceipt; rawReceipt: string }> {
  const { receipt, rawReceipt } = await readVerifiedSourceMaterials(
    root,
    sourceSha,
    bundle,
  )
  const sourceDirectory = join(root, SOURCE_MATERIALS_DIRECTORY)
  const assets = new Map(receipt.assets.map((asset) => [asset.name, asset]))
  for (const name of SOURCE_ASSETS) {
    const asset = assets.get(name)
    if (!asset) throw new Error(`source receipt is missing ${name}`)
    const source = join(sourceDirectory, name)
    const destination = join(releaseDirectory, name)
    await Deno.copyFile(source, destination)
    const info = await Deno.stat(destination)
    if (
      !info.isFile || info.size !== asset.size ||
      await hashFile(destination) !== asset.sha256
    ) throw new Error(`copied source archive differs from receipt: ${name}`)
  }
  return { receipt, rawReceipt }
}

async function readVerifiedSourceMaterials(
  root: string,
  sourceSha: string,
  bundle: LicenseBundle,
): Promise<{ receipt: SourceMaterialsReceipt; rawReceipt: string }> {
  const receiptPath = join(root, SOURCE_MATERIALS_RECEIPT)
  let rawReceipt: string
  let receiptValue: unknown
  try {
    rawReceipt = await Deno.readTextFile(receiptPath)
    receiptValue = JSON.parse(rawReceipt)
  } catch (error) {
    throw new Error(
      `missing or invalid source materials receipt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const sourceDirectory = join(root, SOURCE_MATERIALS_DIRECTORY)
  const receipt = await verifyReceiptFiles(receiptValue, sourceDirectory, {
    sourceCommit: sourceSha,
    canonicalNoticeSha256: bundle.sha256,
  })
  if (
    receipt.canonical_notice.path !== CANONICAL_NOTICE_NAME ||
    receipt.canonical_notice.size !== bundle.size
  ) {
    throw new Error(
      'source receipt canonical notice identity differs from release canonical notice',
    )
  }
  const pinsPath = join(root, SOURCE_MATERIALS_PINS)
  if (await hashFile(pinsPath) !== receipt.pins.sha256) {
    throw new Error('source receipt pins differ from reviewed source pins')
  }
  const pins = await readPins(pinsPath)
  for (const name of ['deno', 'rusty_v8', 'v8'] as const) {
    const expected = pins[name]
    const actual = receipt.pins[name]
    if (
      actual.commit !== expected.commit ||
      actual.archive !== expected.archive ||
      actual.sha256 !== expected.sha256 || actual.version !== expected.version
    ) {
      throw new Error(
        `source receipt ${name} pin differs from reviewed source pins`,
      )
    }
  }
  return { receipt, rawReceipt }
}

type ProductRuntimeReceipt = {
  target: (typeof TARGETS)[number]
  executableSha256: string
  executableTarSha256: string
  baselineDenortSha256: string
  sourceSelectedCargoLockSha256: string
  derivedRelinkCargoLockSha256: string
  sourceReceiptSha256: string
  nativeProofSha256: string
  buildReceiptSha256: string
}

function productRuntimeDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error('invalid product runtime ' + label)
  }
  return value
}

function parseProductRuntimeReceipt(value: unknown): ProductRuntimeReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid product runtime receipt')
  }
  const receipt = value as Record<string, unknown>
  const expected = [
    'schema_version',
    'kind',
    'target',
    'executable_sha256',
    'executable_tar_sha256',
    'baseline_denort_sha256',
    'source_selected_cargo_lock_sha256',
    'derived_relink_cargo_lock_sha256',
    'source_receipt_sha256',
    'native_proof_sha256',
    'build_receipt_sha256',
  ].sort()
  const actual = Object.keys(receipt).sort()
  if (
    receipt.schema_version !== 1 ||
    receipt.kind !== 'slv-product-runtime-receipt' ||
    typeof receipt.target !== 'string' ||
    !(TARGETS as readonly string[]).includes(receipt.target) ||
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) throw new Error('invalid product runtime receipt')
  return {
    target: receipt.target as ProductRuntimeReceipt['target'],
    executableSha256: productRuntimeDigest(
      receipt.executable_sha256,
      'executable SHA-256',
    ),
    executableTarSha256: productRuntimeDigest(
      receipt.executable_tar_sha256,
      'executable tar SHA-256',
    ),
    baselineDenortSha256: productRuntimeDigest(
      receipt.baseline_denort_sha256,
      'baseline denort SHA-256',
    ),
    sourceSelectedCargoLockSha256: productRuntimeDigest(
      receipt.source_selected_cargo_lock_sha256,
      'selected Cargo.lock SHA-256',
    ),
    derivedRelinkCargoLockSha256: productRuntimeDigest(
      receipt.derived_relink_cargo_lock_sha256,
      'derived relink Cargo.lock SHA-256',
    ),
    sourceReceiptSha256: productRuntimeDigest(
      receipt.source_receipt_sha256,
      'source receipt SHA-256',
    ),
    nativeProofSha256: productRuntimeDigest(
      receipt.native_proof_sha256,
      'native proof SHA-256',
    ),
    buildReceiptSha256: productRuntimeDigest(
      receipt.build_receipt_sha256,
      'build receipt SHA-256',
    ),
  }
}

export async function executableDigestFromArchive(
  path: string,
  executableName: string,
): Promise<string> {
  return createHash('sha256').update(
    await executableBytesFromArchive(path, executableName),
  ).digest('hex')
}

export async function executableBytesFromArchive(
  path: string,
  executableName: string,
): Promise<Uint8Array> {
  await assertArchive(path, executableName, { singleFile: true })
  const bytes = await gunzip(await Deno.readFile(path))
  const size = tarOctal(bytes, 124, 12, 'size')
  if (512 + size > bytes.length) {
    throw new Error('compiled executable archive is truncated')
  }
  return bytes.subarray(512, 512 + size)
}

function sourceProofBaseline(value: unknown): {
  denort: string
  derivedRelinkLock: string
  selectedLock: string
  bridge: string
  canonicalNotice: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid native target proof')
  }
  const proof = value as Record<string, unknown>
  const artifacts = proof.artifacts
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('native target proof has no artifacts')
  }
  const baseline = (artifacts as Record<string, unknown>).baseline
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('native target proof has no baseline artifacts')
  }
  const record = baseline as Record<string, unknown>
  const checks = proof.checks
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    throw new Error('native target proof has no checks')
  }
  const licenses = (checks as Record<string, unknown>).licenses
  if (!licenses || typeof licenses !== 'object' || Array.isArray(licenses)) {
    throw new Error('native target proof has no embedded licenses check')
  }
  const licenseRecord = licenses as Record<string, unknown>
  if (licenseRecord.passed !== true) {
    throw new Error('native target proof embedded licenses check did not pass')
  }
  return {
    denort: productRuntimeDigest(
      record.denort_sha256,
      'proof baseline denort SHA-256',
    ),
    derivedRelinkLock: productRuntimeDigest(
      record.derived_relink_cargo_lock_sha256,
      'proof derived relink Cargo.lock SHA-256',
    ),
    selectedLock: productRuntimeDigest(
      proof.source_selected_cargo_lock_sha256,
      'proof selected Cargo.lock SHA-256',
    ),
    bridge: productRuntimeDigest(
      record.bridge_standalone_sha256,
      'proof baseline release bridge SHA-256',
    ),
    canonicalNotice: productRuntimeDigest(
      licenseRecord.canonical_notice_sha256,
      'proof canonical notice SHA-256',
    ),
  }
}

const LINUX_TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
] as const

const LINUX_SYSROOTS: Record<(typeof LINUX_TARGETS)[number], {
  archive: string
  environment: string
  arch: string
}> = {
  'x86_64-unknown-linux-gnu': {
    archive: '64513b04d8a38da6f47c0a9c4cb47b2ce7bcb735250b10eb10751aec6afe46ee',
    environment:
      '8dd1d28a69afcd7790a4f9871c02992553ad348b3855aab4e465a263e298c81a',
    arch: 'x86_64-linux-gnu',
  },
  'aarch64-unknown-linux-gnu': {
    archive: '0a29c63c52cc1e59228686602cf3cf41080a809655afc29d1b8a27af4b20cedb',
    environment:
      '11c9a31f2303e448eb68ff5de9f0359ff202a2f25e5f4fa9001d8c332ea2d80e',
    arch: 'aarch64-linux-gnu',
  },
}

type CompatibilityCommand = {
  command: string[]
  cwd: string
  startedAt: string
  finishedAt: string
  exitCode: number
  log: string
  logSha256: string
}

type CompatibilityElfCheck = {
  versions: string[]
  needed: string[]
  version: CompatibilityCommand
  dynamic: CompatibilityCommand
  loaderList: CompatibilityCommand
}

type LinuxCompatibilityReceipt = {
  target: (typeof LINUX_TARGETS)[number]
  nativeProofSha256: string
  buildReceiptSha256: string
  runtime: { denort: string; derivedLock: string }
  product: { executable: string; bridge: string }
  toolchain: {
    sysrootArchive: string
    sysrootEnvironment: string
    loader: string
    libraryPath: string
    frontend: string
  }
  checks: {
    elf: Record<string, CompatibilityElfCheck>
    startup: CompatibilityCommand
    licenses: CompatibilityCommand & { canonicalNotice: string }
    bridge: CompatibilityCommand
    smoke: {
      compile: CompatibilityCommand
      execute: CompatibilityCommand
      executable: string
    }
  }
}

function compatibilityRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid Linux compatibility ${label}`)
  }
  return value as Record<string, unknown>
}

function exactCompatibilityKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) throw new Error(`invalid Linux compatibility ${label} fields`)
}

function compatibilityText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`invalid Linux compatibility ${label}`)
  }
  return value
}

function parseCompatibilityCommand(
  value: unknown,
  label: string,
): CompatibilityCommand {
  const command = compatibilityRecord(value, label)
  exactCompatibilityKeys(command, [
    'command',
    'cwd',
    'started_at',
    'finished_at',
    'exit_code',
    'log',
    'log_sha256',
  ], label)
  if (
    !Array.isArray(command.command) || !command.command.length ||
    !command.command.every((part) => typeof part === 'string' && part) ||
    command.exit_code !== 0
  ) throw new Error(`Linux compatibility ${label} did not pass`)
  const startedAt = compatibilityText(command.started_at, `${label} start`)
  const finishedAt = compatibilityText(command.finished_at, `${label} finish`)
  const started = Date.parse(startedAt)
  const finished = Date.parse(finishedAt)
  if (
    !Number.isFinite(started) || !Number.isFinite(finished) ||
    finished < started
  ) {
    throw new Error(`invalid Linux compatibility ${label} time range`)
  }
  return {
    command: [...command.command] as string[],
    cwd: compatibilityText(command.cwd, `${label} cwd`),
    startedAt,
    finishedAt,
    exitCode: 0,
    log: compatibilityText(command.log, `${label} log`),
    logSha256: productRuntimeDigest(command.log_sha256, `${label} log SHA-256`),
  }
}

function parseCompatibilityElf(
  value: unknown,
  label: string,
): CompatibilityElfCheck {
  const check = compatibilityRecord(value, label)
  exactCompatibilityKeys(check, [
    'versions',
    'needed',
    'version',
    'dynamic',
    'loader_list',
  ], label)
  const parseStrings = (input: unknown, field: string) => {
    if (
      !Array.isArray(input) || !input.length ||
      !input.every((item) => typeof item === 'string' && item)
    ) throw new Error(`invalid Linux compatibility ${label} ${field}`)
    return [...input] as string[]
  }
  return {
    versions: parseStrings(check.versions, 'GLIBC versions'),
    needed: parseStrings(check.needed, 'dynamic dependencies'),
    version: parseCompatibilityCommand(check.version, `${label} version`),
    dynamic: parseCompatibilityCommand(check.dynamic, `${label} dynamic`),
    loaderList: parseCompatibilityCommand(check.loader_list, `${label} loader`),
  }
}

function parseLinuxCompatibilityReceipt(
  value: unknown,
): LinuxCompatibilityReceipt {
  const receipt = compatibilityRecord(value, 'receipt')
  exactCompatibilityKeys(receipt, [
    'schema_version',
    'kind',
    'target',
    'native_proof_sha256',
    'build_receipt_sha256',
    'runtime',
    'product',
    'toolchain',
    'checks',
    'status',
  ], 'receipt')
  if (
    receipt.schema_version !== 1 ||
    receipt.kind !== 'slv-linux-product-compatibility' ||
    receipt.status !== 'passed' ||
    typeof receipt.target !== 'string' ||
    !(LINUX_TARGETS as readonly string[]).includes(receipt.target)
  ) throw new Error('invalid Linux compatibility receipt identity')
  const runtime = compatibilityRecord(receipt.runtime, 'runtime')
  exactCompatibilityKeys(runtime, [
    'baseline_denort_sha256',
    'derived_relink_cargo_lock_sha256',
    'path',
  ], 'runtime')
  const product = compatibilityRecord(receipt.product, 'product')
  exactCompatibilityKeys(
    product,
    ['executable_sha256', 'bridge_sha256'],
    'product',
  )
  const toolchain = compatibilityRecord(receipt.toolchain, 'toolchain')
  exactCompatibilityKeys(toolchain, [
    'deno_sysroot_archive_sha256',
    'deno_sysroot_env_sha256',
    'loader',
    'library_path',
    'frontend_sha256',
  ], 'toolchain')
  const checks = compatibilityRecord(receipt.checks, 'checks')
  exactCompatibilityKeys(checks, [
    'elf_glibc_ceiling_and_no_private_or_rpath',
    'older_loader_startup',
    'older_loader_licenses',
    'older_loader_bridge',
    'source_built_runtime_crypto_subprocess_loopback_tls',
  ], 'checks')
  const elf = compatibilityRecord(
    checks.elf_glibc_ceiling_and_no_private_or_rpath,
    'ELF checks',
  )
  exactCompatibilityKeys(
    elf,
    ['runtime', 'executable', 'bridge', 'smoke'],
    'ELF checks',
  )
  const licenses = compatibilityRecord(
    checks.older_loader_licenses,
    'licenses check',
  )
  exactCompatibilityKeys(licenses, [
    'command',
    'cwd',
    'started_at',
    'finished_at',
    'exit_code',
    'log',
    'log_sha256',
    'canonical_notice_sha256',
  ], 'licenses check')
  const { canonical_notice_sha256: licenseNotice, ...licenseCommand } = licenses
  const parsedLicenses = parseCompatibilityCommand(
    licenseCommand,
    'licenses check',
  )
  const smoke = compatibilityRecord(
    checks.source_built_runtime_crypto_subprocess_loopback_tls,
    'runtime smoke',
  )
  exactCompatibilityKeys(
    smoke,
    ['compile', 'execute', 'executable_sha256'],
    'runtime smoke',
  )
  return {
    target: receipt.target as LinuxCompatibilityReceipt['target'],
    nativeProofSha256: productRuntimeDigest(
      receipt.native_proof_sha256,
      'native proof SHA-256',
    ),
    buildReceiptSha256: productRuntimeDigest(
      receipt.build_receipt_sha256,
      'build receipt SHA-256',
    ),
    runtime: {
      denort: productRuntimeDigest(
        runtime.baseline_denort_sha256,
        'baseline denort SHA-256',
      ),
      derivedLock: productRuntimeDigest(
        runtime.derived_relink_cargo_lock_sha256,
        'derived relink Cargo.lock SHA-256',
      ),
    },
    product: {
      executable: productRuntimeDigest(
        product.executable_sha256,
        'product executable SHA-256',
      ),
      bridge: productRuntimeDigest(
        product.bridge_sha256,
        'product bridge SHA-256',
      ),
    },
    toolchain: {
      sysrootArchive: productRuntimeDigest(
        toolchain.deno_sysroot_archive_sha256,
        'Deno sysroot archive SHA-256',
      ),
      sysrootEnvironment: productRuntimeDigest(
        toolchain.deno_sysroot_env_sha256,
        'Deno sysroot environment SHA-256',
      ),
      loader: compatibilityText(toolchain.loader, 'sysroot loader'),
      libraryPath: compatibilityText(
        toolchain.library_path,
        'sysroot library path',
      ),
      frontend: productRuntimeDigest(
        toolchain.frontend_sha256,
        'Deno frontend SHA-256',
      ),
    },
    checks: {
      elf: {
        runtime: parseCompatibilityElf(elf.runtime, 'runtime ELF'),
        executable: parseCompatibilityElf(elf.executable, 'executable ELF'),
        bridge: parseCompatibilityElf(elf.bridge, 'bridge ELF'),
        smoke: parseCompatibilityElf(elf.smoke, 'smoke ELF'),
      },
      startup: parseCompatibilityCommand(
        checks.older_loader_startup,
        'older loader startup',
      ),
      licenses: {
        ...parsedLicenses,
        canonicalNotice: productRuntimeDigest(
          licenseNotice,
          'older loader licenses canonical notice SHA-256',
        ),
      },
      bridge: parseCompatibilityCommand(
        checks.older_loader_bridge,
        'older loader bridge',
      ),
      smoke: {
        compile: parseCompatibilityCommand(
          smoke.compile,
          'runtime smoke compile',
        ),
        execute: parseCompatibilityCommand(
          smoke.execute,
          'runtime smoke execute',
        ),
        executable: productRuntimeDigest(
          smoke.executable_sha256,
          'runtime smoke executable SHA-256',
        ),
      },
    },
  }
}

function safeCompatibilityLogName(path: string): boolean {
  // The compatibility helper runs in a private temporary directory, but the
  // resulting receipt crosses runners with the product artifact.  Its command
  // records therefore use paths relative to --out: a literal working
  // directory of "." and a single log-file name.  Do not let a receipt select
  // another downloaded artifact by carrying a directory component here.
  return !!path && !path.startsWith('/') && !path.includes('\\') &&
    !path.includes('/') && path !== '.' && path !== '..'
}

async function verifyCompatibilityCommand(
  root: string,
  prefix: string,
  command: CompatibilityCommand,
  label: string,
  logs: Set<string>,
): Promise<string> {
  if (command.cwd !== '.' || !safeCompatibilityLogName(command.log)) {
    throw new Error(
      `Linux compatibility ${label} is not relative to its evidence directory`,
    )
  }
  if (logs.has(command.log)) {
    throw new Error(`Linux compatibility ${label} reuses an execution log`)
  }
  logs.add(command.log)
  const path = join(root, prefix, command.log)
  const info = await Deno.lstat(path).catch(() => undefined)
  if (!info?.isFile || info.isSymlink) {
    throw new Error(
      `Linux compatibility ${label} log is not a regular artifact`,
    )
  }
  if (info.size <= 0) {
    throw new Error(`Linux compatibility ${label} log is empty`)
  }
  if (await hashFile(path) !== command.logSha256) {
    throw new Error(`Linux compatibility ${label} log checksum differs`)
  }
  return await Deno.readTextFile(path)
}

function checkedGlibcVersions(
  log: string,
  recorded: string,
  label: string,
): void {
  if (log.includes('GLIBC_PRIVATE')) {
    throw new Error(`Linux compatibility ${label} ELF uses GLIBC_PRIVATE`)
  }
  const versions = new Set<string>()
  for (const match of log.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const major = Number(match[1])
    const minor = Number(match[2])
    if (major > 2 || (major === 2 && minor > 27)) {
      throw new Error(`Linux compatibility ${label} requires GLIBC above 2.27`)
    }
    versions.add(`${major}.${minor}`)
  }
  const normalized = [...versions].sort((left, right) => {
    const [leftMajor, leftMinor] = left.split('.').map(Number)
    const [rightMajor, rightMinor] = right.split('.').map(Number)
    return leftMajor - rightMajor || leftMinor - rightMinor
  })
  if (
    normalized.join(',') !== recorded.split(',').sort((left, right) => {
      const [leftMajor, leftMinor] = left.split('.').map(Number)
      const [rightMajor, rightMinor] = right.split('.').map(Number)
      return leftMajor - rightMajor || leftMinor - rightMinor
    }).join(',')
  ) {
    throw new Error(
      `Linux compatibility ${label} GLIBC receipt differs from ELF output`,
    )
  }
}

function checkedDynamicDependencies(
  log: string,
  recorded: string[],
  label: string,
): void {
  if (/\((?:RPATH|RUNPATH)\)/.test(log)) {
    throw new Error(`Linux compatibility ${label} ELF uses RPATH/RUNPATH`)
  }
  const needed = [...log.matchAll(/Shared library: \[([^\]]+)\]/g)].map((
    match,
  ) => match[1])
  if (needed.join('\n') !== recorded.join('\n')) {
    throw new Error(
      `Linux compatibility ${label} dynamic dependency receipt differs`,
    )
  }
}

function checkedLoaderPaths(log: string, sysroot: string, label: string): void {
  if (/\bnot found\b/.test(log)) {
    throw new Error(
      `Linux compatibility ${label} loader has an unresolved library`,
    )
  }
  for (const line of log.split('\n')) {
    const match = /=>\s+(\/[^\s(]+)|^\s*(\/[^\s(]+)\s+\(/.exec(line)
    const path = match?.[1] ?? match?.[2]
    if (path && !path.startsWith(`${sysroot}/`)) {
      throw new Error(
        `Linux compatibility ${label} loader escaped the pinned sysroot`,
      )
    }
  }
}

function requireReadelfCommand(
  command: CompatibilityCommand,
  flag: '--version-info' | '-d',
  label: string,
): void {
  if (
    command.command.length !== 3 || command.command[0] !== '/usr/bin/readelf' ||
    command.command[1] !== flag
  ) {
    throw new Error(
      `Linux compatibility ${label} has an unexpected readelf command`,
    )
  }
}

function requireLoaderCommand(
  command: CompatibilityCommand,
  compatibility: LinuxCompatibilityReceipt,
  argumentCount: number,
  label: string,
): void {
  if (
    command.command.length !== argumentCount ||
    command.command[0] !== compatibility.toolchain.loader ||
    command.command[1] !== '--library-path' ||
    command.command[2] !== compatibility.toolchain.libraryPath
  ) {
    throw new Error(
      `Linux compatibility ${label} has an unexpected loader command`,
    )
  }
}

function verifyCompatibilityCommands(
  compatibility: LinuxCompatibilityReceipt,
): void {
  for (const [label, elf] of Object.entries(compatibility.checks.elf)) {
    requireReadelfCommand(elf.version, '--version-info', `${label} ELF version`)
    requireReadelfCommand(elf.dynamic, '-d', `${label} ELF dynamic`)
    requireLoaderCommand(
      elf.loaderList,
      compatibility,
      5,
      `${label} ELF loader`,
    )
    if (elf.loaderList.command[3] !== '--list') {
      throw new Error(`Linux compatibility ${label} ELF loader omits --list`)
    }
  }
  requireLoaderCommand(
    compatibility.checks.startup,
    compatibility,
    5,
    'older loader startup',
  )
  if (compatibility.checks.startup.command[4] !== '--version') {
    throw new Error('Linux compatibility older loader startup omits --version')
  }
  requireLoaderCommand(
    compatibility.checks.licenses,
    compatibility,
    5,
    'older loader licenses',
  )
  if (compatibility.checks.licenses.command[4] !== 'licenses') {
    throw new Error('Linux compatibility older loader licenses omits licenses')
  }
  requireLoaderCommand(
    compatibility.checks.bridge,
    compatibility,
    4,
    'older loader bridge',
  )
  const compile = compatibility.checks.smoke.compile.command
  if (
    compile.length !== 10 || compile[1] !== 'compile' ||
    compile[2] !== '--cached-only' || compile[3] !== '--no-prompt' ||
    compile[4] !== '-A' || compile[5] !== '--target' ||
    compile[6] !== compatibility.target || compile[7] !== '--output'
  ) {
    throw new Error(
      'Linux compatibility runtime smoke has an unexpected compile command',
    )
  }
  requireLoaderCommand(
    compatibility.checks.smoke.execute,
    compatibility,
    7,
    'runtime smoke execute',
  )
}

export async function verifyLinuxCompatibilityReceipt(
  root: string,
  targetDirectory: string,
  target: (typeof LINUX_TARGETS)[number],
  product: ProductRuntimeReceipt,
  proof: ReturnType<typeof sourceProofBaseline>,
): Promise<void> {
  const prefix = join(
    'dist/release-inputs/product-runtime',
    target,
    'linux-compatibility',
  )
  const compatibilityPath = join(
    targetDirectory,
    'linux-compatibility-receipt.json',
  )
  const compatibility = parseLinuxCompatibilityReceipt(JSON.parse(
    await Deno.readTextFile(compatibilityPath),
  ))
  const sysroot = LINUX_SYSROOTS[target]
  const loaderSuffix = `/lib/${sysroot.arch}/ld-2.27.so`
  if (
    compatibility.target !== target ||
    compatibility.nativeProofSha256 !== product.nativeProofSha256 ||
    compatibility.buildReceiptSha256 !== product.buildReceiptSha256 ||
    compatibility.runtime.denort !== proof.denort ||
    compatibility.runtime.derivedLock !== proof.derivedRelinkLock ||
    compatibility.product.executable !== product.executableSha256 ||
    compatibility.product.bridge !== proof.bridge ||
    compatibility.toolchain.sysrootArchive !== sysroot.archive ||
    compatibility.toolchain.sysrootEnvironment !== sysroot.environment ||
    !compatibility.toolchain.loader.startsWith('/') ||
    !compatibility.toolchain.loader.endsWith(loaderSuffix)
  ) {
    throw new Error(
      `Linux compatibility receipt differs from target evidence: ${target}`,
    )
  }
  const sysrootRoot = compatibility.toolchain.loader.slice(
    0,
    -loaderSuffix.length,
  )
  if (
    !sysrootRoot ||
    compatibility.toolchain.libraryPath !==
      `${sysrootRoot}/lib/${sysroot.arch}:${sysrootRoot}/usr/lib/${sysroot.arch}`
  ) {
    throw new Error(
      `Linux compatibility receipt has an invalid pinned sysroot: ${target}`,
    )
  }
  verifyCompatibilityCommands(compatibility)
  const bridgePath = join(targetDirectory, 'release-bridge-smoke')
  const bridgeInfo = await Deno.lstat(bridgePath).catch(() => undefined)
  if (!bridgeInfo?.isFile || bridgeInfo.isSymlink || bridgeInfo.size <= 0) {
    throw new Error(`Linux compatibility bridge is missing: ${target}`)
  }
  if (await hashFile(bridgePath) !== compatibility.product.bridge) {
    throw new Error(`Linux compatibility bridge bytes differ: ${target}`)
  }
  const logs = new Set<string>()
  for (const [label, elf] of Object.entries(compatibility.checks.elf)) {
    checkedGlibcVersions(
      await verifyCompatibilityCommand(
        root,
        prefix,
        elf.version,
        `${label} ELF version`,
        logs,
      ),
      elf.versions.join(','),
      label,
    )
    checkedDynamicDependencies(
      await verifyCompatibilityCommand(
        root,
        prefix,
        elf.dynamic,
        `${label} ELF dynamic`,
        logs,
      ),
      elf.needed,
      label,
    )
    checkedLoaderPaths(
      await verifyCompatibilityCommand(
        root,
        prefix,
        elf.loaderList,
        `${label} loader`,
        logs,
      ),
      sysrootRoot,
      label,
    )
  }
  await verifyCompatibilityCommand(
    root,
    prefix,
    compatibility.checks.startup,
    'older loader startup',
    logs,
  )
  const licenseLog = await verifyCompatibilityCommand(
    root,
    prefix,
    compatibility.checks.licenses,
    'older loader licenses',
    logs,
  )
  if (
    compatibility.checks.licenses.canonicalNotice !== proof.canonicalNotice ||
    compatibility.checks.licenses.logSha256 !== proof.canonicalNotice ||
    licenseLog !== await Deno.readTextFile(canonicalNoticePath(root))
  ) {
    throw new Error(
      `Linux compatibility licenses bytes differ from canonical notice: ${target}`,
    )
  }
  await verifyCompatibilityCommand(
    root,
    prefix,
    compatibility.checks.bridge,
    'older loader bridge',
    logs,
  )
  await verifyCompatibilityCommand(
    root,
    prefix,
    compatibility.checks.smoke.compile,
    'runtime smoke compile',
    logs,
  )
  await verifyCompatibilityCommand(
    root,
    prefix,
    compatibility.checks.smoke.execute,
    'runtime smoke execute',
    logs,
  )
}

async function verifyProductRuntimeReceipts(
  root: string,
  receipt: SourceMaterialsReceipt,
): Promise<void> {
  const base = join(root, 'dist/release-inputs/product-runtime')
  const directories: string[] = []
  for await (const entry of Deno.readDir(base)) {
    if (!entry.isDirectory || entry.isSymlink) {
      throw new Error('product runtime directory has an unexpected entry')
    }
    directories.push(entry.name)
  }
  if (
    directories.length !== TARGETS.length ||
    TARGETS.some((target) => !directories.includes(target))
  ) {
    throw new Error(
      'product runtime directory must contain exactly four target receipts',
    )
  }
  const sourceReceiptSha256 = await hashFile(
    join(root, SOURCE_MATERIALS_RECEIPT),
  )
  for (const target of TARGETS) {
    await verifyProductRuntimeReceipt(
      root,
      receipt,
      sourceReceiptSha256,
      target,
    )
  }
}

async function verifyProductRuntimeReceipt(
  root: string,
  receipt: SourceMaterialsReceipt,
  sourceReceiptSha256: string,
  target: (typeof TARGETS)[number],
): Promise<void> {
  const base = join(root, 'dist/release-inputs/product-runtime')
  const targetDirectory = join(base, target)
  const isLinux = (LINUX_TARGETS as readonly string[]).includes(target)
  const expectedEntries = isLinux
    ? [
      'product-runtime-receipt.json',
      'linux-compatibility-receipt.json',
      'release-bridge-smoke',
      'linux-compatibility',
    ]
    : ['product-runtime-receipt.json']
  const entries: string[] = []
  for await (const entry of Deno.readDir(targetDirectory)) {
    if (entry.isSymlink) {
      throw new Error(`product runtime target contains a symlink: ${target}`)
    }
    entries.push(entry.name)
  }
  if (
    entries.length !== expectedEntries.length ||
    entries.sort().some((entry, index) =>
      entry !== [...expectedEntries].sort()[index]
    )
  ) {
    throw new Error(
      `product runtime target has an unexpected evidence set: ${target}`,
    )
  }
  const receiptPath = join(targetDirectory, 'product-runtime-receipt.json')
  const productReceiptInfo = await Deno.lstat(receiptPath).catch(() =>
    undefined
  )
  if (!productReceiptInfo?.isFile || productReceiptInfo.isSymlink) {
    throw new Error(
      `product runtime receipt is not a regular file: ${target}`,
    )
  }
  const productReceipt = parseProductRuntimeReceipt(JSON.parse(
    await Deno.readTextFile(receiptPath),
  ))
  const proofPath = join(
    root,
    'dist/release-inputs/source-proofs',
    target,
    'native-proof.json',
  )
  const buildReceiptPath = join(
    root,
    'dist/release-inputs/source-proofs',
    target,
    'build-receipt.json',
  )
  const tarPath = join(root, 'dist', 'slv-' + target + '-exe.tar.gz')
  const executableName = 'slv-' + target + '-exe'
  const proof = sourceProofBaseline(
    JSON.parse(await Deno.readTextFile(proofPath)),
  )
  if (
    productReceipt.target !== target ||
    productReceipt.executableTarSha256 !== await hashFile(tarPath) ||
    productReceipt.executableSha256 !==
      await executableDigestFromArchive(tarPath, executableName) ||
    productReceipt.baselineDenortSha256 !== proof.denort ||
    productReceipt.derivedRelinkCargoLockSha256 !== proof.derivedRelinkLock ||
    productReceipt.sourceSelectedCargoLockSha256 !== proof.selectedLock ||
    productReceipt.sourceSelectedCargoLockSha256 !==
      receipt.runtime_security.selected.cargo_lock.sha256 ||
    productReceipt.sourceReceiptSha256 !== sourceReceiptSha256 ||
    productReceipt.nativeProofSha256 !== await hashFile(proofPath) ||
    productReceipt.buildReceiptSha256 !== await hashFile(buildReceiptPath)
  ) {
    throw new Error(
      'product runtime receipt differs from source proof or executable: ' +
        target,
    )
  }
  if (isLinux) {
    const compatibilityDirectory = join(
      targetDirectory,
      'linux-compatibility',
    )
    const compatibilityInfo = await Deno.lstat(compatibilityDirectory).catch(
      () => undefined,
    )
    if (!compatibilityInfo?.isDirectory || compatibilityInfo.isSymlink) {
      throw new Error(`Linux compatibility evidence is missing: ${target}`)
    }
    await verifyLinuxCompatibilityReceipt(
      root,
      targetDirectory,
      target as (typeof LINUX_TARGETS)[number],
      productReceipt,
      proof,
    )
  }
}

/** Verify one Linux product row without creating release or CI package assets. */
export async function verifyLinuxValidation(
  args: string[],
  options: { root?: string } = {},
): Promise<void> {
  const [target, sourceSha] = args
  if (
    args.length !== 2 ||
    !(LINUX_TARGETS as readonly string[]).includes(target) ||
    !SHA40.test(sourceSha ?? '')
  ) {
    throw new Error(
      'usage: release.ts verify-linux-validation LINUX_TARGET SOURCE_SHA',
    )
  }
  const root = options.root ?? Deno.cwd()
  await reviewedSourceVersion(root)
  const { bundle } = await canonicalLicenseBundle(root, sourceSha)
  const { receipt } = await readVerifiedSourceMaterials(root, sourceSha, bundle)
  await verifyLinuxSourceProofSet({
    sourceReceiptPath: join(root, SOURCE_MATERIALS_RECEIPT),
    sourceDirectory: join(root, SOURCE_MATERIALS_DIRECTORY),
    proofDirectory: join(root, 'dist/release-inputs/source-proofs'),
    sourceCommit: sourceSha,
    sourcePinsPath: join(root, SOURCE_MATERIALS_PINS),
    toolPinsDirectory: join(root, 'dist/release-inputs/tool-pins'),
    canonicalNoticePath: canonicalNoticePath(root),
  })
  const base = join(root, 'dist/release-inputs/product-runtime')
  const directories = []
  for await (const entry of Deno.readDir(base)) {
    if (!entry.isDirectory || entry.isSymlink || entry.name !== target) {
      throw new Error(
        'Linux validation requires exactly the selected product runtime directory',
      )
    }
    directories.push(entry.name)
  }
  if (directories.length !== 1) {
    throw new Error(
      'Linux validation requires exactly the selected product runtime directory',
    )
  }
  await verifyProductRuntimeReceipt(
    root,
    receipt,
    await hashFile(join(root, SOURCE_MATERIALS_RECEIPT)),
    target as (typeof LINUX_TARGETS)[number],
  )
}

export type PrepareLicensesOptions = { root?: string; version?: string }

async function materializeCanonicalLicenses(
  root: string,
  version: string,
  bundle: LicenseBundle,
): Promise<void> {
  const source = canonicalNoticePath(root)
  const destinations = [
    join(root, 'template', version, 'THIRD_PARTY_NOTICES'),
    ...SKILLS.map((skill) =>
      join(root, 'dist/oss-skills', skill, 'THIRD_PARTY_NOTICES')
    ),
  ]
  for (const destination of destinations) {
    await Deno.copyFile(source, destination)
    if (await hashFile(destination) !== bundle.sha256) {
      throw new Error(`canonical license bundle copy differs: ${destination}`)
    }
  }
}

export async function prepareLicenses(
  args: string[],
  options: PrepareLicensesOptions = {},
): Promise<LicenseBundle> {
  const [sourceSha, runId, runAttempt] = args
  if (
    args.length !== 3 || !SHA40.test(sourceSha ?? '') ||
    !DECIMAL.test(runId ?? '') || !DECIMAL.test(runAttempt ?? '')
  ) {
    throw new Error(
      'usage: release.ts prepare-licenses SOURCE_SHA RUN_ID RUN_ATTEMPT',
    )
  }
  const root = options.root ?? Deno.cwd()
  const application = await materializeApplicationNotices(root)
  if (application.unresolvedActual.length) {
    throw new Error(
      `unresolved actual-shipped application notice evidence: ${
        application.unresolvedActual.join(', ')
      }`,
    )
  }
  const notices = await thirdPartyNotices(root)
  const bytes = encoder.encode(notices)
  const source = canonicalNoticePath(root)
  await Deno.mkdir(source.slice(0, source.lastIndexOf('/')), {
    recursive: true,
  })
  await Deno.writeFile(source, bytes)
  const bundle: LicenseBundle = {
    schema_version: 1,
    source_sha: sourceSha,
    producer_run_id: runId,
    producer_run_attempt: Number(runAttempt),
    filename: 'THIRD_PARTY_NOTICES',
    size: bytes.length,
    sha256: await hashFile(source),
  }
  await Deno.writeTextFile(
    canonicalNoticeBindingPath(root),
    JSON.stringify(bundle, null, 2) + '\n',
  )
  const version = options.version ?? sourceVersion(
    await Deno.readTextFile(
      join(root, 'cmn/constants/version.ts'),
    ),
  )
  await materializeCanonicalLicenses(root, version, bundle)
  return bundle
}

export async function verifyLicenses(
  args: string[],
  options: { root?: string } = {},
): Promise<LicenseBundle> {
  const [sourceSha, producerRunId, producerAttempt, expectedSha256] = args
  if (
    args.length !== 4 || !SHA40.test(sourceSha ?? '') ||
    !DECIMAL.test(producerRunId ?? '') ||
    !DECIMAL.test(producerAttempt ?? '') ||
    !SHA256.test(expectedSha256 ?? '')
  ) {
    throw new Error(
      'usage: release.ts verify-licenses SOURCE_SHA RUN_ID PRODUCER_ATTEMPT EXPECTED_SHA256',
    )
  }
  const { bundle } = await canonicalLicenseBundle(
    options.root ?? Deno.cwd(),
    sourceSha,
  )
  if (
    bundle.producer_run_id !== producerRunId ||
    bundle.producer_run_attempt !== Number(producerAttempt) ||
    bundle.sha256 !== expectedSha256
  ) {
    throw new Error(
      'canonical license bundle producer identity or digest differs',
    )
  }
  return bundle
}

/**
 * Read-only preflight for legacy local build tasks. It proves only that the
 * canonical bytes are bound to the explicit source SHA; CI must still run
 * verify-licenses with its producer identity and expected digest first.
 */
export async function requireLicenses(
  args: string[],
  options: { root?: string } = {},
): Promise<LicenseBundle> {
  const [sourceSha] = args
  if (args.length !== 1 || !SHA40.test(sourceSha ?? '')) {
    throw new Error(
      'usage: release.ts require-licenses SOURCE_SHA; obtain the genuine CI notice artifact and run verify-licenses SOURCE_SHA RUN_ID PRODUCER_ATTEMPT EXPECTED_SHA256 before compiling',
    )
  }
  return (await canonicalLicenseBundle(options.root ?? Deno.cwd(), sourceSha))
    .bundle
}

/**
 * Copy a previously verified notice pair into all payload sources. This command
 * deliberately has no collector or graph input, so package jobs cannot replace
 * a producer's canonical bytes while preparing template or skill archives.
 */
export async function materializeLicenses(
  args: string[],
  options: { root?: string; version?: string } = {},
): Promise<LicenseBundle> {
  if (args.length !== 4) {
    throw new Error(
      'usage: release.ts materialize-licenses SOURCE_SHA RUN_ID PRODUCER_ATTEMPT EXPECTED_SHA256',
    )
  }
  const root = options.root ?? Deno.cwd()
  const bundle = await verifyLicenses(args, { root })
  const version = options.version ?? sourceVersion(
    await Deno.readTextFile(join(root, 'cmn/constants/version.ts')),
  )
  await materializeCanonicalLicenses(root, version, bundle)
  return bundle
}

type TarSource = {
  archivePath: string
  sourcePath: string
  type: 'file' | 'directory'
}

function writeTarString(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
  field: string,
): void {
  const bytes = encoder.encode(value)
  if (bytes.length > length || bytes.includes(0)) {
    throw new Error(`USTAR ${field} is too long or invalid: ${value}`)
  }
  header.set(bytes, offset)
}
function writeTarOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid USTAR ${field}`)
  }
  const octal = value.toString(8)
  if (octal.length >= length) throw new Error(`USTAR ${field} is too large`)
  writeTarString(
    header,
    offset,
    length - 1,
    octal.padStart(length - 1, '0'),
    field,
  )
  header[offset + length - 1] = 0
}
function splitUstarPath(path: string): { name: string; prefix: string } {
  const normalized = archivePath(path)
  if (encoder.encode(normalized).length <= 100) {
    return { name: normalized, prefix: '' }
  }
  for (
    let index = normalized.lastIndexOf('/');
    index > 0;
    index = normalized.lastIndexOf('/', index - 1)
  ) {
    const prefix = normalized.slice(0, index)
    const name = normalized.slice(index + 1)
    if (
      encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100
    ) {
      return { name, prefix }
    }
  }
  throw new Error(`USTAR path is too long: ${path}`)
}
function ustarHeader(
  archivePath: string,
  type: TarSource['type'],
  size: number,
  timestamp: number,
): Uint8Array {
  const header = new Uint8Array(512)
  const { name, prefix } = splitUstarPath(archivePath)
  writeTarString(header, 0, 100, name, 'name')
  writeTarOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644, 'mode')
  writeTarOctal(header, 108, 8, 0, 'uid')
  writeTarOctal(header, 116, 8, 0, 'gid')
  writeTarOctal(header, 124, 12, size, 'size')
  writeTarOctal(header, 136, 12, timestamp, 'mtime')
  header.fill(32, 148, 156)
  header[156] = type === 'directory' ? 53 : 0
  writeTarString(header, 257, 6, 'ustar', 'magic')
  writeTarString(header, 263, 2, '00', 'version')
  writeTarString(header, 265, 32, 'root', 'user')
  writeTarString(header, 297, 32, 'root', 'group')
  writeTarOctal(header, 329, 8, 0, 'device major')
  writeTarOctal(header, 337, 8, 0, 'device minor')
  writeTarString(header, 345, 155, prefix, 'prefix')
  let checksum = 0
  for (const byte of header) checksum += byte
  const value = checksum.toString(8)
  if (value.length > 6) throw new Error('USTAR checksum is too large')
  writeTarString(header, 148, 6, value.padStart(6, '0'), 'checksum')
  header[154] = 0
  header[155] = 32
  return header
}
async function tarSources(
  root: string,
  cwd: string,
  entries: string[],
): Promise<TarSource[]> {
  const sources: TarSource[] = []
  const seen = new Set<string>()
  const visit = async (
    archivePath: string,
    sourcePath: string,
  ): Promise<void> => {
    const normalized = archivePath.replace(/\/$/, '')
    if (seen.has(normalized)) {
      throw new Error(`duplicate archive source ${normalized}`)
    }
    seen.add(normalized)
    const info = await Deno.lstat(sourcePath)
    if (info.isSymlink || !(info.isFile || info.isDirectory)) {
      throw new Error(`unsupported source entry ${sourcePath}`)
    }
    if (info.isFile) {
      sources.push({ archivePath: normalized, sourcePath, type: 'file' })
      return
    }
    sources.push({ archivePath: normalized, sourcePath, type: 'directory' })
    const children: Deno.DirEntry[] = []
    for await (const child of Deno.readDir(sourcePath)) children.push(child)
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      await visit(`${normalized}/${child.name}`, join(sourcePath, child.name))
    }
  }
  for (
    const entry of entries.sort((left, right) => left.localeCompare(right))
  ) {
    await visit(archivePath(entry), join(root, cwd, entry))
  }
  return sources.sort((left, right) =>
    left.archivePath.localeCompare(right.archivePath)
  )
}
async function deterministicTar(
  root: string,
  cwd: string,
  entries: string[],
  output: string,
  sourceTimestamp: string,
): Promise<void> {
  const timestamp = Math.floor(Date.parse(sourceTimestamp) / 1000)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('invalid source timestamp')
  }
  const chunks: Uint8Array[] = []
  for (const source of await tarSources(root, cwd, entries)) {
    const contents = source.type === 'file'
      ? await Deno.readFile(source.sourcePath)
      : new Uint8Array()
    chunks.push(
      ustarHeader(source.archivePath, source.type, contents.length, timestamp),
    )
    if (contents.length) {
      chunks.push(contents)
      const padding = (512 - contents.length % 512) % 512
      if (padding) chunks.push(new Uint8Array(padding))
    }
  }
  chunks.push(new Uint8Array(1024))
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const tar = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    tar.set(chunk, offset)
    offset += chunk.length
  }
  await Deno.writeFile(output, await gzip(tar))
}
/** Archive one compiled native executable without relying on the host tar implementation. */
export async function packExecutable(
  input: string,
  output: string,
  archiveName: string,
): Promise<void> {
  const info = await Deno.lstat(input)
  if (!info.isFile || info.isSymlink || info.size <= 0) {
    throw new Error(
      `compiled executable must be a non-empty regular file: ${input}`,
    )
  }
  const parent = output.slice(0, output.lastIndexOf('/'))
  if (parent) await Deno.mkdir(parent, { recursive: true })
  const stage = await Deno.makeTempDir({ prefix: 'slv-executable-archive-' })
  try {
    const staged = join(stage, archivePath(archiveName))
    await Deno.copyFile(input, staged)
    await deterministicTar(
      stage,
      '.',
      [archiveName],
      output,
      '1970-01-01T00:00:00.000Z',
    )
  } finally {
    await Deno.remove(stage, { recursive: true })
  }
  await assertArchive(output, archiveName, { singleFile: true })
}
async function copyTree(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true })
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    const info = await Deno.lstat(from)
    if (info.isSymlink || !(info.isFile || info.isDirectory)) {
      throw new Error(`unsupported source entry ${from}`)
    }
    if (info.isDirectory) await copyTree(from, to)
    else await Deno.copyFile(from, to)
  }
}
async function assertSkillSource(root: string, skill: string): Promise<void> {
  const path = join(root, 'dist/oss-skills', skill)
  const info = await Deno.stat(path)
  if (!info.isDirectory) {
    throw new Error(`missing canonical skill source ${skill}`)
  }
  const markdown = await Deno.stat(join(path, 'SKILL.md'))
  const descriptor = await Deno.stat(join(path, 'skill.json'))
  if (!markdown.isFile || !descriptor.isFile) {
    throw new Error(`incomplete canonical skill source ${skill}`)
  }
  if (
    (JSON.parse(await Deno.readTextFile(join(path, 'skill.json'))) as {
      name?: unknown
    }).name !== skill
  ) throw new Error(`skill.json name does not match ${skill}`)
}
export type PackOptions = {
  root?: string
  outputDir?: string
  qualification?: {
    directory: string
    workflowSha: string
    producerAttempts?: Record<string, string>
  }
}

/** Source containers carry current app metadata. Only the runtime closure is
 * required to match the original, independently qualified source materials. */
export function verifyStableRuntimeSources(
  currentValue: unknown,
  qualifiedValue: unknown,
): void {
  const current = verifySourceMaterialsReceipt(currentValue)
  const qualified = verifySourceMaterialsReceipt(qualifiedValue)
  for (
    const field of [
      'pins',
      'runtime_security',
      'vendor',
      'gitlink_closure',
      'source_legal_evidence',
    ] as const
  ) {
    if (
      canonicalReceipt(current[field]) !== canonicalReceipt(qualified[field])
    ) {
      throw new Error(
        `current runtime source differs from qualification: ${field}`,
      )
    }
  }
  if (
    current.vendor.lock_sha256 !==
      current.runtime_security.selected.cargo_lock.sha256
  ) {
    throw new Error(
      'current runtime vendor does not use the security-selected lock',
    )
  }
}

export function sourceReceiptFromSbom(
  sbom: unknown,
): { value: SourceMaterialsReceipt; raw: string; sha256: string } {
  const annotations = (sbom as { annotations?: unknown })?.annotations
  if (!Array.isArray(annotations)) {
    throw new Error('qualified SBOM lacks source receipt annotations')
  }
  const entries = annotations.filter((entry) =>
    typeof entry?.comment === 'string' &&
    entry.comment.startsWith('SLV source-materials receipt ')
  )
  if (entries.length !== 1) {
    throw new Error(
      'qualified SBOM must carry exactly one current source receipt',
    )
  }
  const match =
    /^SLV source-materials receipt \(verbatim UTF-8; SHA-256 ([a-f0-9]{64})\)\. Extract every byte after the delimiter and verify it against the three source archives\.\n---BEGIN SLV SOURCE MATERIALS RECEIPT---\n([\s\S]+)$/
      .exec(entries[0].comment)
  if (
    !match || createHash('sha256').update(match[2]).digest('hex') !== match[1]
  ) throw new Error('qualified SBOM source receipt bytes differ')
  return {
    value: verifySourceMaterialsReceipt(JSON.parse(match[2])),
    raw: match[2],
    sha256: match[1],
  }
}

export async function verifyQualifiedProducts(
  root: string,
  identity: {
    sourceSha: string
    sourceRef: string
    runId: string
    runAttempt: string
    workflowSha: string
  },
  directory: string,
  release: boolean,
  producerAttempts?: Record<string, string>,
): Promise<QualificationReference> {
  if (
    producerAttempts &&
    (Object.keys(producerAttempts).sort().join(',') !==
        [...TARGETS].sort().join(',') ||
      Object.values(producerAttempts).some((value) =>
        typeof value !== 'string' || !DECIMAL.test(value) ||
        BigInt(value) > BigInt(identity.runAttempt)
      ))
  ) throw new Error('invalid qualified product producer attempt inventory')
  const state = release ? 'final-qualified' : 'candidate-validation'
  const base = join(root, 'dist/release-inputs/product-runtime')
  const directories: string[] = []
  for await (const entry of Deno.readDir(base)) {
    if (!entry.isDirectory || entry.isSymlink) {
      throw new Error('invalid qualified product directory')
    }
    directories.push(entry.name)
  }
  if (directories.sort().join(',') !== [...TARGETS].sort().join(',')) {
    throw new Error('qualified package requires exactly four targets')
  }
  const products: QualificationReference['products'] = []
  let qualificationIdentity = ''
  for (const target of TARGETS) {
    const qualified = await verifyQualificationBinding({
      directory,
      repositoryRoot: root,
      target,
      mode: state,
    })
    if (qualificationIdentity && qualificationIdentity !== qualified.identity) {
      throw new Error('qualification identity differs across products')
    }
    qualificationIdentity = qualified.identity
    verifyStableRuntimeSources(
      JSON.parse(await Deno.readTextFile(join(root, SOURCE_MATERIALS_RECEIPT))),
      JSON.parse(await Deno.readTextFile(qualified.sourceReceipt.path)),
    )
    const product = await verifyCurrentProductFiles(
      root,
      target,
      {
        ...identity,
        runAttempt: producerAttempts?.[target] ?? identity.runAttempt,
      },
      qualified,
    )
    if (
      qualified.manifest.compatibility.embedding_recipe_sha256 !==
        embeddingRecipeSha256() ||
      qualified.manifest.compatibility.libsui_version !== '0.16.3'
    ) {
      throw new Error(
        'qualified embedding recipe differs from current product contract',
      )
    }
    const hostTarget = product.producer.host_arch === 'aarch64'
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu'
    if (
      product.frontend.sha256 !==
        qualified.manifest.compatibility.frontend[hostTarget].sha256
    ) throw new Error('product frontend differs from qualification')
    const targetDirectory = join(base, target)
    const isLinux = target.endsWith('linux-gnu')
    const expectedEntries = [
      'product-runtime-receipt.json',
      'product-verification.json',
      'release-bridge-smoke',
      ...(isLinux
        ? ['linux-compatibility-receipt.json', 'linux-compatibility']
        : []),
    ].sort()
    const entries: string[] = []
    for await (const entry of Deno.readDir(targetDirectory)) {
      if (
        entry.isSymlink ||
        !(entry.isFile ||
          (entry.isDirectory && entry.name === 'linux-compatibility'))
      ) throw new Error('invalid product evidence entry')
      entries.push(entry.name)
    }
    if (entries.sort().join(',') !== expectedEntries.join(',')) {
      throw new Error('qualified product evidence inventory differs')
    }
    const verification = JSON.parse(
      await Deno.readTextFile(
        join(targetDirectory, 'product-verification.json'),
      ),
    )
    verifyRuntimeRevocationBinding(verification.runtime_revocation, {
      identity: qualified.identity,
      mode: state,
      reviewedPolicySha256:
        qualified.revocation.reviewed_checkout_policy.policy_sha256,
      sourceCommit: identity.sourceSha,
    })
    const { runtime_revocation: _validatedPolicy, ...staticVerification } =
      verification
    if (isLinux) {
      const expected = {
        kind: 'slv-current-linux-verification',
        native_execution: 'passed',
        compatibility_sha256: await hashFile(
          join(targetDirectory, 'linux-compatibility-receipt.json'),
        ),
        version: `slv ${await reviewedSourceVersion(root)}\n`,
        notices_sha256: product.source.notices_sha256,
        help: 'passed',
        bridge: 'passed',
      }
      if (canonicalReceipt(staticVerification) !== canonicalReceipt(expected)) {
        throw new Error('current Linux verification differs')
      }
      await verifyLinuxCompatibilityReceipt(
        root,
        targetDirectory,
        target as (typeof LINUX_TARGETS)[number],
        {
          target,
          executableSha256: product.output.executable_sha256,
          executableTarSha256: product.output.archive_sha256,
          baselineDenortSha256: qualified.runtime.sha256,
          sourceSelectedCargoLockSha256: qualified.selectedLock.sha256,
          derivedRelinkCargoLockSha256: qualified.derivedLock.sha256,
          sourceReceiptSha256: product.source.source_receipt_sha256,
          nativeProofSha256: qualified.proof.sha256,
          buildReceiptSha256: qualified.buildReceipt.sha256,
        },
        {
          denort: qualified.runtime.sha256,
          derivedRelinkLock: qualified.derivedLock.sha256,
          selectedLock: qualified.selectedLock.sha256,
          bridge: product.output.bridge_sha256,
          canonicalNotice: product.source.notices_sha256,
        },
      )
    } else {
      const actual = {
        kind: 'slv-current-darwin-verification',
        executable: inspectMachO(
          await executableBytesFromArchive(
            join(root, 'dist', `slv-${target}-exe.tar.gz`),
            `slv-${target}-exe`,
          ),
          target,
        ),
        bridge: inspectMachO(
          await Deno.readFile(join(targetDirectory, 'release-bridge-smoke')),
          target,
        ),
        native_execution: 'not_performed',
      }
      if (canonicalReceipt(actual) !== canonicalReceipt(staticVerification)) {
        throw new Error(
          'Darwin static verification differs from exact current bytes',
        )
      }
    }
    products.push({
      receipt_sha256: createHash('sha256').update(canonicalReceipt(product))
        .digest('hex'),
      receipt: product,
    })
  }
  return validateQualificationReference({
    identity: qualificationIdentity,
    tag: `runtime-deno-v2.9.3-${qualificationIdentity}`,
    manifest_sha256: qualificationIdentity,
    state,
    products,
  }, { ...identity, release })
}

/** Hosted attestation/publication rechecks the public immutable dependency. */
export async function verifyQualifiedPublication(
  args: string[],
  root = Deno.cwd(),
): Promise<void> {
  const [directory, sourceSha, runId, runAttempt, workflowSha, receiptPath] =
    args
  if (
    (args.length !== 5 && args.length !== 6) || !SHA40.test(sourceSha) ||
    !SHA40.test(workflowSha) ||
    !DECIMAL.test(runId) || !DECIMAL.test(runAttempt)
  ) throw new Error('invalid qualified publication identity')
  const selectedQualification = await readQualificationManifest(
    join(root, 'source-materials/runtime-qualification.json'),
  )
  const reviewedPolicy = await checkReviewedRuntimeRevocation(
    qualificationIdentity(selectedQualification),
    root,
  )
  const value = JSON.parse(
    await Deno.readTextFile(join(directory, 'release-manifest.json')),
  )
  if (
    value.schema_version !== 2 || value.artifact_kind || value.unsigned ||
    value.source?.commit !== sourceSha || value.workflow?.run_id !== runId ||
    value.workflow?.run_attempt !== Number(runAttempt)
  ) {
    throw new Error(
      'publication requires the exact final qualified application manifest',
    )
  }
  const reference = validateQualificationReference(
    value.runtime_qualification,
    {
      sourceSha,
      sourceRef: value.source.ref,
      runId,
      runAttempt,
      release: true,
    },
  )
  const canonical = manifest(
    value.version,
    sourceSha,
    value.source.ref,
    runId,
    runAttempt,
    value.assets,
    reference,
  )
  if (canonicalReceipt(canonical) !== canonicalReceipt(value)) {
    throw new Error('qualified publication manifest schema differs')
  }
  const qualification = await readQualificationManifest(
    join(root, 'source-materials/runtime-qualification.json'),
    reference.identity,
  )
  if (qualificationIdentity(qualification) !== reference.manifest_sha256) {
    throw new Error('published qualification identity differs')
  }
  if (
    qualification.compatibility.embedding_recipe_sha256 !==
      embeddingRecipeSha256() ||
    qualification.compatibility.libsui_version !== '0.16.3'
  ) throw new Error('publication embedding recipe differs')
  const github = githubQualificationAdapter()
  await verifyPublishedQualification(qualification, github, [])
  const sbomPath = join(directory, 'sbom.spdx.json')
  const sourceReceipt = sourceReceiptFromSbom(
    JSON.parse(await Deno.readTextFile(sbomPath)),
  )
  if (sourceReceipt.value.source.commit !== sourceSha) {
    throw new Error(
      'publication source receipt is not current application source',
    )
  }
  await verifyReceiptFiles(sourceReceipt.value, directory, {
    sourceCommit: sourceSha,
    canonicalNoticeSha256: await hashFile(
      join(directory, 'THIRD_PARTY_NOTICES'),
    ),
  })
  const temporary = await Deno.makeTempDir({ prefix: 'slv-qualified-source-' })
  try {
    const original = join(temporary, 'source-receipt.json')
    await github.download(
      `https://github.com/ValidatorsDAO/slv/releases/download/${reference.tag}/${qualification.source.receipt}`,
      original,
    )
    const expected = qualification.assets[qualification.source.receipt]
    if (
      (await Deno.stat(original)).size !== expected.size ||
      await hashFile(original) !== expected.sha256
    ) throw new Error('qualified original source receipt bytes differ')
    verifyStableRuntimeSources(
      sourceReceipt.value,
      JSON.parse(await Deno.readTextFile(original)),
    )
  } finally {
    await Deno.remove(temporary, { recursive: true })
  }
  for (const { receipt } of reference.products) {
    const row = qualification.targets.find((row) =>
      row.target === receipt.target
    )!
    const archive = `slv-${receipt.target}-exe.tar.gz`
    const asset = value.assets.find((asset: Asset) => asset.name === archive)
    const notices = value.assets.find((asset: Asset) =>
      asset.name === 'THIRD_PARTY_NOTICES'
    )
    const sbom = value.assets.find((asset: Asset) =>
      asset.name === 'sbom.spdx.json'
    )
    if (
      receipt.producer.workflow_sha !== workflowSha ||
      receipt.qualification.baseline_denort_sha256 !==
        qualification.assets[row.runtime].sha256 ||
      receipt.qualification.selected_lock_sha256 !==
        qualification.assets[qualification.source.selected_lock].sha256 ||
      receipt.qualification.derived_lock_sha256 !==
        qualification.assets[row.derived_lock].sha256 ||
      receipt.qualification.native_proof_sha256 !==
        qualification.assets[row.proof].sha256 ||
      receipt.qualification.build_receipt_sha256 !==
        qualification.assets[row.build_receipt].sha256 ||
      asset?.sha256 !== receipt.output.archive_sha256 ||
      notices?.sha256 !== receipt.source.notices_sha256 ||
      sbom?.sha256 !== receipt.source.sbom_sha256 ||
      await hashFile(sbomPath) !== receipt.source.sbom_sha256 ||
      await hashFile(join(directory, 'THIRD_PARTY_NOTICES')) !==
        receipt.source.notices_sha256 ||
      sourceReceipt.sha256 !== receipt.source.source_receipt_sha256 ||
      sourceReceipt.value.runtime_security.selected.cargo_lock.sha256 !==
        receipt.qualification.selected_lock_sha256 ||
      await hashFile(join(directory, archive)) !==
        receipt.output.archive_sha256 ||
      await executableDigestFromArchive(
          join(directory, archive),
          `slv-${receipt.target}-exe`,
        ) !== receipt.output.executable_sha256
    ) throw new Error('published product differs from qualified receipt')
  }
  const currentPolicy = await checkFreshRuntimeRevocation(reference.identity)
  const destination = resolve(
    receiptPath ??
      join(root, 'dist/release-inputs/publication-runtime-revocation.json'),
  )
  const releaseDirectory = resolve(directory)
  if (
    destination === releaseDirectory ||
    destination.startsWith(`${releaseDirectory}/`)
  ) {
    throw new Error(
      'policy observation must be outside release payload directory',
    )
  }
  await Deno.mkdir(dirname(destination), { recursive: true })
  await Deno.writeTextFile(
    destination,
    JSON.stringify({
      qualification_identity: reference.identity,
      runtime_revocation: {
        reviewed_checkout_policy: reviewedPolicy,
        current_main_policy: currentPolicy,
      },
    }) + '\n',
    { createNew: true },
  )
}

async function packageRelease(
  args: string[],
  options: PackOptions = {},
  ciOnly = false,
): Promise<string> {
  const [version, sourceSha, sourceRef, runId, runAttempt, sourceTimestamp] =
    args
  if (
    args.length !== 6 ||
    ![version, sourceSha, sourceRef, runId, runAttempt, sourceTimestamp].every(
      Boolean,
    )
  ) {
    throw new Error(
      `usage: release.ts ${
        ciOnly ? 'pack-ci' : 'pack'
      } VERSION SOURCE_SHA SOURCE_REF RUN_ID RUN_ATTEMPT SOURCE_TIMESTAMP`,
    )
  }
  const root = options.root ?? Deno.cwd()
  const configured = options.outputDir ?? 'dist/release'
  const out = configured.startsWith('/') ? configured : join(root, configured)
  if (!out.startsWith(`${root}/`) && !configured.startsWith('/')) {
    throw new Error('release output must be below source root')
  }
  if (options.qualification) {
    const selected = await readQualificationManifest(
      join(root, 'source-materials/runtime-qualification.json'),
    )
    await checkReviewedRuntimeRevocation(qualificationIdentity(selected), root)
  }
  await Deno.remove(out, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  })
  await Deno.mkdir(out, { recursive: true })
  try {
    assertVersion(version)
    if (!SHA40.test(sourceSha)) throw new Error('invalid source commit')
    if (ciOnly) {
      if (
        !PR_MERGE_REF.test(sourceRef) &&
        !(options.qualification &&
          /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef))
      ) {
        throw new Error('CI package requires an exact pull-request merge ref')
      }
    } else if (
      sourceRef !== 'refs/heads/main' && sourceRef !== `refs/tags/v${version}`
    ) throw new Error('invalid source ref')
    if (
      !DECIMAL.test(runId) || !DECIMAL.test(runAttempt) ||
      Number.isNaN(Date.parse(sourceTimestamp))
    ) throw new Error('invalid release identity')
    for (const target of TARGETS) {
      const source = join(root, 'dist', `slv-${target}-exe.tar.gz`)
      await assertArchive(source, `slv-${target}-exe`, { singleFile: true })
      await Deno.copyFile(source, join(out, `slv-${target}-exe.tar.gz`))
    }
    const stage = await Deno.makeTempDir({ prefix: 'slv-release-template-' })
    try {
      await copyTree(
        join(root, 'template', version),
        join(stage, 'template', version),
      )
      await deterministicTar(
        stage,
        '.',
        [`template/${version}`],
        join(out, 'template.tar.gz'),
        sourceTimestamp,
      )
    } finally {
      await Deno.remove(stage, { recursive: true })
    }
    await assertArchive(join(out, 'template.tar.gz'), `template/${version}`)
    for (const skill of SKILLS) {
      await assertSkillSource(root, skill)
      const destination = join(out, `${skill}.tar.gz`)
      await deterministicTar(
        root,
        'dist/oss-skills',
        [skill],
        destination,
        sourceTimestamp,
      )
      await assertArchive(destination, skill)
    }
    await Deno.copyFile(join(root, 'sh/install'), join(out, 'install'))
    const notices = await canonicalLicenseBundle(root, sourceSha)
    await Deno.writeFile(join(out, 'THIRD_PARTY_NOTICES'), notices.bytes)
    const sourceMaterials = await copyVerifiedSourceMaterials(
      root,
      out,
      sourceSha,
      notices.bundle,
    )
    let qualification: QualificationReference | undefined
    if (options.qualification) {
      qualification = await verifyQualifiedProducts(
        root,
        {
          sourceSha,
          sourceRef,
          runId,
          runAttempt,
          workflowSha: options.qualification.workflowSha,
        },
        options.qualification.directory,
        !ciOnly,
        options.qualification.producerAttempts,
      )
    } else {
      await verifySourceProofSet({
        sourceReceiptPath: join(root, SOURCE_MATERIALS_RECEIPT),
        sourceDirectory: join(root, SOURCE_MATERIALS_DIRECTORY),
        proofDirectory: join(root, 'dist/release-inputs/source-proofs'),
        sourceCommit: sourceSha,
        sourcePinsPath: join(root, SOURCE_MATERIALS_PINS),
        toolPinsDirectory: join(root, 'dist/release-inputs/tool-pins'),
        canonicalNoticePath: canonicalNoticePath(root),
      })
      await verifyProductRuntimeReceipts(root, sourceMaterials.receipt)
    }
    await Deno.writeTextFile(
      join(out, 'sbom.spdx.json'),
      JSON.stringify(
        await lockedSbom(
          root,
          version,
          sourceSha,
          sourceTimestamp,
          sourceMaterials.rawReceipt,
        ),
        null,
        2,
      ) + '\n',
    )
    if (qualification) {
      const sbomHash = await hashFile(join(out, 'sbom.spdx.json'))
      if (
        qualification.products.some(({ receipt }) =>
          receipt.source.sbom_sha256 !== sbomHash
        )
      ) throw new Error('current product SBOM differs from packaged bytes')
    }
    const assets = await inventory(out)
    await Deno.writeTextFile(
      join(out, 'SHA256SUMS'),
      assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n',
    )
    await Deno.writeTextFile(
      join(out, 'release-manifest.json'),
      JSON.stringify(
        ciOnly
          ? ciManifest(
            version,
            sourceSha,
            sourceRef,
            runId,
            runAttempt,
            assets,
            qualification,
          )
          : manifest(
            version,
            sourceSha,
            sourceRef,
            runId,
            runAttempt,
            assets,
            qualification,
          ),
        null,
        2,
      ) + '\n',
    )
    if (qualification) {
      const reviewedPolicy = await checkReviewedRuntimeRevocation(
        qualification.identity,
        root,
      )
      const currentPolicy = ciOnly
        ? null
        : await checkFreshRuntimeRevocation(qualification.identity)
      const destination = resolve(
        join(root, 'dist/release-inputs/package-runtime-revocation.json'),
      )
      if (
        destination === resolve(out) ||
        destination.startsWith(`${resolve(out)}/`)
      ) {
        throw new Error(
          'package policy observation must be outside payload directory',
        )
      }
      await Deno.mkdir(dirname(destination), { recursive: true })
      await Deno.writeTextFile(
        destination,
        JSON.stringify({
          qualification_identity: qualification.identity,
          runtime_revocation: {
            reviewed_checkout_policy: reviewedPolicy,
            current_main_policy: currentPolicy,
          },
        }) + '\n',
        { createNew: true },
      )
    }
    return out
  } catch (error) {
    await Deno.remove(out, { recursive: true }).catch(() => undefined)
    throw error
  }
}
export function pack(
  args: string[],
  options: PackOptions = {},
): Promise<string> {
  return packageRelease(args, options)
}
export function packCi(
  args: string[],
  options: PackOptions = {},
): Promise<string> {
  return packageRelease(args, options, true)
}
if (import.meta.main) {
  const [command, ...rawArgs] = Deno.args
  // `deno task name -- value` deliberately passes this separator through to
  // the task command. Strip only that one separator after the fixed command.
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  if (command === 'verify-qualified-publication') {
    await verifyQualifiedPublication(args)
  } else if (
    (command === 'pack-qualified' || command === 'pack-ci-qualified') &&
    (args.length === 8 || args.length === 9)
  ) {
    const options = {
      qualification: {
        workflowSha: args[6],
        directory: args[7],
        ...(args[8]
          ? { producerAttempts: JSON.parse(await Deno.readTextFile(args[8])) }
          : {}),
      },
    }
    if (command === 'pack-qualified') await pack(args.slice(0, 6), options)
    else await packCi(args.slice(0, 6), options)
  } else if (command === 'pack') {
    await pack(args)
  } else if (command === 'pack-ci') {
    await packCi(args)
  } else if (command === 'verify-linux-validation') {
    await verifyLinuxValidation(args)
  } else if (command === 'source-version' && args.length === 0) {
    console.log(await reviewedSourceVersion())
  } else if (command === 'prepare-licenses') {
    await prepareLicenses(args)
  } else if (command === 'verify-licenses') {
    await verifyLicenses(args)
  } else if (command === 'require-licenses') {
    await requireLicenses(args)
  } else if (command === 'materialize-licenses') {
    await materializeLicenses(args)
  } else if (command === 'graph' && args.length === 1) {
    await writeCompiledModuleGraph(
      args[0],
      'dist/release-inputs/compiled-module-graph.json',
    )
  } else if (command === 'executable' && args.length === 3) {
    await packExecutable(args[0], args[1], args[2])
  } else {
    throw new Error(
      'usage: release.ts pack|pack-ci VERSION SOURCE_SHA SOURCE_REF RUN_ID RUN_ATTEMPT SOURCE_TIMESTAMP | verify-linux-validation LINUX_TARGET SOURCE_SHA | source-version | prepare-licenses SOURCE_SHA RUN_ID RUN_ATTEMPT | verify-licenses|materialize-licenses SOURCE_SHA RUN_ID PRODUCER_ATTEMPT EXPECTED_SHA256 | require-licenses SOURCE_SHA | graph DENO_INFO_JSON | executable INPUT OUTPUT ARCHIVE_NAME',
    )
  }
}
