import { Confirm, prompt } from '@cliffy/prompt'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  storageDelete,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const deleteAction = async (
  remotePath: string,
  options: { region?: StorageRegion; yes?: boolean },
) => {
  const apiKey = await getApiKeyFromYml()

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

  const spinner = new Kia(colors.cyan(`Deleting ${remotePath}...`))
  spinner.start()

  try {
    const result = await storageDelete(apiKey, remotePath, options.region)
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
