import { prompt, Select } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { Row, Table } from '@cliffy/table'
import { getStatus } from '/src/metal/getStatus.ts'
import type { z } from '@hono/zod-openapi'
import type { BareMetalStatus, ServerStatusEnumType } from '@cmn/types/metal.ts'
import { extractSpecValue } from '/lib/extractSpecValue.ts'
import { serverStatusEmojiMap } from '@cmn/types/metal.ts'

const rebuildAction = async () => {
  const apiKey = await getApiKeyFromYml()
  console.log(colors.cyan('🔍 Searching for SLV BareMetals...'))
  const metals = await getStatus(apiKey)
  if (!metals.success) {
    console.log(colors.red('Failed to get Metals\nPlease try again later'))
    return false
  }

  const myMetals = metals.message

  if (myMetals.length === 0) {
    console.log(colors.yellow('⚠️ No Bare Metals found'))
    return true
  }
  const options = myMetals.map((product) => {
    const emoji =
      serverStatusEmojiMap[product.status as ServerStatusEnumType] ||
      '❓'
    const regions = extractSpecValue(product.description, 'Region') || 'None'
    let name = product.productName + '- 🌏' + regions + ' - ' + emoji + ' ' +
      product.status
    if (product.status === 'on') name += `- ${product.ip}`
    return {
      name: colors.white(name),
      value: product.ip,
    }
  })
  const { nodeIP } = await prompt([
    {
      name: 'nodeIP',
      message: '⚔️ Select a SLV BareMetal to View Status',
      type: Select,
      options,
    },
  ])
  const selectedMetal = myMetals.find((metal) => metal.ip === nodeIP)
  if (!selectedMetal) {
    console.log(colors.red('Failed to get selected metal info'))
    return false
  }
  console.log(colors.white('Your SLV BareMetal Resources:'))

  // Display each metal in a table format
  displayMetalTable(selectedMetal)

  return true
}

/**
 * Display a single metal subscription in a table format
 */
const displayMetalTable = (metal: z.infer<typeof BareMetalStatus>) => {
  const table = new Table()

  // Format dates for better readability
  const startDate = new Date(metal.startDate).toLocaleString()
  const endDate = new Date(metal.nextPaymentDate).toLocaleString()
  const username = metal.username || 'root'
  const ip = metal.ip || '-'
  const emoji = serverStatusEmojiMap[metal.status as ServerStatusEnumType] ||
    '❓'
  // Format price to show as currency
  const formattedPrice = `€${metal.price.toLocaleString('en-US')}`
  // Create table with rows for each property
  table.body([
    new Row(colors.blue('Product Name'), colors.white(metal.productName))
      .border(true),
    new Row(
      colors.blue('Status'),
      emoji + ' ' + getStatusWithColor(metal.status as ServerStatusEnumType),
    ).border(
      true,
    ),
    new Row(colors.blue('IP'), colors.white(ip)).border(true),
    new Row(colors.blue('Username'), colors.white(username)).border(true),
    new Row(colors.blue('Password'), colors.white(metal.password || '-'))
      .border(
        true,
      ),
    new Row(colors.blue('Type'), colors.white(metal.tags || 'None')).border(
      true,
    ),
    new Row(colors.blue('Region'), colors.white(metal.region)).border(true),
    new Row(colors.blue('OS'), colors.white(metal.os)).border(true),
    new Row(colors.blue('CPU'), colors.white(metal.cpu || '-')).border(true),
    new Row(colors.blue('RAM'), colors.white(metal.ram || '-')).border(true),
    new Row(colors.blue('Disk'), colors.white(metal.disk || '-')).border(true),
    new Row(colors.blue('Network'), colors.white(metal.nic || '-')).border(
      true,
    ),
    new Row(colors.blue('Price'), colors.white(formattedPrice + '/month'))
      .border(true),
    new Row(colors.blue('Start Date'), colors.white(startDate)).border(true),
    new Row(colors.blue('Next Payment Date'), colors.white(endDate)).border(
      true,
    ),
  ])

  table.render()
  console.log('') // Add empty line for better readability
}

/**
 * Get colored status text based on status value
 */
const getStatusWithColor = (status: ServerStatusEnumType) => {
  switch (status) {
    case 'on':
      return colors.green(status)
    case 'off':
      return colors.gray(status)
    case 'provisioning':
      return colors.cyan(status)
    case 'maintenance':
      return colors.yellow(status)
    case 'suspended':
      return colors.red(status)
    default:
      return colors.white(status)
  }
}

export { rebuildAction }
