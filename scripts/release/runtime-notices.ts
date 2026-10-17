/**
 * Builds the runtime portion of SLV's THIRD_PARTY_NOTICES from checked-in,
 * immutable-source evidence. This module is deliberately offline: acquisition
 * is a separately invoked operation and normal release preparation only reads
 * the reviewed evidence bytes.
 */
const encoder = new TextEncoder()

export const RUNTIME_NOTICE_TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
] as const

type InclusionBasis =
  | 'actual-shipped'
  | 'conservative-extra'
  /** Exact source-vendor archive; never a binary inclusion assertion. */
  | 'source-vendor'
  /** Evidence retained for the upstream Deno lock, absent from the selected lock. */
  | 'upstream-baseline'
type EvidenceRole = 'notice' | 'source-material'
type EvidenceFile = {
  path: string
  sha256: string
  /** Source material establishes what was built; it is not rendered as a notice. */
  role?: EvidenceRole
  immutable_source?: string
  source_pin?: string
}
type Component = {
  component: string
  version: string
  immutable_source: string
  source_pin: string
  /** Immutable archive receipt when a file is carried by a release archive. */
  archive?: { url: string; sha256: string }
  files: EvidenceFile[]
  /** Empty only for source-vendor material with no binary target claim. */
  target_coverage: string[]
  inclusion_basis: InclusionBasis
}
type EvidenceIndex = {
  schema_version: number
  generator: string
  runtime: {
    component: string
    version: string
    cargo_lock: EvidenceFile
    /** Original upstream Deno lock retained as historical resolution evidence. */
    upstream_cargo_lock?: EvidenceFile
    /** Checked-in normal-dependency closure for the four supported denort targets. */
    closure?: EvidenceFile
    /** Original upstream closure retained with the upstream lock evidence. */
    upstream_closure?: EvidenceFile
    /** Checked-in source-resolution receipt for still-blocking closure packages. */
    required_gap_receipt?: EvidenceFile
    /**
     * Complete source-vendor identity/evidence receipt. This is separate from
     * the denort binary closure and may carry a qualification without claiming
     * historical licensing certainty.
     */
    source_vendor_coverage?: EvidenceFile
    /** Exact selected registry identity receipt, intentionally distinct from a count. */
    selected_lock_coverage?: EvidenceFile
  }
  components: Component[]
  unresolved?: string[]
}

type RuntimeClosurePackage = {
  package: string
  target_coverage: string[]
  notice_component: string
}
type RuntimeClosure = {
  schema_version: number
  deno_source_commit: string
  cargo_lock_sha256: string
  roots: string[]
  dependency_kinds: string
  command: string
  target_metadata: Array<{ target: string; sha256: string }>
  packages: RuntimeClosurePackage[]
  required_components: string[]
}

export type RuntimeNotices = {
  text: string
  index: EvidenceIndex
  /** Backwards-compatible required gaps only. */
  unresolved: string[]
  unresolvedRequired: string[]
  unresolvedConservative: string[]
  sourceVendorCoverage: SourceVendorCoverageResult
  selectedLockCoverage: SelectedLockCoverageResult
}

type SourceVendorQualification = {
  component: string
  classification: 'historical-license-scope-inference'
  source_file_count: number
  webgl_xml_file_count: number
  direct_later_license_linked: number
  historical_scope_inference_paths: string[]
  receipt: EvidenceFile
}

type SourceVendorIdentity = {
  package: string
  component: string
  source_pin: string
  archive: { url: string; sha256: string }
  evidence: EvidenceFile[]
}

type SourceVendorCoverage = {
  schema_version: number
  cargo_lock_sha256: string
  disposition: 'complete' | 'complete-with-qualification'
  v8_native_mapping: {
    cargo_package: 'v8@149.4.0'
    component: 'rusty_v8@149.4.0'
    source_pin: string
  }
  resolved_identities: SourceVendorIdentity[]
  qualifications: SourceVendorQualification[]
}

export type SourceVendorCoverageResult = {
  /** Materialized evidence is complete; qualification still describes scope. */
  complete: boolean
  disposition:
    | 'not-indexed'
    | 'incomplete'
    | 'complete'
    | 'complete-with-qualification'
  receipt?: { path: string; sha256: string }
  resolvedIdentities: string[]
  qualifications: Array<{
    component: string
    classification: 'historical-license-scope-inference'
    directLaterLicenseLinked: number
    historicalScopeInferencePaths: string[]
  }>
  gaps: string[]
}

export type SelectedLockCoverageResult = {
  /** Every selected registry package is tied to checked evidence or the v8 mapping. */
  complete: boolean
  registryPackageCount: number
  resolvedRegistryPackages: string[]
  receipt?: { path: string; sha256: string }
  gaps: string[]
}

const SHA256 = /^[a-f0-9]{64}$/
const PIN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function safeRelativePath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', source)
  return [...new Uint8Array(digest)].map((value) =>
    value.toString(16).padStart(2, '0')
  ).join('')
}

