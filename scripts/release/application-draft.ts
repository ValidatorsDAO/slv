/** Read-only draft selection and continuity checks for the hosted publisher. */
import {
  canonicalQualificationBytes,
  githubQualificationAdapter,
  type QualificationGitHub,
  type QualificationRelease,
} from './runtime-qualification.ts'

type DraftApi = Pick<QualificationGitHub, 'release'>
export type ApplicationDraft = {
  id: number
  tag_name: string
  target_commitish: string
  draft: true
  prerelease: false
  immutable: false
  assets: { id: number; name: string; size: number; digest: string }[]
}
function fail(message: string): never {
  throw new Error(`application draft: ${message}`)
}
const positive = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) > 0
const canonical = (value: unknown) =>
  new TextDecoder().decode(canonicalQualificationBytes(value))
function identity(tag: string, source: string) {
  if (
    typeof tag !== 'string' || typeof source !== 'string' ||
    !/^v\d{4}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12]\d|3[01])\.\d{4}$/.test(tag) ||
    !/^[a-f0-9]{40}$/.test(source)
  ) fail('invalid tag or source')
}
function snapshot(
  value: QualificationRelease,
  tag: string,
  source: string,
): ApplicationDraft {
  if (
    !value || !positive(value.id) || value.tag_name !== tag ||
    value.target_commitish !== source || value.draft !== true ||
    value.prerelease !== false || value.immutable !== false ||
    !Array.isArray(value.assets) || value.assets.length > 1024
  ) fail('release is not the expected mutable application draft')
  const names = new Set<string>(), ids = new Set<number>()
  const assets = value.assets.map((row) => {
    if (
      !row || !positive(row.id) || !positive(row.size) ||
      typeof row.name !== 'string' || typeof row.digest !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(row.name) ||
      !/^sha256:[a-f0-9]{64}$/.test(row.digest) ||
      names.has(row.name) || ids.has(row.id)
    ) fail('invalid or duplicate uploaded asset identity')
    names.add(row.name)
    ids.add(row.id)
    return { id: row.id, name: row.name, size: row.size, digest: row.digest }
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return {
    id: value.id,
    tag_name: tag,
    target_commitish: source,
    draft: true,
    prerelease: false,
    immutable: false,
    assets,
  }
}

/** The shared adapter falls back from the published-tag API to authenticated
 * bounded release listing. A draft is never inferred absent from tag 404 alone. */
export async function findApplicationDraft(
  tag: string,
  source: string,
  api: DraftApi = githubQualificationAdapter(),
): Promise<ApplicationDraft | null> {
  identity(tag, source)
  const release = await api.release(tag)
  return release === null ? null : snapshot(release, tag, source)
}

/** Additions are allowed while staging missing uploads. Every selected existing
 * entry must survive unchanged; the final check permits no inventory change. */
export async function checkApplicationDraft(
  selected: ApplicationDraft,
  allowAdditions: boolean,
  api: DraftApi = githubQualificationAdapter(),
): Promise<ApplicationDraft> {
  identity(selected?.tag_name, selected?.target_commitish)
  const original = snapshot(
    selected as QualificationRelease,
    selected.tag_name,
    selected.target_commitish,
  )
  if (canonical(original) !== canonical(selected)) {
    fail('invalid saved draft snapshot')
  }
  const current = await findApplicationDraft(
    selected.tag_name,
    selected.target_commitish,
    api,
  )
  if (!current || current.id !== selected.id) {
    fail('selected draft was replaced or disappeared')
  }
  for (const old of original.assets) {
    const actual = current.assets.find((row) => row.name === old.name)
    if (!actual || canonical(actual) !== canonical(old)) {
      fail('selected uploaded asset changed')
    }
  }
  if (!allowAdditions && canonical(current) !== canonical(original)) {
    fail('draft inventory changed during verification')
  }
  return current
}

async function readSnapshot(path: string): Promise<ApplicationDraft> {
  const info = await Deno.lstat(path)
  if (!info.isFile || info.isSymlink || info.size > 1024 * 1024) {
    fail('invalid snapshot file')
  }
  return JSON.parse(await Deno.readTextFile(path))
}

/** The final staged inventory must contain exactly the manifest's subjects and
 * their bundle aliases. Staging additions cannot become unverified extras. */
export async function completeApplicationDraft(
  selected: ApplicationDraft,
  manifest: unknown,
  api: DraftApi = githubQualificationAdapter(),
): Promise<ApplicationDraft> {
  const value = manifest as {
    schema_version?: unknown
    version?: unknown
    source?: { commit?: unknown }
    assets?: { name: string; size: number; sha256: string }[]
    unsigned?: unknown
    artifact_kind?: unknown
  } | null
  if (
    !value || value.schema_version !== 2 || value.unsigned ||
    value.artifact_kind ||
    `v${value.version}` !== selected.tag_name ||
    value.source?.commit !== selected.target_commitish ||
    !Array.isArray(value.assets) || value.assets.length === 0
  ) fail('manifest identity differs from selected draft')
  const subjects = ['release-manifest.json', 'SHA256SUMS']
  for (const row of value.assets) {
    if (
      !row || typeof row.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(row.name) ||
      row.name.endsWith('.intoto.jsonl') || !positive(row.size) ||
      typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
    ) fail('invalid manifest subject')
    subjects.push(row.name)
  }
  if (new Set(subjects).size !== subjects.length) {
    fail('duplicate manifest subject')
  }
  const expected = [
    ...subjects,
    ...subjects.map((name) => `${name}.intoto.jsonl`),
  ].sort()
  const current = await checkApplicationDraft(selected, true, api)
  if (
    canonical(current.assets.map((row) => row.name).sort()) !==
      canonical(expected)
  ) {
    fail('complete draft inventory differs from attested subjects')
  }
  for (const wanted of value.assets) {
    const actual = current.assets.find((row) => row.name === wanted.name)!
    if (
      actual.size !== wanted.size || actual.digest !== `sha256:${wanted.sha256}`
    ) {
      fail('staged payload metadata differs from manifest')
    }
  }
  return current
}

export async function applicationDraftCommand(
  args: string[],
  api: DraftApi = githubQualificationAdapter(),
) {
  const [action, ...rest] = args
  if ((action === 'find' || action === 'require') && rest.length === 2) {
    const draft = await findApplicationDraft(rest[0], rest[1], api)
    if (action === 'require' && draft === null) {
      fail('created draft was not found')
    }
    return draft
  }
  if ((action === 'extend' || action === 'verify') && rest.length === 1) {
    return await checkApplicationDraft(
      await readSnapshot(rest[0]),
      action === 'extend',
      api,
    )
  }
  if (action === 'complete' && rest.length === 2) {
    const info = await Deno.lstat(rest[1])
    if (!info.isFile || info.isSymlink || info.size > 16 * 1024 * 1024) {
      fail('invalid manifest file')
    }
    return await completeApplicationDraft(
      await readSnapshot(rest[0]),
      JSON.parse(await Deno.readTextFile(rest[1])),
      api,
    )
  }
  return fail(
    'usage: find|require TAG SOURCE | extend|verify SNAPSHOT | complete SNAPSHOT MANIFEST',
  )
}
if (import.meta.main) {
  await Deno.stdout.write(
    canonicalQualificationBytes(await applicationDraftCommand(Deno.args)),
  )
}
