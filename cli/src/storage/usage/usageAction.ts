import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import { storageUsage, StorageApiError } from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { Row, Table } from '@cliffy/table'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const usageAction = async () => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching storage usage...'))
  spinner.start()

  try {
    const usage = await storageUsage(apiKey)
    spinner.succeed('Storage Usage')

    const usedPercent = usage.storageLimitBytes > 0
      ? ((usage.usedBytes / usage.storageLimitBytes) * 100).toFixed(1)
      : '0'

    const table = new Table()
    table.body([
      new Row(colors.blue('Region'), colors.white(usage.region)).border(true),
      new Row(
        colors.blue('Used'),
        colors.white(
          `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.storageLimitBytes)} (${usedPercent}%)`,
        ),
      ).border(true),
      new Row(
        colors.blue('Files'),
        colors.white(String(usage.fileCount)),
      ).border(true),
      new Row(
        colors.blue('Egress'),
        colors.white(formatBytes(usage.egressBytes)),
      ).border(true),
    ])

    console.log('')
    table.render()
    return true
  } catch (error) {
    spinner.fail('Failed to get usage')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}
