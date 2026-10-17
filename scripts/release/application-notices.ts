/**
 * Materializes application dependency notices from frozen build inputs. It is
 * offline: primary-source acquisition is reviewed separately and its bytes live
 * below application-notices/evidence with a checked-in digest manifest.
 */
const encoder = new TextEncoder()
const SHA256 = /^[a-f0-9]{64}$/
const NOTICE_FILE =
  /^(?:(?:licen[cs]e|notice|copying)(?:\.(?:txt|md))?|(?:licen[cs]e|notice|copying)[-_](?:apache(?:-2(?:\.0)?)?|mit|bsd(?:-[0-9]-clause)?|gpl(?:-[0-9](?:\.0)?(?:-or-later)?)?|lgpl(?:-[0-9](?:\.0)?(?:-or-later)?)?|mpl(?:-2(?:\.0)?))(?:\.(?:txt|md))?|mit-license(?:\.(?:txt|md))?)$/i
const join = (...parts: string[]) => parts.join('/').replaceAll(/\/{2,}/g, '/')

type Namespace = 'npm' | 'jsr' | 'remote'
type Graph = {
  schema_version: 1
  npm: string[]
  jsr: string[]
  remote: string[]
}
type PrimaryFile = {
  path: string
  sha256: string
  source: string
  role?: 'notice' | 'source-material'
}
type Supplement = {
  original_archive_integrity: string
  original_evidence_receipt: string
  supplement_source_commit: string
  same_source_verified: boolean
  rationale: string
  maintainer_statement?: string
}
type PrimaryDistribution = {
  id: string
  files: PrimaryFile[]
  supplement?: Supplement
}
type DerivedUnicodeData = {
  npm_key: string
  output_path: string
  output_sha256: string
  output_bytes: number
  output_rows: number
  generator_path: string
  generator_sha256: string
  source_data_path: string
  source_data_sha256: string
  original_attribution: string
  transform_description: string
  historical_modification_notice: string
  current_distribution_permission: string
}
type AdditionalComponent = {
  id: string
  files: PrimaryFile[]
  inclusion_basis: 'actual-shipped'
  derived_unicode_data: DerivedUnicodeData
}
type PrimaryIndex = {
  schema_version: 1
  distributions: PrimaryDistribution[]
  additional_components?: AdditionalComponent[]
}
type OutputComponent = {
  namespace: Namespace
  key: string
  files: string[]
  declared_license?: string
  inclusion_basis: 'actual-shipped' | 'conservative-extra'
  supplement?: Supplement
}
type OutputAdditionalComponent = {
  id: string
  files: string[]
  inclusion_basis: 'actual-shipped'
  derived_unicode_data: DerivedUnicodeData
}
export type ApplicationNoticeReport = {
  materialized: number
  unresolvedActual: string[]
  conservativeExtrasWithoutText: string[]
}

const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/
const COMMIT = /^[a-f0-9]{40}$/

const graphPath = (root: string) =>
  join(root, 'dist/release-inputs/compiled-module-graph.json')
const outputIndexPath = (root: string) =>
  join(root, 'dist/release-inputs/license-evidence.json')
const primaryRoot = (root: string) =>
  join(root, 'scripts/release/application-notices')
const primaryIndexPath = (root: string) =>
  join(primaryRoot(root), 'evidence-index.json')

function safeRelative(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
}

async function digest(path: string): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', await Deno.readFile(path))
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function sortedUnique(values: unknown, name: string): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new Error(`application notice graph has invalid ${name}`)
  }
  const sorted = [...values].sort()
  if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
    throw new Error(`application notice graph has duplicate ${name}`)
  }
  return sorted
}

async function graph(root: string): Promise<Graph> {
  const input = JSON.parse(await Deno.readTextFile(graphPath(root))) as Partial<
    Graph
  >
  if (input.schema_version !== 1) {
    throw new Error('application notice graph has invalid schema')
  }
  return {
    schema_version: 1,
    npm: sortedUnique(input.npm, 'npm'),
    jsr: sortedUnique(input.jsr, 'jsr'),
    remote: sortedUnique(input.remote, 'remote'),
  }
}

