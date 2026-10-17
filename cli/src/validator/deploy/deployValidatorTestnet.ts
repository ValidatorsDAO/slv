import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { confirmDeploy } from '/lib/targetGuard.ts'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listValidators } from '/src/validator/listValidators.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { registerBlsPubkey } from '/src/validator/registerBlsPubkey.ts'
import { refuseBelowFloorPins } from '/lib/versionFloor.ts'

const deployValidatorTestnet = async (limit?: string) => {
  // A client pinned below what Alpenglow runs on is not installed.
  if (await refuseBelowFloorPins('testnet', 'validator')) return false
  const inventoryType = 'testnet_validators'
  const templateRoot = getTemplatePath()
  await listValidators('testnet', limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  if (!await confirmDeploy()) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const createUserYml = `${templateRoot}/ansible/testnet-validator/init.yml`
  const result = await runAnsilbe(
    createUserYml,
    inventoryType,
    limit,
    undefined,
    {
      allHostsConfirmed: true,
    },
  )
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
