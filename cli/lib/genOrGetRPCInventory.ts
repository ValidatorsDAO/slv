import { getInventoryPath } from '@cmn/constants/path.ts'
import type {
  InventoryDevnetRPC,
  InventoryRPC,
  InventoryTestnetRPC,
  InventoryType,
  NetworkType,
} from '@cmn/types/config.ts'
import { parse } from '@std/yaml'
import { defaultInventory } from '/lib/config/defaultInventory.ts'

const genOrGetRPCInventory = async (network: NetworkType) => {
  const inventoryType = network + '_rpcs' as InventoryType
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
  return inventoryData as
    | InventoryRPC
    | InventoryDevnetRPC
    | InventoryTestnetRPC
}

export { genOrGetRPCInventory }
