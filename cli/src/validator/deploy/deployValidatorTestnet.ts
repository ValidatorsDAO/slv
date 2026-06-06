import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { Confirm, prompt } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listValidators } from '/src/validator/listValidators.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { registerBlsPubkey } from '/src/validator/registerBlsPubkey.ts'

const deployValidatorTestnet = async (limit?: string) => {
  const inventoryType = 'testnet_validators'
  const templateRoot = getTemplatePath()
  await listValidators('testnet', limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  const confirm = await prompt([{
    type: Confirm,
    name: 'continue',
    message: 'Do you want to continue?',
    default: true,
  }])
  if (!confirm.continue) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const createUserYml = `${templateRoot}/ansible/testnet-validator/init.yml`
  const result = limit
    ? await runAnsilbe(createUserYml, inventoryType, limit)
    : await runAnsilbe(createUserYml, inventoryType)
  if (result) {
    console.log('Successfully deployed validator on testnet')
    rpcLog(ansibleHosts)
    // SIMD-0387: register the BLS public key on each vote account post-deploy.
    try {
      await registerBlsPubkey('testnet', limit)
    } catch (e) {
      console.warn(
        colors.yellow(
          `⚠️ BLS pubkey registration skipped: ${
            e instanceof Error ? e.message : e
          }`,
        ),
      )
    }
    return true
  }
  console.log('Failed to deploy validator on testnet')
  return false
}

export { deployValidatorTestnet }
