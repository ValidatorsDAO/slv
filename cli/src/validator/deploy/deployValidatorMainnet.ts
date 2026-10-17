import { runAnsilbe } from '/lib/runAnsible.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import { confirmDeploy } from '/lib/targetGuard.ts'
import { colors } from '@cliffy/colors'
import rpcLog from '/lib/config/rpcLog.ts'
import { listValidators } from '/src/validator/listValidators.ts'
import { getAnsibleHosts } from '/lib/yml/getAnsibleHost.ts'
import { registerBlsPubkey } from '/src/validator/registerBlsPubkey.ts'
import { refuseFdctlMainnetValidatorDeploy } from '/lib/fdctlMainnetGuard.ts'
import { refuseBelowFloorPins } from '/lib/versionFloor.ts'

const deployValidatorMainnet = async (limit?: string) => {
  // Alpenglow: Firedancer and Frankendancer are not supported on mainnet during
  // the migration, so such a host is not deployed.
  if (await refuseFdctlMainnetValidatorDeploy(limit)) return false
  // A client pinned below what Alpenglow runs on is not installed.
  if (await refuseBelowFloorPins('mainnet', 'validator')) return false
  const inventoryType = 'mainnet_validators'
  const templateRoot = getTemplatePath()
  await listValidators('mainnet', limit)
  const limitString = limit ? limit : 'all'
  const ansibleHosts = await getAnsibleHosts(inventoryType, limitString)
  if (!await confirmDeploy()) {
    console.log(colors.blue('Cancelled...🌝'))
    return false
  }
  const createUserYml = `${templateRoot}/ansible/mainnet-validator/init.yml`
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
    console.log('Successfully deployed validator on mainnet')
    rpcLog(ansibleHosts)
    // SIMD-0387: register the BLS public key on each vote account post-deploy.
    // No-op on mainnet until the feature gate is active there.
    try {
      await registerBlsPubkey('mainnet', limit)
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
  console.log('Failed to deploy validator on mainnet')
  return false
}

export { deployValidatorMainnet }
