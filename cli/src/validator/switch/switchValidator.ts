import { type InventoryHost, readInventoryHosts } from '/lib/targetGuard.ts'
import { validatorSigningRefusal } from '/lib/validatorSigningPolicy.ts'
import { spawnSync } from '@elsoul/child-process'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { swapValidatorHosts } from '/lib/swapValidatorHosts.ts'

type SwitchRunDeps = {
  readHosts: (type: InventoryType) => Promise<InventoryHost[]>
  run: (command: string) => Promise<boolean>
  swap: typeof swapValidatorHosts
}

const switchValidator = async (
  inventoryType: InventoryType,
  from: string,
  to: string,
  overrides: Partial<SwitchRunDeps> = {},
): Promise<boolean> => {
  const deps: SwitchRunDeps = {
    readHosts: readInventoryHosts,
    run: async (command) => (await spawnSync(command)).success,
    swap: swapValidatorHosts,
    ...overrides,
  }
  // Validate both endpoints before invoking any play that can demote the source.
  const hosts = await deps.readHosts(inventoryType)
  for (const name of [from, to]) {
    const host = hosts.find((candidate) => candidate.name === name)
    const refusal = host
      ? validatorSigningRefusal(host)
      : 'Inventory host was not found.'
    if (refusal) {
      console.error(`${name}: ${refusal} Nothing was switched.`)
      return false
    }
  }
  const inventoryPath = getInventoryPath(inventoryType)
  const templateRoot = getTemplatePath()
  const networkPath = inventoryType === 'mainnet_validators'
    ? 'mainnet-validator'
    : 'testnet-validator'
  const filePath =
    `${templateRoot}/ansible/${networkPath}/nodowntime_migrate.yml`
  const cmd =
    `ansible-playbook -i ${inventoryPath} ${filePath} -e source_host=${from} -e target_host=${to}`

  // Run the Ansible playbook to perform the switch
  const result = await deps.run(cmd)

  if (!result) {
    console.error('Failed to run Ansible playbook for validator switch')
    return false
  }

  // Swap the hosts in the inventory file
  const swapResult = await deps.swap(inventoryType, from, to)

  if (!swapResult) {
    console.error('Failed to swap validator hosts in inventory file')
    return false
  }

  return true
}

export { switchValidator }
