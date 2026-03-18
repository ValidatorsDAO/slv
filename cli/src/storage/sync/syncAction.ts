import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  storageSync,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { Row, Table } from '@cliffy/table'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const syncAction = async (options: { region?: StorageRegion }) => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Syncing storage usage with R2...'))
  spinner.start()

  try {
    const result = await storageSync(apiKey, options.region)

    if (result.corrected) {
      spinner.succeed('Storage usage corrected')
    } else {
      spinner.succeed('Storage usage is already in sync')
    }

    const table = new Table()

    if (result.corrected) {
      table.body([
        new Row(
          colors.blue('Before (DB)'),
          colors.white(
            `${formatBytes(result.dbUsedBytes)} / ${result.dbFileCount} files`,
          ),
        ).border(true),
        new Row(
          colors.blue('After (R2)'),
          colors.white(
            `${formatBytes(result.r2UsedBytes)} / ${result.r2FileCount} files`,
          ),
        ).border(true),
        new Row(
          colors.blue('Corrected'),
          colors.green('yes'),
        ).border(true),
      ])
    } else {
      table.body([
        new Row(
          colors.blue('Used'),
          colors.white(
            `${formatBytes(result.r2UsedBytes)} / ${result.r2FileCount} files`,
          ),
        ).border(true),
      ])
    }

    console.log('')
    table.render()
    return true
  } catch (error) {
    spinner.fail('Failed to sync storage')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}
