import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { uploadAction } from '/src/storage/upload/uploadAction.ts'
import { downloadAction } from '/src/storage/download/downloadAction.ts'
import { listStorageAction } from '/src/storage/list/listAction.ts'
import { deleteAction } from '/src/storage/delete/deleteAction.ts'
import { usageAction } from '/src/storage/usage/usageAction.ts'
import { productAction } from '/src/storage/product/productAction.ts'
import { upgradeAction } from '/src/storage/upgrade/upgradeAction.ts'
import { syncAction } from '/src/storage/sync/syncAction.ts'
import type { StorageRegion } from '/src/storage/api.ts'

const VALID_REGIONS: StorageRegion[] = ['eu', 'asia', 'us-east', 'us-west', 'oc']

const validateRegion = (region: string | undefined): StorageRegion | undefined => {
  // CLI option takes priority, then env var
  const resolved = region || Deno.env.get('SLV_STORAGE_REGION')
  if (!resolved) return undefined
  if (!VALID_REGIONS.includes(resolved as StorageRegion)) {
    console.log(
      colors.red(
        `Invalid region: "${resolved}". Valid regions: ${VALID_REGIONS.join(', ')}`,
      ),
    )
    Deno.exit(1)
  }
  return resolved as StorageRegion
}

const text = `ERPC Global Storage

Upload, download, list, and manage files in your ERPC Global Storage.

Regions: ${VALID_REGIONS.join(', ')} (default: eu)

Environment:
  SLV_STORAGE_REGION  Default region (overridden by --region)
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
  .command('delete', 'Delete files from cloud storage')
  .alias('rm')
  .arguments('[path:string]')
  .option(
    '-r, --region <region:string>',
    'Storage region',
  )
  .option('-p, --prefix <prefix:string>', 'Delete all files matching prefix')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options, path?: string) => {
    await deleteAction(path, {
      region: validateRegion(options.region),
      prefix: options.prefix,
      yes: options.yes,
    })
  })
  .command('usage', 'Show storage usage and quota')
  .option('-r, --region <region:string>', 'Storage region (omit to show all regions with data)')
  .action(async (options) => {
    await usageAction({ region: validateRegion(options.region) })
  })
  .command('product', 'Browse and purchase storage plans')
  .action(async () => {
    await productAction()
  })
  .command('upgrade', 'Change storage capacity (upgrade or downgrade)')
  .arguments('[quantity:number]')
  .option('-y, --yes', 'Skip confirmation prompts (non-interactive)')
  .action(async (options, quantity?: number) => {
    await upgradeAction(quantity, { yes: options.yes })
  })
  .command('sync', 'Reconcile storage usage with actual cloud data')
  .option('-r, --region <region:string>', 'Storage region')
  .action(async (options) => {
    await syncAction({ region: validateRegion(options.region) })
  })
