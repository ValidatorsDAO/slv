import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  storageUsage,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { Row, Table } from '@cliffy/table'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const usageAction = async (options?: { region?: StorageRegion }) => {
  const apiKey = await getApiKeyFromYml()

  const spinner = new Kia(colors.cyan('Fetching storage usage...'))
  spinner.start()

  try {
    const usage = await storageUsage(apiKey)
    spinner.succeed('Storage Usage')

    const regionFilter = options?.region

    // If --region is specified, show only that region from regionUsage
    if (regionFilter) {
      const entry = usage.regionUsage?.[regionFilter]
      const usedBytes = entry?.usedBytes ?? 0
      const fileCount = entry?.fileCount ?? 0
      const usedPercent = usage.storageLimitBytes > 0
        ? ((usedBytes / usage.storageLimitBytes) * 100).toFixed(1)
        : '0'

      const table = new Table()
      table.body([
        new Row(colors.blue('Region'), colors.white(regionFilter)).border(true),
        new Row(
          colors.blue('Used'),
          colors.white(
            `${formatBytes(usedBytes)} / ${formatBytes(usage.storageLimitBytes)} (${usedPercent}%)`,
          ),
        ).border(true),
        new Row(
          colors.blue('Files'),
          colors.white(String(fileCount)),
        ).border(true),
      ])

      console.log('')
      table.render()
      return true
    }

    // No --region: show per-region breakdown using regionUsage, then totals
    const regionUsage = usage.regionUsage || {}
    const activeRegions = Object.entries(regionUsage).filter(
      ([_, v]) => v.usedBytes > 0 || v.fileCount > 0,
    )

    if (activeRegions.length > 0) {
      for (const [region, entry] of activeRegions) {
        const usedPercent = usage.storageLimitBytes > 0
          ? ((entry.usedBytes / usage.storageLimitBytes) * 100).toFixed(1)
          : '0'

        const table = new Table()
        table.body([
          new Row(colors.blue('Region'), colors.white(region)).border(true),
          new Row(
            colors.blue('Used'),
            colors.white(
              `${formatBytes(entry.usedBytes)} / ${formatBytes(usage.storageLimitBytes)} (${usedPercent}%)`,
            ),
          ).border(true),
          new Row(
            colors.blue('Files'),
            colors.white(String(entry.fileCount)),
          ).border(true),
        ])

        console.log('')
        table.render()
      }
    }

    // Always show totals
    const totalPercent = usage.storageLimitBytes > 0
      ? ((usage.usedBytes / usage.storageLimitBytes) * 100).toFixed(1)
      : '0'

    const totalTable = new Table()
    totalTable.body([
      ...(activeRegions.length > 0
        ? [new Row(colors.blue(''), colors.bold(colors.white('── Total ──'))).border(true)]
        : []),
      new Row(
        colors.blue('Used'),
        colors.white(
          `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.storageLimitBytes)} (${totalPercent}%)`,
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
      ...(usage.monthlyAccessCount != null && usage.monthlyAccessLimit != null
        ? [
            new Row(
              colors.blue('Requests'),
              colors.white(
                `${usage.monthlyAccessCount.toLocaleString()} / ${usage.monthlyAccessLimit.toLocaleString()} (this month)`,
              ),
            ).border(true),
          ]
        : []),
    ])

    console.log('')
    totalTable.render()

    return true
  } catch (error) {
    spinner.fail('Failed to get usage')
    const msg = error instanceof StorageApiError ? error.message : String(error)
    console.log(colors.red(`\n  ${msg}`))
    if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no active')) {
      console.log(colors.gray('\n  No storage subscription found.'))
      console.log(colors.gray('  Run `slv st product` to browse available storage plans.\n'))
    }
    return false
  }
}
