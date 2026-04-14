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

export const upgradeAction = async (
  quantity?: number,
  options: { yes?: boolean } = {},
) => {
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

    // Get new quantity (in GB, must be multiple of 5)
    const GB_PER_UNIT = 5
    let newGB: number
    if (quantity !== undefined) {
      newGB = quantity
    } else if (options.yes) {
      // Non-interactive mode — refuse rather than falling into Input.prompt,
      // which would hang run_command. Agents must pass the quantity.
      console.log(
        colors.red(
          '\n❌ --yes was passed but no capacity was specified.',
        ),
      )
      console.log(
        colors.white(
          `   Usage: slv storage upgrade <GB> -y   (multiples of ${GB_PER_UNIT})\n`,
        ),
      )
      return false
    } else {
      const input = await Input.prompt({
        message: `New storage capacity in GB (multiples of ${GB_PER_UNIT}, e.g. 5, 10, 15)`,
      })
      newGB = Number(input)
    }

    // Validate
    if (!Number.isInteger(newGB) || newGB < GB_PER_UNIT) {
      console.log(
        colors.red(`\nInvalid input. Minimum ${GB_PER_UNIT} GB.`),
      )
      return false
    }

    if (newGB % GB_PER_UNIT !== 0) {
      console.log(
        colors.red(`\nCapacity must be a multiple of ${GB_PER_UNIT} GB (e.g. 5, 10, 15, 20).`),
      )
      return false
    }

    if (newGB === currentGB) {
      console.log(
        colors.yellow(`\nStorage is already ${currentGB} GB. No change needed.`),
      )
      return false
    }

    // Convert GB to units for API
    const newUnits = newGB / GB_PER_UNIT

    // Show change summary
    const action = newGB > currentGB ? 'upgrade' : 'downgrade'
    const currentPrice = currentGB / GB_PER_UNIT
    const newPrice = newUnits
    console.log(
      colors.white(
        `\n  Change: ${currentGB} GB (€${currentPrice}/mo) → ${newGB} GB (€${newPrice}/mo)\n  Stripe will automatically prorate the difference.\n`,
      ),
    )

    // Confirm (skipped under --yes so agents can run this end-to-end).
    if (!options.yes) {
      const confirmed = await Confirm.prompt({
        message: `Proceed with ${action}?`,
        default: true,
      })

      if (!confirmed) {
        console.log(
          colors.yellow(
            `\n${action.charAt(0).toUpperCase() + action.slice(1)} cancelled.`,
          ),
        )
        return false
      }
    } else {
      console.log(
        colors.yellow(
          `   --yes provided — proceeding with ${action} without confirmation.`,
        ),
      )
    }

    const upgradeSpinner = new Kia(colors.cyan('Updating storage plan...'))
    upgradeSpinner.start()

    try {
      const upgradeResult = await storageUpgradePlan(apiKey, newUnits)
      const prevGB = upgradeResult.message.previousQuantityGB || currentGB
      const resultGB = (upgradeResult.message.newQuantityGB || newUnits) * GB_PER_UNIT
      upgradeSpinner.succeed(
        `Storage updated: ${prevGB} GB → ${resultGB} GB`,
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
