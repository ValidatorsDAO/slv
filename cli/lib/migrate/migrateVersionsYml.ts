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

/**
 * Best-effort migration for versions.yml:
 * - Ensures required keys exist (fills missing with defaults)
 * - Preserves user values and unknown keys
 * - Recovers from parse errors by backing up and restoring defaults
 */
export const migrateVersionsYml = async (): Promise<boolean> => {
  const defaults = defaultVersionsObject()
  let current: unknown = undefined
  let needsBackup = false

  try {
    const text = await Deno.readTextFile(VERSIONS_PATH)
    current = parse(text)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      needsBackup = true
      console.log(
        colors.yellow(
          'Warning: versions.yml parse failed. Restoring defaults and backing up the file.',
        ),
      )
    }
    current = defaults
  }

  if (!isRecord(current)) {
    current = defaults
    needsBackup = true
  }

  if (needsBackup) {
    try {
      const backupPath = `${VERSIONS_PATH}.bak.${Date.now()}`
      await Deno.rename(VERSIONS_PATH, backupPath)
      console.log(colors.dim(`Backed up invalid versions.yml -> ${backupPath}`))
    } catch (_error) {
      // Ignore backup failures to keep the migration non-fatal
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
    await Deno.writeTextFile(VERSIONS_PATH, yml)
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