async function checkedText(root: string, file: EvidenceFile): Promise<string> {
  if (!validEvidenceFile(file)) {
    throw new Error(`invalid runtime notice evidence file: ${file.path}`)
  }
  let bytes: Uint8Array
  try {
    bytes = await Deno.readFile(`${root}/${file.path}`)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`missing runtime notice evidence: ${file.path}`)
    }
    throw error
  }
  if (bytes.length === 0 || !new TextDecoder().decode(bytes).trim()) {
    throw new Error(`empty runtime notice evidence: ${file.path}`)
  }
  const actual = await sha256(bytes)
  if (actual !== file.sha256) {
    throw new Error(`runtime notice evidence digest mismatch: ${file.path}`)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd()
}

function validEvidenceFile(file: EvidenceFile): boolean {
  return safeRelativePath(file.path) && SHA256.test(file.sha256) &&
    (file.role === undefined || file.role === 'notice' ||
      file.role === 'source-material') &&
    ((file.immutable_source === undefined && file.source_pin === undefined) ||
      (file.immutable_source?.startsWith('https://') === true &&
        file.source_pin !== undefined && PIN.test(file.source_pin) &&
        file.immutable_source.includes(file.source_pin)))
}

function validCoverage(targets: string[]): boolean {
  return targets.length > 0 && new Set(targets).size === targets.length &&
    targets.every((target) =>
      (RUNTIME_NOTICE_TARGETS as readonly string[]).includes(target)
    )
}

function validComponent(component: Component): boolean {
  return Boolean(component.component) && Boolean(component.version) &&
    PIN.test(component.source_pin) &&
    component.immutable_source.startsWith('https://') &&
    (component.archive === undefined ||
      (component.archive.url.startsWith('https://') &&
        SHA256.test(component.archive.sha256))) &&
    (component.inclusion_basis === 'actual-shipped' ||
      component.inclusion_basis === 'conservative-extra' ||
      component.inclusion_basis === 'source-vendor' ||
      component.inclusion_basis === 'upstream-baseline') &&
    component.files.length > 0 && component.files.every(validEvidenceFile) &&
    (component.inclusion_basis === 'source-vendor' ||
        component.inclusion_basis === 'upstream-baseline'
      ? component.target_coverage.length === 0
      : validCoverage(component.target_coverage))
}

function sameEvidenceFiles(
  left: EvidenceFile[],
  right: EvidenceFile[],
): boolean {
  const normalize = (files: EvidenceFile[]) =>
    files.map((file) =>
      JSON.stringify({
        path: file.path,
        sha256: file.sha256,
        role: file.role ?? 'notice',
        immutable_source: file.immutable_source,
        source_pin: file.source_pin,
      })
    ).sort()
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function parseSourceVendorCoverage(
  text: string,
  index: EvidenceIndex,
  cargoLock: string,
): SourceVendorCoverage {
  let coverage: SourceVendorCoverage
  try {
    coverage = JSON.parse(text) as SourceVendorCoverage
  } catch {
    throw new Error('source-vendor coverage receipt is not JSON')
  }
  const registry = registryCargoPackages(cargoLock)
  const registryByPackage = new Map(
    registry.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]),
  )
  const sourceVendor = index.components.filter((component) =>
    component.component.startsWith('cargo:') &&
    registryByPackage.has(
      `${component.component.replace(/^cargo:/, '')}@${component.version}`,
    )
  )
  const components = new Map(
    sourceVendor.map((component) => [componentKey(component), component]),
  )
  const identities = coverage.resolved_identities ?? []
  const identityKeys = identities.map((identity) => identity.component)
  const validQualification = (qualification: SourceVendorQualification) => {
    const component = components.get(qualification.component)
    return qualification.classification ===
        'historical-license-scope-inference' &&
      component !== undefined &&
      Number.isInteger(qualification.source_file_count) &&
      qualification.source_file_count > 0 &&
      Number.isInteger(qualification.webgl_xml_file_count) &&
      qualification.webgl_xml_file_count > 0 &&
      Number.isInteger(qualification.direct_later_license_linked) &&
      qualification.direct_later_license_linked >= 0 &&
      qualification.direct_later_license_linked <=
        qualification.webgl_xml_file_count &&
      Array.isArray(qualification.historical_scope_inference_paths) &&
      qualification.historical_scope_inference_paths.length > 0 &&
      new Set(qualification.historical_scope_inference_paths).size ===
        qualification.historical_scope_inference_paths.length &&
      qualification.direct_later_license_linked +
            qualification.historical_scope_inference_paths.length ===
        qualification.webgl_xml_file_count &&
      validEvidenceFile(qualification.receipt) &&
      component.files.some((file) =>
        file.path === qualification.receipt.path &&
        file.sha256 === qualification.receipt.sha256
      )
  }
  const validIdentity = (identity: SourceVendorIdentity) => {
    const component = components.get(identity.component)
    const pkg = registryByPackage.get(identity.package)
    return component !== undefined && pkg !== undefined && identity.package ===
        `${component.component.replace(/^cargo:/, '')}@${component.version}` &&
      identity.source_pin === component.source_pin &&
      identity.archive?.url ===
        `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate` &&
      identity.archive?.sha256 === pkg.checksum &&
      Array.isArray(identity.evidence) &&
      identity.evidence.every(validEvidenceFile) &&
      sameEvidenceFiles(identity.evidence, component.files)
  }
  const rustyV8 = index.components.find((component) =>
    componentKey(component) === 'rusty_v8@149.4.0'
  )
  if (
    coverage.schema_version !== 1 ||
    coverage.cargo_lock_sha256 !== index.runtime.cargo_lock.sha256 ||
    (coverage.disposition !== 'complete' &&
      coverage.disposition !== 'complete-with-qualification') ||
    !coverage.v8_native_mapping ||
    coverage.v8_native_mapping.cargo_package !== 'v8@149.4.0' ||
    coverage.v8_native_mapping.component !== 'rusty_v8@149.4.0' ||
    coverage.v8_native_mapping.source_pin !== rustyV8?.source_pin ||
    !registryByPackage.has('v8@149.4.0') ||
    !Array.isArray(identities) ||
    identities.length !== sourceVendor.length ||
    new Set(identityKeys).size !== identityKeys.length ||
    !identities.every(validIdentity) ||
    new Set(identityKeys).size !== components.size ||
    !Array.isArray(coverage.qualifications) ||
    new Set(coverage.qualifications.map((item) => item.component)).size !==
      coverage.qualifications.length ||
    !coverage.qualifications.every(validQualification) ||
    (coverage.disposition === 'complete' &&
      coverage.qualifications.length > 0) ||
    (coverage.disposition === 'complete-with-qualification' &&
      coverage.qualifications.length === 0)
  ) {
    throw new Error('invalid source-vendor coverage receipt')
  }
  return coverage
}

