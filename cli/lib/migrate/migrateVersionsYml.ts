import { parse, stringify } from '@std/yaml'
import { colors } from '@cliffy/colors'
import { VERSIONS_PATH } from '@cmn/constants/path.ts'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeDefaults = (defaults: unknown, current: unknown): unknown => {
  if (Array.isArray(defaults)) {
    return Array.isArray(current) ? current : [...defaults]
  }
  if (isRecord(defaults)) {
    const result: Record<string, unknown> = {}
    const currentObj = isRecord(current) ? current : {}
    for (const [key, defaultValue] of Object.entries(defaults)) {
      result[key] = mergeDefaults(defaultValue, currentObj[key])
    }
    for (const [key, currentValue] of Object.entries(currentObj)) {
      if (!(key in result)) {
        result[key] = currentValue
      }
    }
    return result
  }
  if (current === undefined || current === null) {
    return defaults
  }
  return current
}

const cleanObject = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value)) as T
}

type MigrationOperations = {
  readTextFile?: (path: string) => Promise<string>
  rename?: (oldpath: string, newpath: string) => Promise<void>
  writeTextFile?: (path: string, data: string) => Promise<void>
  now?: () => number
}

/**
 * Best-effort migration for versions.yml:
 * - Ensures required keys exist (fills missing with defaults)
 * - Preserves user values and unknown keys
 * - Recovers from parse errors by backing up and restoring defaults
 *
 * A value already in the file is never replaced by a newer default, so a
 * `slv upgrade` leaves the versions an operator pinned as they are.
 */
export const migrateVersionsYml = async (
  versionsPath: string = VERSIONS_PATH,
  operations: MigrationOperations = {},
): Promise<boolean> => {
  const readTextFile = operations.readTextFile ?? Deno.readTextFile
  const rename = operations.rename ?? Deno.rename
  const writeTextFile = operations.writeTextFile ?? Deno.writeTextFile
  const now = operations.now ?? Date.now
  const defaults = defaultVersionsObject()
  let current: unknown = undefined
  let needsBackup = false

  try {
    const text = await readTextFile(versionsPath)
    try {
      current = parse(text)
    } catch (_error) {
      needsBackup = true
      current = defaults
      console.log(
        colors.yellow(
          'Warning: versions.yml parse failed. Restoring defaults and backing up the file.',
        ),
      )
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      current = defaults
    } else {
      console.error(
        colors.red(
          `Failed to read versions.yml; leaving it unchanged: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
      return false
    }
  }

  if (!isRecord(current)) {
    current = defaults
    needsBackup = true
  }

  if (needsBackup) {
    const backupPath = `${versionsPath}.bak.${now()}`
    try {
      await rename(versionsPath, backupPath)
      console.log(colors.dim(`Backed up invalid versions.yml -> ${backupPath}`))
    } catch (error) {
      console.error(
        colors.red(
          `Failed to back up invalid versions.yml; leaving it unchanged: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
      return false
    }
  }

  const merged = mergeDefaults(defaults, current)
  const cleaned = cleanObject(merged)
  const yml = stringify(cleaned, {
    indent: 2,
    lineWidth: -1,
    useAnchors: false,
    compatMode: false,
  })

  try {
    await writeTextFile(versionsPath, yml)
    console.log(colors.green('versions.yml migrated'))
    return true
  } catch (error) {
    console.error(
      colors.red(
        `Failed to write versions.yml: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    )
    return false
  }
}
