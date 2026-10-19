import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { updateInventoryUser } from '/lib/updateInventoryUser.ts'
import type { InventoryType } from '@cmn/types/config.ts'

const genSolvUser = async (
  name: string,
  inventoryType: InventoryType,
) => {
  const templateRoot = getTemplatePath()
  const createUserYml = `${templateRoot}/ansible/cmn/create_user.yml`
  const result = await runAnsilbe(createUserYml, inventoryType, name)
  if (result) {
    // Update inventory.yml user 'ubuntu' to 'solv'
    await updateInventoryUser(name, inventoryType)
  }
  return result
}

export { genSolvUser }
