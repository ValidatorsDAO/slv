import { getInventoryPath } from '@cmn/constants/path.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import type { 
  InventoryType, 
  RpcConfig,
  NetworkType,
  InventoryRPC,
  InventoryDevnetRPC,
  InventoryTestnetRPC
} from '@cmn/types/config.ts'
import { genOrReadMainnetRPCInventory } from '/lib/genOrReadMainnetRPCInventory.ts'
import { genOrGetRPCInventory } from '/lib/genOrGetRPCInventory.ts'

const updateMainnetRPCInventory = async (
  identityAccount: string,
  body: Partial<RpcConfig>,
  network: NetworkType = 'mainnet',
) => {
  const inventoryType = `${network}_rpcs` as InventoryType
  const inventoryPath = getInventoryPath(inventoryType)
  
  const inventory = network === 'mainnet'
    ? await genOrReadMainnetRPCInventory()
    : await genOrGetRPCInventory(network)

  // Type guard to handle different inventory types
  let rpcData: any
  if (network === 'mainnet' && 'mainnet_rpcs' in inventory) {
    rpcData = (inventory as InventoryRPC).mainnet_rpcs
  } else if (network === 'devnet' && 'devnet_rpcs' in inventory) {
    rpcData = (inventory as InventoryDevnetRPC).devnet_rpcs
  } else if (network === 'testnet' && 'testnet_rpcs' in inventory) {
    rpcData = (inventory as InventoryTestnetRPC).testnet_rpcs
  } else {
    throw new Error(`Invalid network type: ${network}`)
  }

  // Initialize hosts if it's null or undefined
  if (!rpcData.hosts) {
    rpcData.hosts = {}
  }

  rpcData.hosts[identityAccount] = {
    ...rpcData.hosts[identityAccount],
    ...body,
  }
  
  await Deno.writeTextFile(inventoryPath, stringify(inventory))
  console.log(`✔ Inventory updated to ${inventoryPath}`)
}

export { updateMainnetRPCInventory }
