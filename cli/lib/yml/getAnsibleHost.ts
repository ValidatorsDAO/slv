import { parse } from '@std/yaml'
import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

export async function getAnsibleHosts(
  inventoryType: InventoryType,
  limitArg: string,
): Promise<string[]> {
  const filePath = getInventoryPath(inventoryType)

  let yamlText: string
  try {
    yamlText = await Deno.readTextFile(filePath)
  } catch (e) {
    console.error(`❌ Failed to read inventory file: ${filePath}`)
    throw e
  }

  const data = parse(yamlText) as Record<string, any>
  const allHosts = data?.[inventoryType]?.hosts
  if (!allHosts) {
    console.error(`❌ No hosts found under inventory type: ${inventoryType}`)
    return []
  }

  // "all" の場合は全ての ansible_host を返す（空/未定義は除外）
  if (limitArg.trim().toLowerCase() === 'all') {
    return Object.values(allHosts)
      .map((h: any) => h?.ansible_host)
      .filter((v): v is string => Boolean(v))
  }

  // カンマ区切り対応（単体でもOK）
  const limits = limitArg.split(',').map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()

  for (const limit of limits) {
    const hostData = allHosts[limit]
    if (!hostData) {
      console.error(`❌ Host not found for limit: ${limit}`)
      continue
    }
    const ansibleHost = hostData.ansible_host
    if (!ansibleHost) {
      console.error(`⚠️ ansible_host not defined for ${limit}`)
      continue
    }
    if (!seen.has(ansibleHost)) {
      seen.add(ansibleHost)
      out.push(ansibleHost)
    }
  }

  return out
}
