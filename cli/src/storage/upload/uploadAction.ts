import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  presignUpload,
  StorageApiError,
  storageUsage,
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

/** Maximum file size for a single R2 presigned PUT upload (5 GB). */
const MAX_SINGLE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024

const guessContentType = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase()
  return CONTENT_TYPE_MAP[ext] || 'application/octet-stream'
}

/**
 * Return a human-readable description of an HTTP error from R2.
 */
const describeUploadError = (status: number): string => {
  switch (status) {
    case 400:
      return 'Bad request. The presigned URL may be malformed.'
    case 403:
      return 'Permission denied. The presigned URL may have expired — please retry.'
    case 408:
      return 'Request timed out. Check your network connection and try again.'
    case 411:
      return 'Content-Length header missing or rejected by the server.'
    case 413:
      return 'File exceeds the maximum upload size allowed by the server.'
    default:
      return `Unexpected server error (HTTP ${status}). Please try again later.`
  }
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

  const fileSize = fileInfo.size ?? 0

  // ── Pre-upload size gate: reject files > 5 GB ──
  if (fileSize > MAX_SINGLE_UPLOAD_BYTES) {
    console.log(
      colors.red(`\n❌ File too large for single upload (${formatBytes(fileSize)})`),
    )
    console.log(
      colors.white(
        `  Maximum single upload size: ${formatBytes(MAX_SINGLE_UPLOAD_BYTES)}\n` +
          '  For large backups, consider splitting or compressing further.',
      ),
    )
    return false
  }

  // ── Pre-upload storage quota check ──
  try {
    const usage = await storageUsage(apiKey)
    const available = usage.storageLimitBytes - usage.usedBytes
    if (fileSize > available) {
      console.log(colors.red('\n❌ Storage limit exceeded'))
      console.log(
        colors.white(
          `  File size:  ${colors.yellow(formatBytes(fileSize))}\n` +
            `  Used:       ${formatBytes(usage.usedBytes)} / ${formatBytes(usage.storageLimitBytes)}\n` +
            `  Available:  ${formatBytes(available > 0 ? available : 0)}`,
        ),
      )
      console.log(
        colors.cyan(
          '\n💡 Free up space with: slv storage rm <path>\n' +
            '   Or upgrade:         slv storage upgrade',
        ),
      )
      return false
    }
  } catch (error) {
    // If we cannot reach the usage API, warn but continue — the server
    // will reject over-quota uploads anyway.
    if (error instanceof StorageApiError) {
      console.log(
        colors.yellow(`⚠ Could not check storage quota: ${error.message}`),
      )
    }
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
        `Uploading ${basename(filePath)} (${formatBytes(fileSize)})...`,
      ),
    )
    uploadSpinner.start()

    // Stream the file instead of reading it entirely into memory.
    const file = await Deno.open(filePath, { read: true })
    try {
      const uploadRes = await fetch(presign.url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
        },
        body: file.readable,
      })

      if (!uploadRes.ok) {
        uploadSpinner.fail('Upload failed')
        console.log(
          colors.red(`\n❌ Upload to R2 failed (HTTP ${uploadRes.status})`),
        )
        console.log(colors.white(`  ${describeUploadError(uploadRes.status)}`))
        return false
      }
    } catch (uploadErr) {
      // Ensure the file handle is not leaked on network errors.
      // file.readable auto-closes on full consumption, but not on abort.
      try {
        file.close()
      } catch { /* already closed */ }
      throw uploadErr
    }

    uploadSpinner.succeed('Upload complete')
    console.log(
      colors.white(
        `\n  Path:   ${colors.green(remotePath)}\n  Region: ${colors.green(presign.region)}\n  Size:   ${colors.green(formatBytes(fileSize))}`,
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
