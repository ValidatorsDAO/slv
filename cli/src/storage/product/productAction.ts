import { prompt, Select } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { Row, Table } from '@cliffy/table'
import {
  storageProductList,
  StorageApiError,
} from '/src/storage/api.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

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

    const products = result.message
    if (products.length === 0) {
      console.log(colors.yellow('\nNo storage products available.'))
      return false
    }

    let selected = products[0]
    if (products.length > 1) {
      const options = products.map((p) => ({
        name: colors.white(
          `${p.product} - ${p.price.toLocaleString('en-US')} EUR/GB/month`,
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
        colors.white(`${selected.price.toLocaleString('en-US')} EUR/GB/month`),
      ).border(true),
      new Row(
        colors.blue('Includes'),
        colors.white('1,000 API requests/GB/month, free egress (e.g. 5GB = 5,000 req)'),
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
