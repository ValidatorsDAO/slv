import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { uploadAction } from '/src/storage/upload/uploadAction.ts'
import { downloadAction } from '/src/storage/download/downloadAction.ts'
import { listStorageAction } from '/src/storage/list/listAction.ts'
import { deleteAction } from '/src/storage/delete/deleteAction.ts'
import { usageAction } from '/src/storage/usage/usageAction.ts'
import { productAction } from '/src/storage/product/productAction.ts'
import { upgradeAction } from '/src/storage/upgrade/upgradeAction.ts'
import type { StorageRegion } from '/src/storage/api.ts'

const VALID_REGIONS: StorageRegion[] = ['eu', 'asia', 'us-east', 'us-west', 'oc']

const validateRegion = (region: string | undefined): StorageRegion | undefined => {
  if (!region) return undefined
  if (!VALID_REGIONS.includes(region as StorageRegion)) {
    console.log(
      colors.red(
        `Invalid region: "${region}". Valid regions: ${VALID_REGIONS.join(', ')}`,
      ),
    )
    Deno.exit(1)
  }
  return region as StorageRegion
}

const text = `Cloud Storage powered by Cloudflare R2

Upload, download, list, and manage files in your SLV Cloud Storage.

Regions: ${VALID_REGIONS.join(', ')} (default: eu)
`

export const storageCmd = new Command()
  .description(colors.white(text))
  .action(function () {
    this.showHelp()
    return
  })
  .command('upload', 'Upload a file to cloud storage')
  .arguments('[file:string]')
  .option('-p, --path <path:string>', 'Remote path (default: filename)')
  .option(
    '-r, --region <region:string>',
    'Storage region (eu, asia, us-east, us-west, oc)',
  )
  .action(async (options, file?: string) => {
    await uploadAction(file, {
      path: options.path,
      region: validateRegion(options.region),
    })
  })
  .command('download', 'Download a file from cloud storage')
  .alias('dl')
  .arguments('[path:string]')
  .option('-o, --output <output:string>', 'Local output path (default: filename)')
  .option(
    '-r, --region <region:string>',
    'Storage region',
  )
  .action(async (options, path?: string) => {
    await downloadAction(path, {
      output: options.output,
      region: validateRegion(options.region),
    })
  })
  .command('list', 'List files in cloud storage')
  .alias('ls')
  .option('-p, --prefix <prefix:string>', 'Filter by path prefix')
  .option(
    '-r, --region <region:string>',
    'Storage region',
  )
  .option('-l, --limit <limit:number>', 'Max files to return (default: all)')
  .action(async (options) => {
    await listStorageAction({
      prefix: options.prefix,
      region: validateRegion(options.region),
      limit: options.limit,
    })
  })
  .command('delete', 'Delete a file from cloud storage')
  .alias('rm')
  .arguments('[path:string]')
  .option(
    '-r, --region <region:string>',
    'Storage region',
  )
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options, path?: string) => {
    await deleteAction(path, {
      region: validateRegion(options.region),
      yes: options.yes,
    })
  })
  .command('usage', 'Show storage usage and quota')
  .action(async () => {
    await usageAction()
  })
  .command('product', 'Browse and purchase storage plans')
  .action(async () => {
    await productAction()
  })
  .command('upgrade', 'Change storage capacity (upgrade or downgrade)')
  .arguments('[quantity:number]')
  .action(async (_options, quantity?: number) => {
    await upgradeAction(quantity)
  })
