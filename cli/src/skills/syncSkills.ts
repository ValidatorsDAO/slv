import { colors } from '@cliffy/colors'
import { dirname, join } from '@std/path'

// Mirror of sh/install's install_skills(). Kept in lockstep so that
// `slv skills sync` and `slv upgrade` produce the same result.
export const SKILL_NAMES = [
  'slv-validator',
  'slv-rpc',
  'slv-grpc-geyser',
  'slv-benchmark',
  'slv-app',
  'slv-server-procurement',
] as const

// Top-level files fetched for every skill. These are the files the AI console
// actually reads at runtime (AGENT.md for sub-agent prompts, SKILL.md for the
// capability doc, skill.json for metadata). README.md is included for parity
// with the bash installer.
const TOP_LEVEL_FILES = ['AGENT.md', 'SKILL.md', 'README.md', 'skill.json']

// Auxiliary files fetched per skill. Path is relative to the skill root.
const AUX_FILES = ['scripts/setup.sh']

const BASE_URL =
  'https://raw.githubusercontent.com/ValidatorsDAO/slv/main/dist/oss-skills'

type SyncOptions = {
  // Re-download files even if the local copy already matches the remote hash.
  force?: boolean
  // Restrict sync to this subset of skill names.
  only?: readonly string[]
  // Silence informational logs (errors are still printed).
  quiet?: boolean
}

export type SyncResult = {
  updated: number
  unchanged: number
  added: number
  failed: number
  failedFiles: string[]
}

const home = (): string => {
  const h = Deno.env.get('HOME')
  if (!h) throw new Error('HOME environment variable is not set')
  return h
}

const skillsDir = (): string => `${home()}/.slv/skills`

// Fetch a single file with a short timeout and return its body, or null if
// the file is missing upstream. Network errors throw so the caller can decide
// whether to keep going.
const fetchRemote = async (url: string): Promise<Uint8Array | null> => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  return buf
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const readIfExists = async (path: string): Promise<Uint8Array | null> => {
  try {
    return await Deno.readFile(path)
  } catch {
    return null
  }
}

const writeFile = async (path: string, data: Uint8Array): Promise<void> => {
  await Deno.mkdir(dirname(path), { recursive: true })
  await Deno.writeFile(path, data)
}

type FileStatus = 'updated' | 'unchanged' | 'added' | 'missing-remote' | 'failed'

const syncOneFile = async (
  skill: string,
  relPath: string,
  options: SyncOptions,
): Promise<FileStatus> => {
  const url = `${BASE_URL}/${skill}/${relPath}`
  const localPath = join(skillsDir(), skill, relPath)

  let remote: Uint8Array | null
  try {
    remote = await fetchRemote(url)
  } catch (err) {
    if (!options.quiet) {
      console.log(
        colors.red(`  ✖ ${skill}/${relPath} — ${(err as Error).message}`),
      )
    }
    return 'failed'
  }

  if (remote === null) return 'missing-remote'

  const local = await readIfExists(localPath)
  if (local && !options.force && bytesEqual(local, remote)) {
    return 'unchanged'
  }
  const wasAdded = local === null
  await writeFile(localPath, remote)
  return wasAdded ? 'added' : 'updated'
}

export const syncSkills = async (
  options: SyncOptions = {},
): Promise<SyncResult> => {
  const targets = options.only && options.only.length > 0
    ? SKILL_NAMES.filter((s) => options.only!.includes(s))
    : SKILL_NAMES

  if (targets.length === 0) {
    throw new Error('No matching skills to sync')
  }

  const result: SyncResult = {
    updated: 0,
    unchanged: 0,
    added: 0,
    failed: 0,
    failedFiles: [],
  }

  if (!options.quiet) {
    console.log(
      colors.bold.rgb24(
        `Syncing AI agent skills from ${BASE_URL}`,
        0x14f195,
      ),
    )
  }

  for (const skill of targets) {
    const files = [...TOP_LEVEL_FILES, ...AUX_FILES]
    const perSkill = { updated: 0, unchanged: 0, added: 0, failed: 0 }
    for (const rel of files) {
      const status = await syncOneFile(skill, rel, options)
      switch (status) {
        case 'updated':
          result.updated++
          perSkill.updated++
          break
        case 'added':
          result.added++
          perSkill.added++
          break
        case 'unchanged':
          result.unchanged++
          perSkill.unchanged++
          break
        case 'failed':
          result.failed++
          perSkill.failed++
          result.failedFiles.push(`${skill}/${rel}`)
          break
        case 'missing-remote':
          // Silent — some skills don't ship every aux file (e.g. skills
          // without scripts/setup.sh). This is expected.
          break
      }
    }

    if (!options.quiet) {
      const parts: string[] = []
      if (perSkill.added > 0) {
        parts.push(colors.green(`${perSkill.added} added`))
      }
      if (perSkill.updated > 0) {
        parts.push(colors.yellow(`${perSkill.updated} updated`))
      }
      if (perSkill.unchanged > 0) {
        parts.push(colors.gray(`${perSkill.unchanged} unchanged`))
      }
      if (perSkill.failed > 0) {
        parts.push(colors.red(`${perSkill.failed} failed`))
      }
      const summary = parts.length > 0 ? parts.join(', ') : colors.gray('no files')
      console.log(`  ${colors.bold(skill)}  ${summary}`)
    }
  }

  if (!options.quiet) {
    const touched = result.added + result.updated
    if (touched === 0 && result.failed === 0) {
      console.log(colors.green('\n✔ All skills are already up to date.'))
    } else if (result.failed === 0) {
      console.log(
        colors.green(
          `\n✔ Skills synced: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged.`,
        ),
      )
    } else {
      console.log(
        colors.yellow(
          `\n⚠ Skills synced with ${result.failed} failure(s): ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged.`,
        ),
      )
    }
    console.log(colors.gray(`  Installed to: ${skillsDir()}/`))
  }

  return result
}
