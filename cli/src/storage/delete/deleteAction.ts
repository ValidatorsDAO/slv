import { Confirm, prompt } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  storageDelete,
  storageList,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { promptRegion, promptSelectFile } from '/src/storage/prompt.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const deleteAction = async (
  remotePath: string | undefined,
  options: { region?: StorageRegion; prefix?: string; yes?: boolean },
) => {
  const apiKey = await getApiKeyFromYml()

  // Interactive: prompt for region if not provided
  const region = options.region ?? await promptRegion()

  // Prefix mode: bulk delete all files matching prefix
  if (options.prefix) {
    return await deletByPrefix(apiKey, options.prefix, region, options.yes)
  }

  // Interactive: select file from list if path not provided
  if (!remotePath) {
    const selected = await promptSelectFile(apiKey, region)
    if (!selected) return false
    remotePath = selected.path
  }

  if (!options.yes) {
    const { confirmed } = await prompt([
      {
        type: Confirm,
        name: 'confirmed',
        message: colors.yellow(
          `Are you sure you want to delete "${remotePath}"?`,
        ),
        default: false,
      },
    ])
    if (!confirmed) {
      console.log(colors.yellow('Delete cancelled'))
      return false
    }
  }

  return await deleteSingle(apiKey, remotePath, region)
}

const deleteSingle = async (
  apiKey: string,
  remotePath: string,
  region?: StorageRegion,
): Promise<boolean> => {
  const spinner = new Kia(colors.cyan(`Deleting ${remotePath}...`))
  spinner.start()

  try {
    const result = await storageDelete(apiKey, remotePath, region)
    if (result.success) {
      spinner.succeed(`Deleted: ${remotePath}`)
      return true
    }
    spinner.fail('Delete failed')
    return false
  } catch (error) {
    spinner.fail('Delete failed')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}

const deletByPrefix = async (
  apiKey: string,
  prefix: string,
  region?: StorageRegion,
  skipConfirm?: boolean,
): Promise<boolean> => {
  // Collect all files matching the prefix
  const spinner = new Kia(colors.cyan(`Listing files with prefix "${prefix}"...`))
  spinner.start()

  const allFiles: string[] = []
  let cursor: string | undefined
  try {
    do {
      const res = await storageList(apiKey, { prefix, region, cursor })
      for (const f of res.files) {
        allFiles.push(f.path)
      }
      cursor = res.truncated ? res.cursor : undefined
    } while (cursor)
  } catch (error) {
    spinner.fail('Failed to list files')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }

  spinner.stop()

  if (allFiles.length === 0) {
    console.log(colors.yellow(`No files found with prefix "${prefix}"`))
    return false
  }

  console.log(
    colors.white(`\nFound ${colors.bold(String(allFiles.length))} file(s) with prefix "${prefix}":`),
  )
  // Show first 10 files as preview
  const preview = allFiles.slice(0, 10)
  for (const f of preview) {
    console.log(colors.gray(`  ${f}`))
  }
  if (allFiles.length > 10) {
    console.log(colors.gray(`  ... and ${allFiles.length - 10} more`))
  }

  if (!skipConfirm) {
    const { confirmed } = await prompt([
      {
        type: Confirm,
        name: 'confirmed',
        message: colors.yellow(
          `Are you sure you want to delete all ${allFiles.length} file(s)?`,
        ),
        default: false,
      },
    ])
    if (!confirmed) {
      console.log(colors.yellow('Delete cancelled'))
      return false
    }
  }

  let succeeded = 0
  let failed = 0
  const deleteSpinner = new Kia(colors.cyan(`Deleting ${allFiles.length} file(s)...`))
  deleteSpinner.start()

  for (const filePath of allFiles) {
    try {
      const result = await storageDelete(apiKey, filePath, region)
      if (result.success) {
        succeeded++
      } else {
        failed++
      }
    } catch {
      failed++
    }
    deleteSpinner.set(
      colors.cyan(`Deleting... (${succeeded + failed}/${allFiles.length})`),
    )
  }

  if (failed === 0) {
    deleteSpinner.succeed(`Deleted ${succeeded} file(s) with prefix "${prefix}"`)
  } else {
    deleteSpinner.warn(
      `Deleted ${succeeded} file(s), ${failed} failed (prefix: "${prefix}")`,
    )
  }

  return failed === 0
}
