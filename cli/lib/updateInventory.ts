import { getInventoryPath } from '@cmn/constants/path.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type {
  InventoryType,
  ValidatorTestnetConfig,
} from '@cmn/types/config.ts'
import { genOrReadInventory } from '/lib/genOrReadInventory.ts'

const updateInventory = async (
  identityAccount: string,
  hostData: Partial<ValidatorTestnetConfig>,
) => {
  const inventoryType: InventoryType = 'testnet_validators'
  const inventoryPath = getInventoryPath(inventoryType)
  const inventory = await genOrReadInventory(inventoryType)

  // Initialize hosts if it's null or undefined
  if (!inventory[inventoryType].hosts) {
    inventory[inventoryType].hosts = {}
  }

  inventory[inventoryType].hosts[identityAccount] = {
    ...inventory[inventoryType].hosts[identityAccount],
    ...hostData,
  }
  await Deno.writeTextFile(inventoryPath, stringify(inventory))
  console.log(`✔ Inventory updated to ${inventoryPath}`)
}

export { updateInventory }