function componentKey(component: Component): string {
  return `${component.component}@${component.version}`
}

function parseIndex(text: string): EvidenceIndex {
  let index: EvidenceIndex
  try {
    index = JSON.parse(text) as EvidenceIndex
  } catch {
    throw new Error('runtime notice evidence index is not JSON')
  }
  if (
    index.schema_version !== 1 ||
    index.generator !== 'scripts/release/runtime-notices.ts' ||
    !index.runtime || index.runtime.component !== 'deno' ||
    index.runtime.version !== '2.9.3' || !index.runtime.cargo_lock ||
    (index.runtime.upstream_cargo_lock !== undefined &&
      !validEvidenceFile(index.runtime.upstream_cargo_lock)) ||
    (index.runtime.closure !== undefined &&
      !validEvidenceFile(index.runtime.closure)) ||
    (index.runtime.upstream_closure !== undefined &&
      !validEvidenceFile(index.runtime.upstream_closure)) ||
    (index.runtime.required_gap_receipt !== undefined &&
      !validEvidenceFile(index.runtime.required_gap_receipt)) ||
    (index.runtime.source_vendor_coverage !== undefined &&
      !validEvidenceFile(index.runtime.source_vendor_coverage)) ||
    (index.runtime.selected_lock_coverage !== undefined &&
      !validEvidenceFile(index.runtime.selected_lock_coverage)) ||
    !Array.isArray(index.components) ||
    index.components.some((item) => !validComponent(item))
  ) throw new Error('invalid runtime notice evidence index')
  const ids = index.components.map((item) =>
    `${item.component}@${item.version}:${item.source_pin}`
  )
  if (new Set(ids).size !== ids.length) {
    throw new Error('duplicate runtime notice component')
  }
  return index
}

function parseClosure(text: string): RuntimeClosure {
  let closure: RuntimeClosure
  try {
    closure = JSON.parse(text) as RuntimeClosure
  } catch {
    throw new Error('runtime closure evidence is not JSON')
  }
  const packageIds = closure.packages?.map((item) => item.package) ?? []
  if (
    closure.schema_version !== 1 || !PIN.test(closure.deno_source_commit) ||
    !SHA256.test(closure.cargo_lock_sha256) ||
    closure.dependency_kinds !== 'normal (kind = null only)' ||
    !Array.isArray(closure.roots) || closure.roots.length !== 1 ||
    closure.roots[0] !== 'denort@2.9.3' ||
    !Array.isArray(closure.target_metadata) ||
    closure.target_metadata.length !== RUNTIME_NOTICE_TARGETS.length ||
    new Set(closure.target_metadata.map((item) => item.target)).size !==
      RUNTIME_NOTICE_TARGETS.length ||
    closure.target_metadata.some((item) =>
      !(RUNTIME_NOTICE_TARGETS as readonly string[]).includes(item.target) ||
      !SHA256.test(item.sha256)
    ) ||
    !Array.isArray(closure.packages) ||
    closure.packages.some((item) =>
      !/^[^@\s]+@.+$/.test(item.package) ||
      !validCoverage(item.target_coverage) || !item.notice_component
    ) ||
    new Set(packageIds).size !== packageIds.length ||
    !Array.isArray(closure.required_components) ||
    !closure.required_components.length ||
    new Set(closure.required_components).size !==
      closure.required_components.length ||
    !closure.command
  ) {
    throw new Error('invalid runtime closure evidence')
  }
  return closure
}

