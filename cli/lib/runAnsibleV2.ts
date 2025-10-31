import { spawnSync } from '@elsoul/child-process'

const runAnsibleV2 = async (
  filePath: string,
  inventoryPath: string,
  limit?: string, // Identity account
  extraVars?: Record<string, string>,
) => {
  let cmd = `ansible-playbook -i ${inventoryPath} -u solv ${filePath}`
  if (limit) {
    cmd += ` --limit ${limit}`
  }
  if (extraVars) {
    for (const [key, value] of Object.entries(extraVars)) {
      cmd += ` --extra-vars "${key}=${value}"`
    }
  }
  console.log(`🚀 Running ansible: ${cmd}`)
  const result = await spawnSync(cmd)
  if (!result.success) {
    console.error(
      '❌ Failed to run ansible. Please check the logs.',
    )
    return false
  }
  console.log('✔︎ Success')
  return true
}

export { runAnsibleV2 }
