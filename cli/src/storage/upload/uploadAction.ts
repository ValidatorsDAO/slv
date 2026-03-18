import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import { colors } from '@cliffy/colors'
import {
  multipartComplete,
  multipartCreate,
  multipartUploadPart,
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

/** Threshold for switching to multipart upload (5 GB). */
const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024 // 100 MB

/** Chunk size for multipart upload (100 MB). */
const MULTIPART_CHUNK_SIZE = 100 * 1024 * 1024

/** Maximum concurrent chunk uploads. */
const MULTIPART_CONCURRENCY = 4

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

/**
 * Upload a file using a single presigned PUT (for files ≤ 5 GB).
 */
async function singleUpload(
  apiKey: string,
  filePath: string,
  remotePath: string,
  fileSize: number,
  contentType: string,
  region?: StorageRegion,
): Promise<{ region: string } | null> {
  const spinner = new Kia(colors.cyan('Requesting presigned URL...'))
  spinner.start()

  let presignDone = false
  try {
    const presign = await presignUpload(apiKey, remotePath, region, contentType)
    spinner.succeed('Got presigned URL')
    presignDone = true

    const uploadSpinner = new Kia(
      colors.cyan(
        `Uploading ${basename(filePath)} (${formatBytes(fileSize)})...`,
      ),
    )
    uploadSpinner.start()

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
        return null
      }
    } catch (uploadErr) {
      try {
        file.close()
      } catch { /* already closed */ }
      throw uploadErr
    }

    uploadSpinner.succeed('Upload complete')
    return { region: presign.region }
  } catch (error) {
    if (!presignDone) {
      spinner.fail('Upload failed')
    }
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return null
  }
}

/**
 * Upload a file using multipart upload (for files > 5 GB).
 */
async function multipartUpload(
  apiKey: string,
  filePath: string,
  remotePath: string,
  fileSize: number,
  contentType: string,
  region?: StorageRegion,
): Promise<{ region: string } | null> {
  const totalParts = Math.ceil(fileSize / MULTIPART_CHUNK_SIZE)

  // Step 1: Create multipart upload
  const initSpinner = new Kia(colors.cyan('Initiating multipart upload...'))
  initSpinner.start()

  let upload: Awaited<ReturnType<typeof multipartCreate>>
  try {
    upload = await multipartCreate(apiKey, remotePath, fileSize, region, contentType)
    initSpinner.succeed(
      `Multipart upload initiated (${totalParts} parts × ${formatBytes(MULTIPART_CHUNK_SIZE)})`,
    )
  } catch (error) {
    initSpinner.fail('Failed to initiate multipart upload')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return null
  }

  // Step 2 & 3: Upload chunks with bounded concurrency
  const completedParts: { partNumber: number; etag: string }[] = []

  try {
    // Build list of part descriptors
    const partDescs: { partNumber: number; offset: number; size: number }[] = []
    let offset = 0
    let partNumber = 1
    while (offset < fileSize) {
      const size = Math.min(MULTIPART_CHUNK_SIZE, fileSize - offset)
      partDescs.push({ partNumber, offset, size })
      offset += size
      partNumber++
    }

    // Upload with bounded concurrency using a pool
    const inflight = new Set<Promise<void>>()

    for (const desc of partDescs) {
      const task = (async () => {
        // Read chunk from a dedicated file handle
        const buf = new Uint8Array(desc.size)
        let bytesRead = 0
        const chunkFile = await Deno.open(filePath, { read: true })
        try {
          await chunkFile.seek(desc.offset, Deno.SeekMode.Start)
          while (bytesRead < desc.size) {
            const n = await chunkFile.read(buf.subarray(bytesRead))
            if (n === null) break
            bytesRead += n
          }
        } finally {
          chunkFile.close()
        }

        const chunk = bytesRead === desc.size ? buf : buf.subarray(0, bytesRead)

        // Upload the chunk directly via Workers API
        const result = await multipartUploadPart(
          apiKey,
          upload.uploadId,
          upload.key,
          desc.partNumber,
          chunk,
          region,
        )

        completedParts.push({ partNumber: desc.partNumber, etag: result.etag })

        // Progress
        const done = completedParts.length
        const pct = Math.round((done / totalParts) * 100)
        const bar = '█'.repeat(Math.round(pct / 4)) + '░'.repeat(25 - Math.round(pct / 4))
        Deno.stdout.writeSync(
          new TextEncoder().encode(
            `\r  ${colors.cyan(bar)} ${colors.white(`${done}/${totalParts} parts`)} (${pct}%)`,
          ),
        )
      })()

      // Track this task; remove itself from inflight when done
      const tracked = task.then(
        () => { inflight.delete(tracked) },
        (err) => { inflight.delete(tracked); throw err },
      )
      inflight.add(tracked)

      // When we hit concurrency limit, wait for one to finish
      if (inflight.size >= MULTIPART_CONCURRENCY) {
        await Promise.race(inflight)
      }
    }

    // Wait for all remaining
    await Promise.all(inflight)

    // Newline after progress bar
    console.log()
  } catch (error) {
    console.log(colors.red(`\n\n❌ Multipart upload failed: ${error instanceof Error ? error.message : String(error)}`))
    return null
  }

  // Step 4: Complete multipart upload
  const completeSpinner = new Kia(colors.cyan('Completing multipart upload...'))
  completeSpinner.start()

  try {
    // Sort parts by partNumber before completing
    completedParts.sort((a, b) => a.partNumber - b.partNumber)
    const result = await multipartComplete(
      apiKey,
      upload.uploadId,
      upload.key,
      completedParts,
      region,
    )
    completeSpinner.succeed('Multipart upload complete')
    return { region: result.region }
  } catch (error) {
    completeSpinner.fail('Failed to complete multipart upload')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return null
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

  // Choose upload strategy based on file size
  const useMultipart = fileSize > MULTIPART_THRESHOLD_BYTES
  if (useMultipart) {
    console.log(
      colors.cyan(
        `\n📦 Large file detected (${formatBytes(fileSize)}). Using multipart upload.\n`,
      ),
    )
  }

  const result = useMultipart
    ? await multipartUpload(apiKey, filePath, remotePath, fileSize, contentType, region)
    : await singleUpload(apiKey, filePath, remotePath, fileSize, contentType, region)

  if (!result) return false

  console.log(
    colors.white(
      `\n  Path:   ${colors.green(remotePath)}\n  Region: ${colors.green(result.region)}\n  Size:   ${colors.green(formatBytes(fileSize))}`,
    ),
  )
  return true
}

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