/** Cargo.lock is provenance, not proof that every locked crate is shipped. */
function conservativeCargoExtras(lock: string): string[] {
  return lock.split('[[package]]').slice(1).flatMap((entry) => {
    const name = /^name = "([^"]+)"$/m.exec(entry)?.[1]
    const version = /^version = "([^"]+)"$/m.exec(entry)?.[1]
    const source = /^source = "([^"]+)"$/m.exec(entry)?.[1]
    if (!name || !version || !source?.startsWith('registry+')) return []
    return [
      `conservative-extra:cargo:${name}@${version}: LICENSE or NOTICE text not materialized`,
    ]
  }).sort()
}

type CargoPackage = { name: string; version: string; checksum: string }
function registryCargoPackages(lock: string): CargoPackage[] {
  const packages = lock.split('[[package]]').slice(1).flatMap((entry) => {
    const name = /^name = "([^"]+)"$/m.exec(entry)?.[1]
    const version = /^version = "([^"]+)"$/m.exec(entry)?.[1]
    const source = /^source = "([^"]+)"$/m.exec(entry)?.[1]
    const checksum = /^checksum = "([a-f0-9]{64})"$/m.exec(entry)?.[1]
    return name && version && source?.startsWith('registry+') && checksum
      ? [{ name, version, checksum }]
      : []
  })
  return packages.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  )
}

function tarSize(bytes: Uint8Array, offset: number): number {
  const raw = new TextDecoder().decode(bytes.slice(offset, offset + 12))
    .replace(/\0.*$/, '').trim()
  if (!/^[0-7]*$/.test(raw)) throw new Error('invalid crate tar size')
  return raw ? Number.parseInt(raw, 8) : 0
}
function tarPath(bytes: Uint8Array, offset: number): string {
  const text = new TextDecoder().decode(bytes.slice(offset, offset + 100))
    .replace(/\0.*$/, '')
  const prefix = new TextDecoder().decode(
    bytes.slice(offset + 345, offset + 500),
  ).replace(/\0.*$/, '')
  return prefix ? `${prefix}/${text}` : text
}
function legalName(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  // A source filename such as COPYING-PHASE.cc is not a legal notice.  Accept
  // conventional legal-document names only, with an optional text extension.
  return /^(?:licen[cs]e|notice)(?:[._-][A-Za-z0-9+]+)*(?:\.(?:md|txt))?$/i
    .test(name) ||
    /^(?:copying(?:[._-](?:lesser|lib))?|copyright)(?:\.(?:md|txt))?$/i
      .test(name)
}
export function containsFullLicenseText(path: string, text: string): boolean {
  if (!text.trim()) return false
  const name = path.split('/').at(-1) ?? ''
  const conventionalName = legalName(path)
  const mit =
    /permission is hereby granted, free of charge, to any person obtaining a copy/i
      .test(text) &&
    /the software is provided ["']?as is["']?/i.test(text)
  const bsd = /redistribution and use in source and binary forms/i.test(text) &&
    /disclaimer/i.test(text)
  const apache = /apache license(?:,?\s*version)?\s*2\.0/i.test(text) &&
    /terms and conditions for use, reproduction, and distribution/i.test(text)
  const gnu = /gnu (?:lesser )?general public license/i.test(text) &&
    /terms and conditions/i.test(text)
  const boost = /boost software license/i.test(text) &&
    /permission is hereby granted/i.test(text)
  const unicode = /unicode license/i.test(text) &&
    /permission is hereby granted/i.test(text)
  const cc0 = /creative commons legal code/i.test(text) ||
    /cc0 1\.0 universal/i.test(text)
  return conventionalName
    ? (mit || bsd || apache || gnu || boost || unicode || cc0)
    : /^readme(?:[._-].*)?$/i.test(name) &&
      (mit || bsd || apache || gnu || boost || unicode || cc0)
}
function readmeContainsLicenseText(path: string, text: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  if (!/^readme(?:[._-].*)?$/i.test(name)) return false
  return containsFullLicenseText(path, text)
}
async function crateLegalFiles(
  bytes: Uint8Array,
): Promise<Array<{ path: string; text: string }>> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const tar = new Uint8Array(
    await new Response(stream.pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    )).arrayBuffer(),
  )
  const files: Array<{ path: string; text: string }> = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    if (tar.slice(offset, offset + 512).every((byte) => byte === 0)) break
    const size = tarSize(tar, offset + 124)
    const type = tar[offset + 156]
    const path = tarPath(tar, offset)
    const body = offset + 512
    const end = body + size
    if (end > tar.length) throw new Error('truncated crate tar')
    if (type === 0 || type === 48) {
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          tar.slice(body, end),
        )
      } catch {
        offset = body + Math.ceil(size / 512) * 512
        continue
      }
      if (
        text.trim() && (readmeContainsLicenseText(path, text) ||
          (legalName(path) && containsFullLicenseText(path, text)))
      ) {
        files.push({ path, text })
      }
    }
    offset = body + Math.ceil(size / 512) * 512
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Explicit, bounded public acquisition for Cargo.lock's registry packages.
 * It hashes every .crate before inspecting it in memory and retains only legal
 * texts. All results remain conservative extras until target closure review.
 */
