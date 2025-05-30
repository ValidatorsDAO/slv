import { Confirm, prompt, Select } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { getStatus } from '/src/metal/getStatus.ts'
import { cancelSubscription } from '/src/metal/cancelSubscription.ts'

const cancelAction = async () => {
  const apiKey = await getApiKeyFromYml()
  console.log(colors.yellow('🔍 Searching for Bare Metals...'))

  const metals = await getStatus(apiKey)
  if (metals.success) {
    const metalProducts = metals.message
    const options = metalProducts.map((product) => {
      const formattedPrice = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'EUR',
      }).format(product.price / 100).replaceAll('.00', '')
      const subsctiptionId = ''
      return {
        name: colors.white(
          product.productName + ' - ' + formattedPrice + ' €/month',
        ),
        value: subsctiptionId,
      }
    })
    const { cancelSubscriptionId } = await prompt([
      {
        name: 'cancelSubscriptionId',
        message: '🚫 Select Bare Metal Type to Cancel',
        type: Select,
        options,
      },
    ])
    if (!cancelSubscriptionId) {
      console.log(colors.red('🚫 No Bare Metal selected'))
      return false
    }
    const confirm = await prompt([{
      type: Confirm,
      name: 'value',
      message: colors.red(
        '⚠️ Are you sure you want to cancel this Bare Metal?\nThis action is irreversible. You will lose all data.\nPlease make sure to backup your data before proceeding.',
      ),
      default: false,
    }])
    if (!confirm.value) {
      console.log(colors.yellow('🚫 Cancel action aborted'))
      return false
    }
    console.log(colors.yellow('🔍 Cancelling Bare Metal...'))
    const res = await cancelSubscription(apiKey, cancelSubscriptionId)
    if (res.success) {
      console.log(colors.green('✅ Your Bare Metal Cancelled'))
      return true
    }
    console.log(
      colors.red('🚫 Failed to cancel Bare Metal\nPlease Try Again Later...'),
    )
  }

  return true
}

export { cancelAction }
