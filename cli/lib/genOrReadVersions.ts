import { parse } from '@std/yaml'
import type { CmnType } from '@cmn/types/config.ts'
import { defaultVersionsYml } from '/lib/config/defaultVersionsYml.ts'
import { configRoot } from '@cmn/constants/path.ts'
import { join } from '@std/path'

const genOrReadVersions = async (): Promise<CmnType> => {
  const versionsPath = join(configRoot, 'versions.yml')
  try {
    await Deno.stat(versionsPath)
  } catch (_error) {
    await Deno.writeTextFile(
      versionsPath,
      defaultVersionsYml(),
    )
  }
  const versionsYml = await Deno.readTextFile(versionsPath)
  const versionsData = JSON.parse(
    JSON.stringify(parse(versionsYml)),
  ) as CmnType
  return versionsData
}

// We don't need updateVersions for now since we're using defaultVersionsYml

export { genOrReadVersions }