export async function collectConservativeCargoEvidence(
  evidenceRoot: string,
): Promise<string[]> {
  const index = parseIndex(
    await Deno.readTextFile(`${evidenceRoot}/evidence-index.json`),
  )
  const lock = await checkedText(evidenceRoot, index.runtime.cargo_lock)
  const packages = registryCargoPackages(lock)
  const failures: string[] = []
  const retained: Component[] = index.components.filter((component) =>
    !(component.inclusion_basis === 'conservative-extra' &&
      component.source_pin.length === 64)
  )
  const collected: Component[] = []
  const workers = Array.from({ length: 8 }, async () => {
    while (packages.length) {
      const pkg = packages.shift()!
      const url = `https://static.crates.io/crates/${
        encodeURIComponent(pkg.name)
      }/${encodeURIComponent(pkg.name)}-${
        encodeURIComponent(pkg.version)
      }.crate`
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const archive = new Uint8Array(await response.arrayBuffer())
        if (await sha256(archive) !== pkg.checksum) {
          throw new Error('Cargo.lock checksum mismatch')
        }
        const legal = await crateLegalFiles(archive)
        if (!legal.length) {
          throw new Error(
            'no nonempty LICENSE, LICENCE, COPYING, or NOTICE file',
          )
        }
        const files: EvidenceFile[] = []
        for (const entry of legal) {
          const name = entry.path.replaceAll(/[^A-Za-z0-9._-]/g, '_')
          const path = `evidence/cargo/${
            encodeURIComponent(pkg.name)
          }@${pkg.version}/${name}`
          await Deno.mkdir(
            `${evidenceRoot}/${path.slice(0, path.lastIndexOf('/'))}`,
            { recursive: true },
          )
          await Deno.writeTextFile(`${evidenceRoot}/${path}`, entry.text)
          files.push({ path, sha256: await sha256(encoder.encode(entry.text)) })
        }
        collected.push({
          component: `cargo:${pkg.name}`,
          version: pkg.version,
          immutable_source: url,
          source_pin: pkg.checksum,
          files,
          target_coverage: [...RUNTIME_NOTICE_TARGETS],
          inclusion_basis: 'conservative-extra',
        })
      } catch (error) {
        failures.push(
          `conservative-extra:cargo:${pkg.name}@${pkg.version}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  })
  await Promise.all(workers)
  const next = {
    ...index,
    components: [...retained, ...collected].sort((a, b) =>
      `${a.component}@${a.version}`.localeCompare(`${b.component}@${b.version}`)
    ),
    unresolved: [...new Set(failures)].sort(),
  }
  await Deno.writeTextFile(
    `${evidenceRoot}/evidence-index.json`,
    JSON.stringify(next, null, 2) + '\n',
  )
  return next.unresolved ?? []
}

/** Read evidence and return notices plus exact gaps; it never fetches or writes. */
export async function buildRuntimeNotices(
  evidenceRoot: string,
): Promise<RuntimeNotices> {
  const index = parseIndex(
    await Deno.readTextFile(`${evidenceRoot}/evidence-index.json`),
  )
  const unresolvedRequired: string[] = []
  const unresolvedConservative: string[] = []
  const sourceVendorGaps: string[] = []
  const componentEvidenceGaps = new Map<string, string[]>()
  let cargoLock: string | undefined
  try {
    cargoLock = await checkedText(evidenceRoot, index.runtime.cargo_lock)
  } catch (error) {
    unresolvedRequired.push(
      error instanceof Error ? error.message : String(error),
    )
  }
  if (index.runtime.upstream_cargo_lock) {
    try {
      await checkedText(evidenceRoot, index.runtime.upstream_cargo_lock)
    } catch (error) {
      unresolvedConservative.push(
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  if (index.runtime.upstream_closure) {
    try {
      await checkedText(evidenceRoot, index.runtime.upstream_closure)
    } catch (error) {
      unresolvedConservative.push(
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  let closure: RuntimeClosure | undefined
  if (index.runtime.closure) {
    try {
      closure = parseClosure(
        await checkedText(evidenceRoot, index.runtime.closure),
      )
      if (closure.cargo_lock_sha256 !== index.runtime.cargo_lock.sha256) {
        unresolvedRequired.push(
          'runtime closure Cargo.lock digest does not match index',
        )
      }
    } catch (error) {
      unresolvedRequired.push(
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  if (index.runtime.required_gap_receipt) {
    try {
      await checkedText(evidenceRoot, index.runtime.required_gap_receipt)
    } catch (error) {
      unresolvedRequired.push(
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  const components = new Map(
    index.components.map((component) => [componentKey(component), component]),
  )
  const closureComponents = new Set(
    closure?.packages.map((item) => item.notice_component) ?? [],
  )
  for (const entry of index.unresolved ?? []) {
    const conservativeComponent = /^conservative-extra:([^:]+:[^:]+):/.exec(
      entry,
    )?.[1]
    if (entry.startsWith('conservative-extra:')) {
      // The source-resolution receipt reports the same missing component for
      // each Cargo-only finding. A package in the reviewed denort closure is
      // already emitted below as a blocking closure gap; keeping it here too
      // would present one missing notice as both required and conservative.
      if (
        conservativeComponent && closureComponents.has(conservativeComponent) &&
        !components.get(conservativeComponent)
      ) continue
      unresolvedConservative.push(entry)
    } else {
      unresolvedRequired.push(entry)
    }
  }
  if (closure) {
    for (const name of closure.required_components) {
      const component = components.get(name)
      if (!component || component.inclusion_basis !== 'actual-shipped') {
        unresolvedRequired.push(
          `required runtime component is not materialized: ${name}`,
        )
      }
    }
    for (const item of closure.packages) {
      const component = components.get(item.notice_component)
      if (!component || component.inclusion_basis !== 'actual-shipped') {
        unresolvedRequired.push(
          `required denort closure package is not materialized: ${item.package}`,
        )
      } else if (
        !item.target_coverage.every((target) =>
          component.target_coverage.includes(target)
        )
      ) {
        unresolvedRequired.push(
          `required denort closure package lacks target notice coverage: ${item.package}`,
        )
      }
    }
  } else if (cargoLock) {
    // Cargo.lock intentionally over-approximates release contents. Without a
    // reviewed target closure it can inform follow-up work but cannot create a
    // false required-runtime claim.
    unresolvedConservative.push(...conservativeCargoExtras(cargoLock))
  }
  const sections: string[] = [
    'SLV DENO RUNTIME THIRD-PARTY NOTICES',
    '',
    `Runtime: ${index.runtime.component} ${index.runtime.version}`,
    `Cargo.lock evidence: ${index.runtime.cargo_lock.path}`,
    `Cargo.lock SHA-256: ${index.runtime.cargo_lock.sha256}`,
    ...(index.runtime.upstream_cargo_lock
      ? [
        `Upstream Deno Cargo.lock baseline evidence: ${index.runtime.upstream_cargo_lock.path}`,
        `Upstream Deno Cargo.lock baseline SHA-256: ${index.runtime.upstream_cargo_lock.sha256}`,
      ]
      : []),
    'Registry packages listed only by Cargo.lock are conservative extras until a target-specific runtime closure and their license/notice texts are materialized.',
    '',
  ]
  if (closure) {
    sections.push(
      `Normal denort closure evidence: ${index.runtime.closure?.path}`,
      `Closure roots: ${closure.roots.join(', ')}`,
      `Closure dependency edges: ${closure.dependency_kinds}`,
      'The closure was measured from the pinned Deno source and is distinct from Cargo.lock-only conservative extras.',
      index.runtime.required_gap_receipt
        ? `Unresolved required-source receipt: ${index.runtime.required_gap_receipt.path}`
        : '',
      '',
    )
  }
  for (
    const component of [...index.components].sort((a, b) =>
      `${a.component}@${a.version}`.localeCompare(`${b.component}@${b.version}`)
    )
  ) {
    if (component.inclusion_basis === 'upstream-baseline') continue
    sections.push(
      `Component: ${component.component}@${component.version}`,
      `Immutable source: ${component.immutable_source}`,
      `Source pin: ${component.source_pin}`,
      ...(component.archive
        ? [
          `Release archive: ${component.archive.url}`,
          `Release archive SHA-256: ${component.archive.sha256}`,
        ]
        : []),
      `Inclusion basis: ${component.inclusion_basis}`,
      component.inclusion_basis === 'source-vendor'
        ? 'Scope: exact Cargo source-vendor archive; no denort binary-target inclusion claim'
        : `Target coverage: ${
          [...component.target_coverage].sort().join(', ')
        }`,
    )
    for (
      const file of [...component.files].sort((a, b) =>
        a.path.localeCompare(b.path)
      )
    ) {
      try {
        const text = await checkedText(evidenceRoot, file)
        const role = file.role ?? 'notice'
        sections.push(
          `Evidence path: ${file.path}`,
          `SHA-256: ${file.sha256}`,
          `Evidence role: ${role}`,
        )
        if (file.immutable_source && file.source_pin) {
          sections.push(
            `Evidence source: ${file.immutable_source}`,
            `Evidence source pin: ${file.source_pin}`,
          )
        }
        if (role === 'notice') sections.push('', text)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const key = componentKey(component)
        componentEvidenceGaps.set(key, [
          ...(componentEvidenceGaps.get(key) ?? []),
          message,
        ])
        if (component.inclusion_basis === 'actual-shipped') {
          unresolvedRequired.push(message)
        } else {
          unresolvedConservative.push(message)
          if (component.inclusion_basis === 'source-vendor') {
            sourceVendorGaps.push(message)
          }
        }
      }
    }
    sections.push('')
  }
  const selectedRegistryPackages = cargoLock
    ? registryCargoPackages(cargoLock)
    : []
  const hasSourceVendor = selectedRegistryPackages.length > 0
  let sourceVendorCoverage: SourceVendorCoverageResult = {
    complete: !hasSourceVendor,
    disposition: hasSourceVendor ? 'incomplete' : 'not-indexed',
    resolvedIdentities: [],
    qualifications: [],
    gaps: [],
  }
  if (index.runtime.source_vendor_coverage) {
    try {
      const receipt = index.runtime.source_vendor_coverage
      const coverage = parseSourceVendorCoverage(
        await checkedText(evidenceRoot, receipt),
        index,
        cargoLock ?? '',
      )
      const selectedEvidenceGaps = coverage.resolved_identities.flatMap(
        (identity) => componentEvidenceGaps.get(identity.component) ?? [],
      )
      sourceVendorGaps.push(...selectedEvidenceGaps)
      sourceVendorCoverage = {
        complete: sourceVendorGaps.length === 0,
        disposition: sourceVendorGaps.length === 0
          ? coverage.disposition
          : 'incomplete',
        receipt: { path: receipt.path, sha256: receipt.sha256 },
        resolvedIdentities: coverage.resolved_identities.map((identity) =>
          identity.package
        ).sort(),
        qualifications: coverage.qualifications.map((qualification) => ({
          component: qualification.component,
          classification: qualification.classification,
          directLaterLicenseLinked: qualification.direct_later_license_linked,
          historicalScopeInferencePaths: [
            ...qualification.historical_scope_inference_paths,
          ].sort(),
        })),
        gaps: [...sourceVendorGaps].sort(),
      }
    } catch (error) {
      const message = `source-vendor coverage receipt: ${
        error instanceof Error ? error.message : String(error)
      }`
      unresolvedConservative.push(message)
      sourceVendorGaps.push(message)
      sourceVendorCoverage = {
        complete: false,
        disposition: 'incomplete',
        receipt: {
          path: index.runtime.source_vendor_coverage.path,
          sha256: index.runtime.source_vendor_coverage.sha256,
        },
        resolvedIdentities: [],
        qualifications: [],
        gaps: [...sourceVendorGaps].sort(),
      }
    }
  } else if (hasSourceVendor) {
    const message = 'source-vendor coverage receipt is not indexed'
    unresolvedConservative.push(message)
    sourceVendorGaps.push(message)
    sourceVendorCoverage.gaps = [...sourceVendorGaps]
  }
  let selectedLockCoverage: SelectedLockCoverageResult = {
    complete: false,
    registryPackageCount: selectedRegistryPackages.length,
    resolvedRegistryPackages: [],
    gaps: [],
  }
  if (index.runtime.selected_lock_coverage) {
    try {
      const receipt = index.runtime.selected_lock_coverage
      if (
        !index.runtime.source_vendor_coverage ||
        receipt.path !== index.runtime.source_vendor_coverage.path ||
        receipt.sha256 !== index.runtime.source_vendor_coverage.sha256
      ) {
        throw new Error(
          'selected-lock coverage receipt must equal source-vendor coverage receipt',
        )
      }
      const coverage = parseSourceVendorCoverage(
        await checkedText(evidenceRoot, receipt),
        index,
        cargoLock ?? '',
      )
      const resolved = coverage.resolved_identities.map((identity) =>
        identity.package
      ).sort()
      const coverageGaps = [
        ...sourceVendorGaps,
        ...(sourceVendorCoverage.complete ? [] : sourceVendorCoverage.gaps),
      ]
      selectedLockCoverage = {
        complete: coverageGaps.length === 0 &&
          resolved.length + 1 === selectedRegistryPackages.length,
        registryPackageCount: selectedRegistryPackages.length,
        resolvedRegistryPackages: resolved,
        receipt: { path: receipt.path, sha256: receipt.sha256 },
        gaps: [...new Set(coverageGaps)].sort(),
      }
    } catch (error) {
      selectedLockCoverage = {
        complete: false,
        registryPackageCount: selectedRegistryPackages.length,
        resolvedRegistryPackages: [],
        receipt: {
          path: index.runtime.selected_lock_coverage.path,
          sha256: index.runtime.selected_lock_coverage.sha256,
        },
        gaps: [
          `selected-lock coverage receipt: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      }
    }
  } else {
    selectedLockCoverage.gaps = [
      'selected-lock coverage receipt is not indexed',
    ]
  }
  if (sourceVendorCoverage.receipt) {
    sections.push(
      'Selected Cargo source-vendor coverage evidence:',
      `Receipt: ${sourceVendorCoverage.receipt.path}`,
      `Receipt SHA-256: ${sourceVendorCoverage.receipt.sha256}`,
      `Materialized source-distribution notice coverage: ${sourceVendorCoverage.disposition}`,
      ...sourceVendorCoverage.qualifications.flatMap((qualification) => [
        `Qualification: ${qualification.component} has ${qualification.directLaterLicenseLinked} WebGL XML files with byte-equal later-license linkage and ${qualification.historicalScopeInferencePaths.length} historical-scope inference paths.`,
        'This qualification records materialized notice coverage; it does not assert retrospective licensing certainty or complete legal compliance.',
      ]),
      '',
    )
  }
  const required = [...new Set(unresolvedRequired)].sort()
  const conservative = [...new Set(unresolvedConservative)].sort()
  if (required.length) {
    sections.push(
      'Required runtime notice evidence gaps:',
      ...required.map((item) => `- ${item}`),
      '',
    )
  }
  if (conservative.length) {
    sections.push(
      'Conservative extra evidence gaps (not part of the reviewed denort closure):',
      ...conservative.map((item) => `- ${item}`),
      '',
    )
  }
  return {
    text: sections.join('\n'),
    index,
    unresolved: required,
    unresolvedRequired: required,
    unresolvedConservative: conservative,
    sourceVendorCoverage: {
      ...sourceVendorCoverage,
      gaps: [...new Set(sourceVendorCoverage.gaps)].sort(),
    },
    selectedLockCoverage: {
      ...selectedLockCoverage,
      gaps: [...new Set(selectedLockCoverage.gaps)].sort(),
    },
  }
}

/**
 * Explicit acquisition is intentionally limited to these immutable public raw
 * files. It is not run by buildRuntimeNotices or normal release preparation.
 */
export async function acquireRuntimeNoticeEvidence(
  destination: string,
): Promise<void> {
  const bootstrapSources = [
    [
      'evidence/deno/Cargo.lock',
      'https://raw.githubusercontent.com/denoland/deno/f39575ecd50602a5b42b1ba8e93849460de9fcf4/Cargo.lock',
    ],
    [
      'evidence/deno/LICENSE.md',
      'https://raw.githubusercontent.com/denoland/deno/f39575ecd50602a5b42b1ba8e93849460de9fcf4/LICENSE.md',
    ],
    [
      'evidence/rusty_v8/LICENSE',
      'https://raw.githubusercontent.com/denoland/rusty_v8/dd1b4e9c743b7a11dbeb99d4d0dc55979218b905/LICENSE',
    ],
    [
      'evidence/v8/LICENSE',
      'https://raw.githubusercontent.com/denoland/v8/73d19698991616a34a00ca691a6e697dbb69e2ef/LICENSE',
    ],
  ] as const
  const index = parseIndex(
    await Deno.readTextFile(`${destination}/evidence-index.json`),
  )
  const expected = new Map<string, string>([
    [index.runtime.cargo_lock.path, index.runtime.cargo_lock.sha256],
    ...(index.runtime.source_vendor_coverage
      ? [
        [
          index.runtime.source_vendor_coverage.path,
          index.runtime.source_vendor_coverage.sha256,
        ] as const,
      ]
      : []),
    ...index.components.flatMap((component) =>
      component.files.map((file) => [file.path, file.sha256] as const)
    ),
  ])
  const sources = new Map<string, string>(bootstrapSources)
  for (const component of index.components) {
    for (const file of component.files) {
      if (file.immutable_source) sources.set(file.path, file.immutable_source)
    }
  }
  for (
    const [path, source] of [...sources].sort(([left], [right]) =>
      left.localeCompare(right)
    )
  ) {
    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(`runtime notice acquisition failed: ${source}`)
    }
    const bytes = source.includes('chromium.googlesource.com') &&
        source.includes('format=TEXT')
      ? Uint8Array.from(
        atob((await response.text()).trim()),
        (char) => char.charCodeAt(0),
      )
      : new Uint8Array(await response.arrayBuffer())
    if (!bytes.length) {
      throw new Error(`runtime notice acquisition was empty: ${source}`)
    }
    if (await sha256(bytes) !== expected.get(path)) {
      throw new Error(`runtime notice acquisition digest mismatch: ${source}`)
    }
    const output = `${destination}/${path}`
    await Deno.mkdir(output.slice(0, output.lastIndexOf('/')), {
      recursive: true,
    })
    await Deno.writeFile(output, bytes)
  }
}

if (import.meta.main && Deno.args[0] === 'acquire') {
  const destination = Deno.args[1]
  if (!destination) {
    throw new Error('usage: runtime-notices.ts acquire <evidence-root>')
  }
  await acquireRuntimeNoticeEvidence(destination)
}
if (import.meta.main && Deno.args[0] === 'collect-cargo') {
  const destination = Deno.args[1]
  if (!destination) {
    throw new Error('usage: runtime-notices.ts collect-cargo <evidence-root>')
  }
  const unresolved = await collectConservativeCargoEvidence(destination)
  if (unresolved.length) console.error(unresolved.join('\n'))
}