function remoteDistribution(key: string): string | undefined {
  let url: URL
  try {
    url = new URL(key)
  } catch {
    throw new Error(`invalid remote graph key: ${key}`)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'deno.land') {
    return undefined
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0]?.startsWith('std@')) return `deno.land/${parts[0]}`
  if (parts[0] === 'x' && parts[1]) return `deno.land/x/${parts[1]}`
  return undefined
}

function distributionId(namespace: Namespace, key: string): string | undefined {
  if (namespace === 'npm') return `npm:${key}`
  if (namespace === 'jsr') return `jsr:${key}`
  if (namespace === 'remote') return remoteDistribution(key)
  return undefined
}

async function primaryIndex(
  root: string,
): Promise<{
  distributions: Map<string, PrimaryDistribution>
  additional: AdditionalComponent[]
}> {
  const value = JSON.parse(
    await Deno.readTextFile(primaryIndexPath(root)),
  ) as Partial<PrimaryIndex>
  if (value.schema_version !== 1 || !Array.isArray(value.distributions)) {
    throw new Error(
      'application notice evidence index must have schema_version 1',
    )
  }
  const entries = new Map<string, PrimaryDistribution>()
  for (const distribution of value.distributions) {
    if (
      !distribution || typeof distribution.id !== 'string' ||
      !distribution.id ||
      !Array.isArray(distribution.files) || distribution.files.length === 0 ||
      entries.has(distribution.id)
    ) {
      throw new Error(
        'application notice evidence index has invalid distribution',
      )
    }
    for (const file of distribution.files) {
      if (
        !file || !safeRelative(file.path) || !SHA256.test(file.sha256) ||
        typeof file.source !== 'string' ||
        !file.source.startsWith('https://') ||
        (file.role !== undefined && file.role !== 'notice' &&
          file.role !== 'source-material')
      ) {
        throw new Error(
          `application notice evidence index has invalid file for ${distribution.id}`,
        )
      }
    }
    if (distribution.supplement !== undefined) {
      const supplement = distribution.supplement
      if (
        !INTEGRITY.test(supplement.original_archive_integrity) ||
        !safeRelative(supplement.original_evidence_receipt) ||
        !COMMIT.test(supplement.supplement_source_commit) ||
        typeof supplement.same_source_verified !== 'boolean' ||
        !supplement.rationale.trim() ||
        (supplement.maintainer_statement !== undefined &&
          (!supplement.maintainer_statement.startsWith('https://')))
      ) {
        throw new Error(
          `application notice evidence index has invalid supplement for ${distribution.id}`,
        )
      }
    }
    entries.set(distribution.id, distribution)
  }
  const additional = value.additional_components ?? []
  if (!Array.isArray(additional)) {
    throw new Error(
      'application notice evidence index has invalid additional components',
    )
  }
  const additionalIds = new Set<string>()
  for (const component of additional) {
    const derived = component?.derived_unicode_data
    if (
      !component || typeof component.id !== 'string' || !component.id ||
      additionalIds.has(component.id) || !Array.isArray(component.files) ||
      !component.files.length ||
      component.inclusion_basis !== 'actual-shipped' ||
      !derived || typeof derived.npm_key !== 'string' ||
      !safeRelative(derived.output_path) ||
      !SHA256.test(derived.output_sha256) ||
      !Number.isSafeInteger(derived.output_bytes) ||
      derived.output_bytes <= 0 ||
      !Number.isSafeInteger(derived.output_rows) || derived.output_rows <= 0 ||
      !safeRelative(derived.generator_path) ||
      !SHA256.test(derived.generator_sha256) ||
      !safeRelative(derived.source_data_path) ||
      !SHA256.test(derived.source_data_sha256) ||
      !derived.original_attribution.trim() ||
      !derived.transform_description.trim() ||
      !derived.historical_modification_notice.trim() ||
      !derived.current_distribution_permission.trim()
    ) {
      throw new Error(
        'application notice evidence index has invalid Unicode data component',
      )
    }
    for (const file of component.files) {
      if (
        !file || !safeRelative(file.path) || !SHA256.test(file.sha256) ||
        typeof file.source !== 'string' ||
        !file.source.startsWith('https://') ||
        (file.role !== undefined && file.role !== 'notice' &&
          file.role !== 'source-material')
      ) {
        throw new Error(
          `application notice evidence index has invalid file for ${component.id}`,
        )
      }
    }
    const generator = component.files.find((file) =>
      file.path === derived.generator_path
    )
    const sourceData = component.files.find((file) =>
      file.path === derived.source_data_path
    )
    if (
      !generator || generator.sha256 !== derived.generator_sha256 ||
      generator.role !== 'source-material' || !sourceData ||
      sourceData.sha256 !== derived.source_data_sha256 ||
      sourceData.role !== 'source-material' ||
      !component.files.some((file) => file.role !== 'source-material')
    ) {
      throw new Error(
        `application notice evidence index has unbound Unicode data evidence for ${component.id}`,
      )
    }
    additionalIds.add(component.id)
  }
  return { distributions: entries, additional }
}

