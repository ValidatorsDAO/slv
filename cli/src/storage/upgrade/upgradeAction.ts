import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { Confirm, Number as NumberPrompt } from '@cliffy/prompt'
import {
  storageProductList,
  storageUpgradePlan,
  StorageApiError,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const upgradeAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching current storage plan...'))
  spinner.start()

  try {
    const productRes = await storageProductList(apiKey)
    spinner.succeed('Storage plan loaded')

    if (!productRes.hasExistingStorage) {
      console.log(
        colors.yellow(
          '\nNo storage subscription found. Purchase storage first:\n  $ slv storage product',
        ),
      )
      return
    }

    const currentGB = productRes.currentStorage?.capacityGB ?? 0
    const usedBytes = productRes.currentStorage?.usedBytes ?? 0
    const capacityBytes = currentGB * 1024 * 1024 * 1024
    const usedPercent = capacityBytes > 0
      ? ((usedBytes / capacityBytes) * 100).toFixed(1)
      : '0'

    console.log('')
    console.log(colors.blue('📦 Current Storage'))
    console.log(
      `   Capacity: ${colors.white(String(currentGB) + ' GB')}`,
    )
    console.log(
      `   Used:     ${colors.white(`${formatBytes(usedBytes)} (${usedPercent}%)`)}`,
    )
    console.log('')

    const newQuantity = await NumberPrompt.prompt({
      message: 'New capacity (GB)',
      min: 1,
      max: 1000,
      validate: (value: number) => {
        if (value === currentGB) {
          return `Capacity is already ${currentGB} GB. Enter a different value.`
        }
        return true
      },
    })

    const confirmed = await Confirm.prompt(
      `Change capacity from ${currentGB} GB to ${newQuantity} GB? Stripe will prorate the difference.`,
    )

    if (!confirmed) {
      console.log(colors.yellow('\nUpgrade cancelled.'))
      return
    }

    const upgradeSpinner = new Kia(colors.cyan('Requesting capacity change...'))
    upgradeSpinner.start()

    const result = await storageUpgradePlan(apiKey, newQuantity)
    upgradeSpinner.succeed('Capacity change requested')

    if (result.success) {
      console.log(
        colors.green(
          '\n✅ Storage capacity change requested. New capacity will be reflected after payment processing.',
        ),
      )
      if (result.message.proratedAmount) {
        console.log(
          colors.white(
            `   Prorated amount: ${result.message.proratedAmount}`,
          ),
        )
      }
      console.log(
        colors.white(
          `   ${result.message.previousQuantity} GB → ${result.message.newQuantity} GB`,
        ),
      )
    } else {
      console.log(colors.red('\nFailed to change storage capacity.'))
    }
  } catch (error) {
    spinner.stop()
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
  }
}
