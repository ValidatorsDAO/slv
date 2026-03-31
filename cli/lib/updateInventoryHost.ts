import { getInventoryPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import { genOrReadInventory } from '/lib/genOrReadInventory.ts'

const updateInventoryHost = async (
  inventoryType: InventoryType,
  hostKey: string,
  body: Record<string, unknown>,
) => {
  const inventoryPath = getInventoryPath(inventoryType)
  const inventory = await genOrReadInventory(inventoryType)

  if (!inventory[inventoryType].hosts) {
    inventory[inventoryType].hosts = {}
  }

  inventory[inventoryType].hosts[hostKey] = {
    ...inventory[inventoryType].hosts[hostKey],
    ...body,
  }

  await Deno.writeTextFile(inventoryPath, stringify(inventory))
  console.log(`✔ Inventory updated to ${inventoryPath}`)
}

export { updateInventoryHost }
