import { Confirm, Input } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import {
  storageProductList,
  storageUpgradePlan,
  StorageApiError,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const upgradeAction = async (quantity?: number) => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching current storage info...'))
  spinner.start()

  try {
    const result = await storageProductList(apiKey)
    if (!result.success) {
      spinner.fail('Failed to fetch storage info')
      console.log(colors.yellow('Please try again later...'))
      return false
    }
    spinner.succeed('Found storage info')

    if (!result.hasExistingStorage || !result.currentStorage) {
      console.log(
        colors.yellow(
          `\nNo existing storage subscription found.\nPurchase storage first:\n\n  $ ${colors.white('slv storage product')}\n`,
        ),
      )
      return false
    }

    const storage = result.currentStorage
    const currentGB = storage.currentQuantityGB

    console.log(
      colors.bold(
        `\n📦 Current Storage: ${currentGB} GB (Used: ${formatBytes(storage.usedBytes)})\n`,
      ),
    )

    // Get new quantity
    let newGB: number
    if (quantity !== undefined) {
      newGB = quantity
    } else {
      const input = await Input.prompt({
        message: 'New storage capacity (GB)',
      })
      newGB = Number(input)
    }

    // Validate
    if (!Number.isInteger(newGB) || newGB < 1) {
      console.log(
        colors.red('\nInvalid input. Please enter a positive integer (minimum 1 GB).'),
      )
      return false
    }

    if (newGB === currentGB) {
      console.log(
        colors.yellow(`\nStorage is already ${currentGB} GB. No change needed.`),
      )
      return false
    }

    // Show change summary
    const action = newGB > currentGB ? 'upgrade' : 'downgrade'
    console.log(
      colors.white(
        `\n  Change: ${currentGB} GB → ${newGB} GB\n  Stripe will automatically prorate the difference.\n`,
      ),
    )

    // Confirm
    const confirmed = await Confirm.prompt({
      message: `Proceed with ${action}?`,
      default: true,
    })

    if (!confirmed) {
      console.log(colors.yellow(`\n${action.charAt(0).toUpperCase() + action.slice(1)} cancelled.`))
      return false
    }

    const upgradeSpinner = new Kia(colors.cyan('Updating storage plan...'))
    upgradeSpinner.start()

    try {
      const upgradeResult = await storageUpgradePlan(apiKey, newGB)
      upgradeSpinner.succeed(
        `Storage updated: ${upgradeResult.message.previousQuantityGB} GB → ${upgradeResult.message.newQuantityGB} GB`,
      )

      if (upgradeResult.message.note) {
        console.log(colors.white(`  Note: ${upgradeResult.message.note}`))
      }
    } catch (error) {
      upgradeSpinner.fail('Failed to update storage')
      throw error
    }

    console.log(
      colors.gray(`\nNeed help? ValidatorsDAO Discord: ${DISCORD_LINK}`),
    )
    return true
  } catch (error) {
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}
