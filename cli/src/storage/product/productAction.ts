import { prompt, Select } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { Row, Table } from '@cliffy/table'
import {
  storageProductList,
  StorageApiError,
  type StorageProduct,
} from '/src/storage/api.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export const productAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching storage products...'))
  spinner.start()

  try {
    const result = await storageProductList(apiKey)
    if (!result.success) {
      spinner.fail('Failed to fetch products')
      console.log(colors.yellow('Please try again later...'))
      return false
    }
    spinner.succeed('Found storage products')

    // If user already has storage, show upgrade info
    if (result.hasExistingStorage && result.currentStorage) {
      const storage = result.currentStorage
      const usedPercent = storage.storageLimitBytes > 0
        ? ((storage.usedBytes / storage.storageLimitBytes) * 100).toFixed(1)
        : '0'

      console.log(colors.bold('\n📦 Current Storage\n'))
      const table = new Table()
      table.body([
        new Row(colors.blue('Capacity'), colors.white(`${storage.currentQuantityGB} GB`))
          .border(true),
        new Row(
          colors.blue('Used'),
          colors.white(`${formatBytes(storage.usedBytes)} (${usedPercent}%)`),
        ).border(true),
      ])
      table.render()

      console.log(
        colors.white(`
To change your storage capacity, run:

  $ ${colors.yellow('slv storage upgrade')}

Stripe will automatically prorate the difference.

Need help? ValidatorsDAO Discord: ${DISCORD_LINK}`),
      )
      return true
    }

    // New user — show products for purchase
    const products: StorageProduct[] = Array.isArray(result.message)
      ? result.message
      : []

    if (products.length === 0) {
      console.log(colors.yellow('\nNo storage products available.'))
      return false
    }

    let selected = products[0]
    if (products.length > 1) {
      const options = products.map((p) => ({
        name: colors.white(
          `${p.product} - ${p.price.toLocaleString('en-US')} EUR / 5 GB / month`,
        ),
        value: p.product,
      }))

      const { productName } = await prompt([
        {
          name: 'productName',
          message: 'Select a Storage plan to purchase',
          type: Select,
          options,
        },
      ])

      const found = products.find((p) => p.product === productName)
      if (!found) {
        console.log(colors.red('Failed to get product info'))
        return false
      }
      selected = found
    }

    const table = new Table()
    table.body([
      new Row(colors.blue('Product'), colors.white(selected.product))
        .border(true),
      new Row(
        colors.blue('Price'),
        colors.white(`${selected.price.toLocaleString('en-US')} EUR / 5 GB / month`),
      ).border(true),
      new Row(
        colors.blue('Includes'),
        colors.white('1,000 requests per 5 GB/month, free egress'),
      ).border(true),
      new Row(
        colors.blue('Regions'),
        colors.white('EU, Asia, US-East, US-West, Oceania'),
      ).border(true),
      new Row(
        colors.blue('Capacity'),
        colors.white('Choose at checkout, adjust anytime'),
      ).border(true),
    ])
    table.render()

    console.log(
      colors.white(`
Payment Link:
${selected.paymentLink}

After purchase, your storage will be activated automatically.
You can check your usage with:

$ slv storage usage

Need help? ValidatorsDAO Discord: ${DISCORD_LINK}`),
    )
    return true
  } catch (error) {
    spinner.fail('Failed to fetch products')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}
