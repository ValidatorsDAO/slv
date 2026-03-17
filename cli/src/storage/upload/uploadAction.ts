import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  presignUpload,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import {
  promptFilePath,
  promptRegion,
  promptRemotePath,
} from '/src/storage/prompt.ts'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import { basename, extname } from 'https://deno.land/std@0.202.0/path/mod.ts'

const CONTENT_TYPE_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.bin': 'application/octet-stream',
}

const guessContentType = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase()
  return CONTENT_TYPE_MAP[ext] || 'application/octet-stream'
}

export const uploadAction = async (
  filePath: string | undefined,
  options: { path?: string; region?: StorageRegion },
) => {
  const apiKey = await getApiKeyFromYml()

  // Interactive: prompt for file path if not provided
  if (!filePath) {
    filePath = await promptFilePath()
  }

  let fileInfo: Deno.FileInfo
  try {
    fileInfo = await Deno.stat(filePath)
  } catch {
    console.log(colors.red(`File not found: ${filePath}`))
    return false
  }
  if (!fileInfo.isFile) {
    console.log(colors.red(`Not a file: ${filePath}`))
    return false
  }

  // Interactive: prompt for region if not provided
  const region = options.region ?? await promptRegion()

  // Interactive: prompt for remote path if not provided
  const defaultRemotePath = basename(filePath)
  const remotePath = options.path ?? await promptRemotePath(defaultRemotePath)

  const contentType = guessContentType(filePath)

  const spinner = new Kia(colors.cyan('Requesting presigned URL...'))
  spinner.start()

  let presignDone = false
  try {
    const presign = await presignUpload(
      apiKey,
      remotePath,
      region,
      contentType,
    )
    spinner.succeed('Got presigned URL')
    presignDone = true

    const uploadSpinner = new Kia(
      colors.cyan(
        `Uploading ${basename(filePath)} (${formatBytes(fileInfo.size ?? 0)})...`,
      ),
    )
    uploadSpinner.start()

    const fileData = await Deno.readFile(filePath)
    const uploadRes = await fetch(presign.url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: fileData,
    })

    if (!uploadRes.ok) {
      uploadSpinner.fail('Upload failed')
      console.log(
        colors.red(`Upload to R2 failed (HTTP ${uploadRes.status})`),
      )
      return false
    }

    uploadSpinner.succeed('Upload complete')
    console.log(
      colors.white(
        `\n  Path:   ${colors.green(remotePath)}\n  Region: ${colors.green(presign.region)}\n  Size:   ${colors.green(formatBytes(fileInfo.size ?? 0))}`,
      ),
    )
    return true
  } catch (error) {
    if (!presignDone) {
      spinner.fail('Upload failed')
    }
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return false
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
