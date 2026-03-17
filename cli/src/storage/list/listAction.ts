import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  storageList,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { Row, Table } from '@cliffy/table'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const listStorageAction = async (
  options: { prefix?: string; region?: StorageRegion; limit?: number },
) => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching file list...'))
  spinner.start()

  try {
    let allFiles: { path: string; size: number; lastModified: string }[] = []
    let cursor: string | undefined
    let truncated = true

    while (truncated) {
      const result = await storageList(apiKey, {
        prefix: options.prefix,
        region: options.region,
        limit: options.limit,
        cursor,
      })
      allFiles = allFiles.concat(result.files)
      cursor = result.cursor
      truncated = result.truncated
      if (options.limit) break
    }

    spinner.succeed(`Found ${allFiles.length} file(s)`)

    if (allFiles.length === 0) {
      console.log(colors.yellow('\nNo files found.'))
      return true
    }

    const table = new Table()
    table.header(
      Row.from([
        colors.blue('Path'),
        colors.blue('Size'),
        colors.blue('Last Modified'),
      ]).border(true),
    )

    const rows: Row[] = []
    for (const file of allFiles) {
      const date = new Date(file.lastModified)
      const dateStr = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
      rows.push(
        new Row(
          colors.white(file.path),
          colors.green(formatBytes(file.size)),
          colors.gray(dateStr),
        ).border(true),
      )
    }
    table.body(rows)

    console.log('')
    table.render()

    if (truncated) {
      console.log(
        colors.yellow('\n(Results truncated. Use --limit to adjust.)'),
      )
    }

    return true
  } catch (error) {
    spinner.fail('Failed to list files')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}
