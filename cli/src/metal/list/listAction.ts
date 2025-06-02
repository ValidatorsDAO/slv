import { prompt, Select } from '@cliffy/prompt'
import { getMetals, type MetalType } from '/src/metal/getMetals.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { DISCORD_LINK } from '@cmn/constants/url.ts'
import { Row, Table } from '@cliffy/table'
import { extractSpecValue } from '/lib/extractSpecValue.ts'

const listAction = async (defaultMetalType?: MetalType) => {
  const app = '📦 APP - For Trade Bot,Testnet Validator, DApp and More!'
  const rpc = '⚡️ RPC - For Solana RPC Node'
  const mainnet = '💰 For Solana Mainnet Validator'
  let metalType: MetalType = 'APP'
  if (defaultMetalType) {
    metalType = defaultMetalType
  } else {
    const { bareMetalType } = await prompt([
      {
        name: 'bareMetalType',
        message: '🛡️ Select SLV BareMetal Type',
        type: Select,
        options: [
          app,
          rpc,
          mainnet,
        ],
        default: 'APP',
      },
    ])

    switch (bareMetalType) {
      case app:
        metalType = 'APP'
        break
      case rpc:
        metalType = 'RPC'
        break
      case mainnet:
        metalType = 'MV'
        break
      default:
        metalType = 'APP'
        break
    }
  }

  const apiKey = await getApiKeyFromYml()
  console.log(colors.yellow('🔍 Searching for SLV BareMetals...'))
  const metals = await getMetals(apiKey, metalType)
  if (!metals.success) {
    console.log(colors.yellow('Please try again later...'))
    return false
  }
  const metalProducts = metals.message
  if (metalProducts.length === 0) {
    console.log(
      colors.white(`🙇 Sold out❗️ Please wait for the next arrival 🙏`),
    )
    return false
  }
  const options = metalProducts.map((product) => {
    const regions = extractSpecValue(product.description, 'Region') || 'None'
    return {
      name: colors.white(
        product.product + '- 🌏' + regions + ' - ' +
          product.price.toLocaleString('en-US') + ' €/month',
      ),
      value: product.product,
    }
  })
  const { productName } = await prompt([
    {
      name: 'productName',
      message: '🛡️ Select a SLV BareMetal to Purchase',
      type: Select,
      options,
    },
  ])
  const productInfo = metalProducts.find((product) =>
    product.product === productName
  )
  if (!productInfo) {
    console.log(colors.red('Failed to get product info'))
    return false
  }
  const { paymentLink } = productInfo
  // Show Product Details with Figure
  const table = new Table()
  const regions = extractSpecValue(productInfo.description, 'Region') || 'None'
  const cpu = extractSpecValue(productInfo.description, 'CPU') || 'None'
  const ram = extractSpecValue(productInfo.description, 'RAM') || 'None'
  const disk = extractSpecValue(productInfo.description, 'Disk') || 'None'
  const nics = extractSpecValue(productInfo.description, 'NIC') || 'None'
  table.body([
    new Row(colors.blue('Product Name'), colors.white(productInfo.product))
      .border(true),
    new Row(colors.blue('Available Region'), colors.white(regions)).border(
      true,
    ),
    new Row(colors.blue('CPU'), colors.white(cpu)).border(true),
    new Row(colors.blue('RAM'), colors.white(ram)).border(true),
    new Row(colors.blue('Disk'), colors.white(disk)).border(true),
    new Row(colors.blue('Network'), colors.white(nics)).border(
      true,
    ),
    new Row(
      colors.blue('Price'),
      colors.white('€' + productInfo.price + '/month'),
    )
      .border(true),
  ])
  table.render()
  console.log('')

  const text = `🔗 Payment Link: 
${paymentLink}

After completing the payment, you will be able to register your SSH public key with the following command:

$ slv metal status

Login information will appear within a few minutes to an hour after registering your key.

If the login details don’t show up after some time, please reach out via a support ticket on Discord.

ValidatorsDAO Discord: ${DISCORD_LINK}`
  console.log(colors.white(text))
  return true
}

export { listAction }