/**
 * Fetch only sources explicitly pinned in evidence-index.json. This is an
 * explicit acquisition step, not part of normal preparation: every byte is
 * hashed before it becomes offline evidence for a clean CI workspace.
 */
export async function acquireApplicationNoticeEvidence(
  root = Deno.cwd(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { distributions, additional } = await primaryIndex(root)
  const unique = new Map<string, PrimaryFile>()
  for (const distribution of [...distributions.values(), ...additional]) {
    for (const file of distribution.files) {
      const previous = unique.get(file.path)
      if (
        previous &&
        (previous.sha256 !== file.sha256 || previous.source !== file.source)
      ) {
        throw new Error(
          `conflicting primary notice evidence path: ${file.path}`,
        )
      }
      unique.set(file.path, file)
    }
  }
  for (
    const file of [...unique.values()].sort((a, b) =>
      a.path.localeCompare(b.path)
    )
  ) {
    const response = await fetcher(file.source)
    if (!response.ok) {
      throw new Error(`primary notice acquisition failed: ${file.source}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (
      !bytes.length ||
      !new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    ) {
      throw new Error(`primary notice acquisition was empty: ${file.source}`)
    }
    const actual = await crypto.subtle.digest('SHA-256', bytes)
    const actualHex = [...new Uint8Array(actual)].map((byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    if (actualHex !== file.sha256) {
      throw new Error(
        `primary notice acquisition digest differs: ${file.source}`,
      )
    }
    const target = join(primaryRoot(root), file.path)
    await Deno.mkdir(target.slice(0, target.lastIndexOf('/')), {
      recursive: true,
    })
    await Deno.writeFile(target, bytes)
  }
}

function npmNameVersion(key: string): { name: string; version: string } {
  const pivot = key.startsWith('@') ? key.indexOf('@', 1) : key.indexOf('@')
  if (pivot <= 0) throw new Error(`invalid npm graph key: ${key}`)
  const name = key.slice(0, pivot)
  const version = key.slice(pivot + 1).split('_')[0]
  if (!name || !version) throw new Error(`invalid npm graph key: ${key}`)
  return { name, version }
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}

async function npmDirectory(
  root: string,
  name: string,
  version: string,
): Promise<string | undefined> {
  const direct = join(root, 'node_modules', name)
  const matches = async (path: string) => {
    const text = await optionalText(join(path, 'package.json'))
    if (!text) return false
    try {
      const packageJson = JSON.parse(text) as {
        name?: unknown
        version?: unknown
      }
      return packageJson.name === name && packageJson.version === version
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

async function assertNpmIntegrity(
  root: string,
  key: string,
  expected: string,
): Promise<void> {
  let lock: { npm?: Record<string, { integrity?: unknown }> }
  try {
    lock = JSON.parse(await Deno.readTextFile(join(root, 'deno.lock'))) as {
      npm?: Record<string, { integrity?: unknown }>
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `missing deno.lock for supplemented application notice ${key}`,
      )
    }
    throw error
  }
  const actual = lock.npm?.[key]?.integrity
  if (actual !== expected) {
    throw new Error(
      `supplemented application notice archive integrity differs for ${key}`,
    )
  }
}

function safeOutputSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '_')
}

async function copyText(
  root: string,
  source: string,
  subject: string,
  ordinal: number,
): Promise<string> {
  const text = await optionalText(source)
  if (!text?.trim()) {
    throw new Error(`application notice text is empty: ${source}`)
  }
  const relative = `dist/release-inputs/application-notices/${
    safeOutputSegment(subject)
  }/${ordinal}-${source.split('/').pop()}`
  const target = join(root, relative)
  await Deno.mkdir(target.slice(0, target.lastIndexOf('/')), {
    recursive: true,
  })
  await Deno.copyFile(source, target)
  return relative
}

async function materializeNpm(
  root: string,
  key: string,
  primary: Map<string, PrimaryDistribution>,
): Promise<OutputComponent> {
  const { name, version } = npmNameVersion(key)
  const directory = await npmDirectory(root, name, version)
  let declared: string | undefined
  const packageJson = directory
    ? await optionalText(join(directory, 'package.json'))
    : undefined
  if (packageJson) {
    try {
      const license = (JSON.parse(packageJson) as { license?: unknown }).license
      if (typeof license === 'string' && license.trim()) {
        declared = license.trim()
      }
    } catch { /* declarations do not substitute for text */ }
  }
  // An explicit primary record may cover an exact package archive which omits
  // its legal text. The full graph identity keeps it version and peer-set
  // specific; a declared SPDX expression alone never reaches this path.
  const supplied = await materializePrimary(root, 'npm', key, primary)
  if (supplied) {
    if (supplied.supplement) {
      await assertNpmIntegrity(
        root,
        key,
        supplied.supplement.original_archive_integrity,
      )
    }
    return {
      ...supplied,
      ...(declared ? { declared_license: declared } : {}),
    }
  }
  if (!directory) {
    return {
      namespace: 'npm',
      key,
      files: [],
      inclusion_basis: 'conservative-extra',
    }
  }
  const names: string[] = []
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && NOTICE_FILE.test(entry.name)) names.push(entry.name)
  }
  const files: string[] = []
  for (const [ordinal, name] of names.sort().entries()) {
    const source = join(directory, name)
    const text = await optionalText(source)
    if (text?.trim()) {
      files.push(await copyText(root, source, `npm-${key}`, ordinal))
    }
  }
  return {
    namespace: 'npm',
    key,
    files,
    ...(declared ? { declared_license: declared } : {}),
    inclusion_basis: 'actual-shipped',
  }
}

async function materializePrimary(
  root: string,
  namespace: Namespace,
  key: string,
  entries: Map<string, PrimaryDistribution>,
): Promise<OutputComponent | undefined> {
  const id = distributionId(namespace, key)
  if (!id) return undefined
  const distribution = entries.get(id)
  if (!distribution) return undefined
  const files: string[] = []
  for (
    const [ordinal, file] of [...distribution.files].sort((a, b) =>
      a.path.localeCompare(b.path)
    ).entries()
  ) {
    const source = join(primaryRoot(root), file.path)
    let actual: string
    try {
      actual = await digest(source)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined
      throw error
    }
    if (actual !== file.sha256) {
      throw new Error(
        `application notice evidence digest differs: ${file.path}`,
      )
    }
    if (file.role !== 'source-material') {
      files.push(await copyText(root, source, id, ordinal))
    }
  }
  return {
    namespace,
    key,
    files,
    inclusion_basis: 'actual-shipped',
    ...(distribution.supplement ? { supplement: distribution.supplement } : {}),
  }
}

async function materializeUnicodeData(
  root: string,
  component: AdditionalComponent,
): Promise<OutputAdditionalComponent | undefined> {
  const derived = component.derived_unicode_data
  const { name, version } = npmNameVersion(derived.npm_key)
  const directory = await npmDirectory(root, name, version)
  if (!directory) return undefined
  const output = join(directory, derived.output_path)
  const info = await Deno.stat(output).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  })
  if (!info?.isFile || info.size !== derived.output_bytes) {
    throw new Error(`Unicode mapping output size differs for ${component.id}`)
  }
  if (await digest(output) !== derived.output_sha256) {
    throw new Error(`Unicode mapping output digest differs for ${component.id}`)
  }
  let rows: unknown
  try {
    rows = JSON.parse(await Deno.readTextFile(output))
  } catch {
    throw new Error(`Unicode mapping output is not JSON for ${component.id}`)
  }
  if (!Array.isArray(rows) || rows.length !== derived.output_rows) {
    throw new Error(
      `Unicode mapping output row count differs for ${component.id}`,
    )
  }
  const files: string[] = []
  for (
    const [ordinal, file] of [...component.files].sort((a, b) =>
      a.path.localeCompare(b.path)
    ).entries()
  ) {
    const source = join(primaryRoot(root), file.path)
    let actual: string
    try {
      actual = await digest(source)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined
      throw error
    }
    if (actual !== file.sha256) {
      throw new Error(
        `application notice evidence digest differs: ${file.path}`,
      )
    }
    if (file.role !== 'source-material') {
      files.push(await copyText(root, source, component.id, ordinal))
    }
  }
  return {
    id: component.id,
    files,
    inclusion_basis: 'actual-shipped',
    derived_unicode_data: derived,
  }
}

/**
 * Build the only application input accepted by prepare-licenses. NPM text is
 * copied from a frozen Deno install; JSR and remote text is copied from
 * checked-in, hash-pinned primary-source evidence. No network request occurs.
 */
export async function materializeApplicationNotices(
  root = Deno.cwd(),
): Promise<ApplicationNoticeReport> {
  const measured = await graph(root)
  const primary = await primaryIndex(root)
  const evidenceRoot = join(root, 'dist/release-inputs/application-notices')
  await Deno.remove(evidenceRoot, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  })
  const components: OutputComponent[] = []
  const unresolvedActual = new Set<string>()
  const conservativeExtrasWithoutText: string[] = []
  for (const key of measured.npm) {
    const component = await materializeNpm(root, key, primary.distributions)
    components.push(component)
    if (!component.files.length) {
      if (component.inclusion_basis === 'conservative-extra') {
        conservativeExtrasWithoutText.push(`npm:${key}`)
      } else unresolvedActual.add(`npm:${key}`)
    }
  }
  for (
    const [namespace, keys] of [
      ['jsr', measured.jsr],
      ['remote', measured.remote],
    ] as const
  ) {
    for (const key of keys) {
      const component = await materializePrimary(
        root,
        namespace,
        key,
        primary.distributions,
      )
      if (component) components.push(component)
      else {
        const id = distributionId(namespace, key)
        unresolvedActual.add(id ?? `${namespace}:${key}`)
      }
    }
  }
  const additional: OutputAdditionalComponent[] = []
  for (const component of primary.additional) {
    const output = await materializeUnicodeData(root, component)
    if (!output || !output.files.length) unresolvedActual.add(component.id)
    else additional.push(output)
  }
  const report: ApplicationNoticeReport = {
    materialized:
      components.filter((component) => component.files.length > 0).length,
    unresolvedActual: [...unresolvedActual].sort(),
    conservativeExtrasWithoutText: conservativeExtrasWithoutText.sort(),
  }
  await Deno.mkdir(join(root, 'dist/release-inputs'), { recursive: true })
  await Deno.writeTextFile(
    outputIndexPath(root),
    JSON.stringify(
      {
        schema_version: 1,
        components: components.sort((a, b) =>
          `${a.namespace}:${a.key}`.localeCompare(`${b.namespace}:${b.key}`)
        ),
        additional_components: additional.sort((a, b) =>
          a.id.localeCompare(b.id)
        ),
      },
      null,
      2,
    ) + '\n',
  )
  await Deno.writeTextFile(
    join(root, 'dist/release-inputs/application-notices-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  return report
}

if (import.meta.main) {
  if (Deno.args.length === 1 && Deno.args[0] === 'acquire') {
    await acquireApplicationNoticeEvidence()
  } else if (Deno.args.length === 0) {
    const report = await materializeApplicationNotices()
    if (report.unresolvedActual.length) {
      throw new Error(
        `unresolved actual-shipped application notice evidence: ${
          report.unresolvedActual.join(', ')
        }`,
      )
    }
  } else {
    throw new Error('usage: application-notices.ts [acquire]')
  }
}
