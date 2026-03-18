import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  presignDownload,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { promptRegion, promptSelectFile } from '/src/storage/prompt.ts'
import { basename } from 'https://deno.land/std@0.202.0/path/mod.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'

export const downloadAction = async (
  remotePath: string | undefined,
  options: { output?: string; region?: StorageRegion },
) => {
  const apiKey = await getApiKeyFromYml()

  // Interactive: prompt for region if not provided
  const region = options.region ?? await promptRegion()

  // Interactive: select file from list if path not provided
  if (!remotePath) {
    const selected = await promptSelectFile(apiKey, region)
    if (!selected) return false
    remotePath = selected.path
  }

  const spinner = new Kia(colors.cyan('Requesting presigned URL...'))
  spinner.start()

  try {
    const presign = await presignDownload(apiKey, remotePath, region)
    spinner.succeed('Got presigned URL')

    const downloadSpinner = new Kia(
      colors.cyan(`Downloading ${remotePath}...`),
    )
    downloadSpinner.start()

    const res = await fetch(presign.url)
    if (!res.ok) {
      downloadSpinner.fail('Download failed')
      console.log(
        colors.red(`Download failed (HTTP ${res.status})`),
      )
      return false
    }

    const data = new Uint8Array(await res.arrayBuffer())
    const outputPath = options.output || basename(remotePath)
    await Deno.writeFile(outputPath, data)

    downloadSpinner.succeed('Download complete')
    console.log(
      colors.white(
        `\n  Saved:  ${colors.green(outputPath)}\n  Size:   ${colors.green(formatBytes(data.byteLength))}`,
      ),
    )
    return true
  } catch (error) {
    spinner.fail('Download failed')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}
