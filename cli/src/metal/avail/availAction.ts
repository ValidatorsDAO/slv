import { prompt, Select } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { Row, Table } from '@cliffy/table'
import { metalAvailability } from '/src/metal/api.ts'
import { REGIONS, REGION_LABELS, type Region } from '/src/metal/regions.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

const availAction = async () => {
  const apiKey = await getApiKeyFromYml()
  const spinner = new Kia(colors.cyan('🔍 Checking availability across all regions...'))
  spinner.start()

  // Fetch availability for all regions in parallel
  const results = await Promise.allSettled(
    REGIONS.map(async (region) => {
      const res = await metalAvailability(apiKey, region)
      return { region, data: res }
    }),
  )

  const available: { region: Region; count: number; servers: any[] }[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.data.success) {
      const servers = result.value.data.message || []
      if (servers.length > 0) {
        available.push({
          region: result.value.region,
          count: servers.length,
          servers,
        })
      }
    }
  }

  spinner.succeed('Availability check complete')

  if (available.length === 0) {
    console.log(colors.yellow('\n⚠️ No stock available in any region at this time.'))
    console.log(colors.white('Please check back later or contact support.'))
    return false
  }

  // Display availability summary table
  console.log('')
  const summaryTable = new Table()
  summaryTable.body(
    available.map((r) =>
      new Row(
        colors.blue(REGION_LABELS[r.region] || r.region),
        colors.green(`${r.count} server${r.count > 1 ? 's' : ''} available`),
      ).border(true)
    ),
  )
  summaryTable.render()
  console.log('')

  // Let user select a region to see details
  const regionOptions = available.map((r) => ({
    name: colors.white(`${REGION_LABELS[r.region] || r.region} (${r.count} available)`),
    value: r.region,
  }))

  const { selectedRegion } = await prompt([
    {
      name: 'selectedRegion',
      message: '🌏 Select a region to view server details',
      type: Select,
      options: regionOptions,
    },
  ])

  const regionData = available.find((r) => r.region === selectedRegion)
  if (!regionData) {
    console.log(colors.red('Failed to get region data'))
    return false
  }

  // Display server details for selected region
  console.log(colors.white(`\n📦 Available servers in ${REGION_LABELS[regionData.region]}:\n`))
  for (const server of regionData.servers) {
    const table = new Table()
    table.body([
      new Row(colors.blue('Product'), colors.white(server.product || server.productName || '-')).border(true),
      new Row(colors.blue('CPU'), colors.white(server.cpu || '-')).border(true),
      new Row(colors.blue('RAM'), colors.white(server.ram || '-')).border(true),
      new Row(colors.blue('Disk'), colors.white(server.disk || '-')).border(true),
      new Row(colors.blue('Network'), colors.white(server.nic || server.nics || '-')).border(true),
      new Row(colors.blue('Price'), colors.white(server.price ? `€${server.price}/month` : '-')).border(true),
    ])
    table.render()
    if (server.paymentLink) {
      console.log(colors.white(`🔗 Purchase: ${server.paymentLink}`))
    }
    console.log('')
  }

  return true
}

export { availAction }
