import { getInventoryPath } from '@cmn/constants/path.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type {
  InventoryType,
  ValidatorMainnetConfig,
} from '@cmn/types/config.ts'
import { genOrReadMainnetInventory } from '/lib/genOrReadMainnetInventory.ts'
import { mainnetValidatorTypeRefusal } from '/lib/fdctlMainnetGuard.ts'

const updateMainnetInventory = async (
  identityAccount: string,
  body: Partial<ValidatorMainnetConfig>,
) => {
  // A mainnet voting validator entry is never written with a Firedancer or
  // Frankendancer type. This stops before the inventory file is touched.
  const refusal = mainnetValidatorTypeRefusal(String(body.validator_type ?? ''))
  if (refusal) throw new Error(refusal)

  const inventoryType: InventoryType = 'mainnet_validators'
  const inventoryPath = getInventoryPath(inventoryType)
  const inventory = await genOrReadMainnetInventory()

  // Initialize hosts if it's null or undefined
  if (!inventory[inventoryType].hosts) {
    inventory[inventoryType].hosts = {}
  }

  inventory[inventoryType].hosts[identityAccount] = {
    ...inventory[inventoryType].hosts[identityAccount],
    ...body,
  }
  await Deno.writeTextFile(inventoryPath, stringify(inventory))
  console.log(`✔ Inventory updated to ${inventoryPath}`)
}

export { updateMainnetInventory }
