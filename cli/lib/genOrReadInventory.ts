import { getInventoryPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import { parse } from 'https://deno.land/std@0.202.0/yaml/parse.ts'
import { defaultInventory } from '/lib/config/defaultInventory.ts'

const genOrReadInventory = async (
  inventoryType: InventoryType,
) => {
  const inventoryPath = getInventoryPath(inventoryType)
  try {
    await Deno.stat(inventoryPath)
  } catch (_error) {
    await Deno.writeTextFile(
      inventoryPath,
      defaultInventory(inventoryType),
    )
  }
  const inventory = await Deno.readTextFile(inventoryPath)
  const inventoryData = JSON.parse(
    JSON.stringify(parse(inventory)),
  )
  return inventoryData
}

export { genOrReadInventory }
