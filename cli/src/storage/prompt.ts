import { Input, prompt, Select } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import {
  storageList,
  StorageApiError,
  type StorageFile,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

const REGION_OPTIONS = [
  { name: 'eu       - Europe (default)', value: 'eu' },
  { name: 'asia     - Asia Pacific', value: 'asia' },
  { name: 'us-east  - US East', value: 'us-east' },
  { name: 'us-west  - US West', value: 'us-west' },
  { name: 'oc       - Oceania', value: 'oc' },
]

export const promptRegion = async (): Promise<StorageRegion> => {
  const { region } = await prompt([
    {
      name: 'region',
      message: 'Select storage region',
      type: Select,
      options: REGION_OPTIONS,
      default: 'eu',
    },
  ])
  return region as StorageRegion
}

export const promptFilePath = async (): Promise<string> => {
  const { filePath } = await prompt([
    {
      name: 'filePath',
      message: 'Enter the local file path to upload',
      type: Input,
    },
  ])
  if (!filePath) {
    console.log(colors.red('No file path provided'))
    Deno.exit(1)
  }
  return filePath
}

export const promptRemotePath = async (
  defaultPath: string,
): Promise<string> => {
  const { remotePath } = await prompt([
    {
      name: 'remotePath',
      message: 'Remote path in storage',
      type: Input,
      default: defaultPath,
    },
  ])
  return remotePath || defaultPath
}

export const promptSelectFile = async (
  apiKey: string,
  region?: StorageRegion,
): Promise<StorageFile | null> => {
  const spinner = new Kia(colors.cyan('Fetching file list...'))
  spinner.start()

  try {
    const result = await storageList(apiKey, { region })
    spinner.succeed(`Found ${result.files.length} file(s)`)

    if (result.files.length === 0) {
      console.log(colors.yellow('\nNo files found.'))
      return null
    }

    const options = result.files.map((file) => ({
      name: `${file.path}  ${colors.gray('(' + formatBytes(file.size) + ')')}`,
      value: file.path,
    }))

    const { selectedPath } = await prompt([
      {
        name: 'selectedPath',
        message: 'Select a file',
        type: Select,
        options,
      },
    ])

    return result.files.find((f) => f.path === selectedPath) || null
  } catch (error) {
    spinner.fail('Failed to list files')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return null
  }
}
