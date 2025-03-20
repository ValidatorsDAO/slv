import { join } from '@std/path'
import type { InventoryType } from '@cmn/types/config.ts'

export const homeDir = Deno.env.get('HOME')
export const configRoot = homeDir
  ? join(homeDir, '.slv')
  : join(Deno.cwd(), '.slv')
export const testnetValidatorConfigDir = join(configRoot, 'testnet-validator')
export const mainnetValidatorConfigDir = join(configRoot, 'mainnet-validator')
export const RelayerInventoryPath = join(configRoot, 'inventory.relayer.yml')
export const VERSIONS_PATH = join(configRoot, 'versions.yml')
export const getInventoryPath = (
  inventoryType: InventoryType,
) => {
  try {
    const splitString = inventoryType.split('_')
    if (splitString.length !== 2) {
      const path = join(configRoot, `inventory.${splitString[0]}.yml`)
      console.log('path', path)
      return path
    }
    return join(configRoot, `inventory.${splitString[0]}.${splitString[1]}.yml`)
  } catch (error) {
    throw new Error(`Failed to get inventory path: ${error}`)
  }

}
export const keyPath = join(configRoot, 'keys')
export const pwdConfigFilePath = join(configRoot, 'config.pwd.yml')
