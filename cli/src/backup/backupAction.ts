import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import {
  multipartComplete,
  multipartCreate,
  multipartPresign,
  presignUpload,
  storageDelete,
  storageList,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { buildExcludeList, printExcludes } from '@/backup/excludes.ts'
import { setupCron } from '@/backup/cron.ts'

async function getHostname(): Promise<string> {
  const command = new Deno.Command('hostname', { stdout: 'piped', stderr: 'piped' })
  const result = await command.output()
  return new TextDecoder().decode(result.stdout).trim() || 'unknown'
}

async function hasZstd(): Promise<boolean> {
  try {
    const command = new Deno.Command('which', {
      args: ['zstd'],
      stdout: 'piped',
      stderr: 'piped',
    })
    const result = await command.output()
    return result.success
  } catch {
    return false
  }
}

function formatTimestamp(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const h = String(now.getUTCHours()).padStart(2, '0')
  const mi = String(now.getUTCMinutes()).padStart(2, '0')
  const s = String(now.getUTCSeconds()).padStart(2, '0')
  return `${y}${mo}${d}-${h}${mi}${s}`
}

function parseTimestampFromFilename(filename: string): Date | null {
  // backup-<hostname>-YYYYMMDD-HHMMSS.tar.zst
  const match = filename.match(/(\d{8})-(\d{6})\.tar\.(zst|gz)$/)
  if (!match) return null
  const dateStr = match[1]
  const timeStr = match[2]
  const year = parseInt(dateStr.slice(0, 4))
  const month = parseInt(dateStr.slice(4, 6)) - 1
  const day = parseInt(dateStr.slice(6, 8))
  const hour = parseInt(timeStr.slice(0, 2))
  const min = parseInt(timeStr.slice(2, 4))
  const sec = parseInt(timeStr.slice(4, 6))
  return new Date(Date.UTC(year, month, day, hour, min, sec))
}

export const backupAction = async (options: {
  output?: string
  upload?: boolean
  region?: string
  exclude?: string[]
  include?: string[]
  listExcludes?: boolean
  retention?: number
  cron?: string
  yes?: boolean
}) => {
  const excludes = buildExcludeList({
    extraExcludes: options.exclude,
    extraIncludes: options.include,
    includeSSH: true, // backup includes SSH files
  })

  // --list-excludes: show and exit
  if (options.listExcludes) {
    printExcludes(excludes)
    return
  }

  // --cron: set up cron job
  if (options.cron) {
    await setupCron(options.cron, options.retention ?? 7)
    if (!options.upload) return // cron-only mode
  }

  // Pre-flight: upload requires API key before spending time on prompts or archive
  if (options.upload) {
    await getApiKeyFromYml()
  }

  // Root check – prompt for sudo when running interactively
  let useSudo = false
  if (Deno.uid() !== 0) {
    console.log(
      colors.yellow(
        '\n⚠️  Warning: Not running as root. Backup may miss files due to permission errors.',
      ),
    )

    if (!options.yes) {
      const { Confirm } = await import('@cliffy/prompt')
      useSudo = await Confirm.prompt({
        message: 'Use sudo for backup? (recommended for complete backup)',
        default: true,
      })
      if (!useSudo) {
        const proceed = await Confirm.prompt({
          message:
            'Continue without root? Some files may be missing from backup.',
          default: false,
        })
        if (!proceed) {
          console.log(
            colors.yellow(
              '\n⚠️  Backup cancelled. Re-run with: sudo slv backup create\n',
            ),
          )
          return
        }
      }
    } else {
      // --yes mode: auto-enable sudo for non-root
      useSudo = true
      const sudoCheck = new Deno.Command('sudo', {
        args: ['-n', 'true'],
        stdout: 'piped',
        stderr: 'piped',
      })
      const sudoResult = await sudoCheck.output()
      if (!sudoResult.success) {
        console.log(
          colors.yellow('   sudo not available (NOPASSWD). Continuing without sudo.\n'),
        )
        useSudo = false
      } else {
        console.log(colors.green('  ✔ sudo access verified (auto-enabled for --yes mode)'))
      }
    }
  }

  // Detect compression
  const useZstd = await hasZstd()
  if (!useZstd) {
    console.log(
      colors.yellow(
        '⚠️  zstd not found, falling back to gzip. Install zstd for faster compression.',
      ),
    )
  }
  const ext = useZstd ? 'tar.zst' : 'tar.gz'

  // Output filename
  const hostname = await getHostname()
  const timestamp = formatTimestamp()
  const defaultFilename = `backup-${hostname}-${timestamp}.${ext}`
  const output = options.output || defaultFilename

  // Show plan
  console.log(colors.bold(colors.blue('\n🗄️  SLV Backup\n')))
  console.log(colors.white(`  Output:      ${output}`))
  console.log(colors.white(`  Compression: ${useZstd ? 'zstd (multi-threaded)' : 'gzip'}`))
  if (options.upload) {
    console.log(colors.white(`  Upload:      yes (region: ${options.region || 'eu'})`))
  }

  printExcludes(excludes)

  // Confirmation
  if (!options.yes) {
    const { Confirm } = await import('@cliffy/prompt')
    const proceed = await Confirm.prompt({
      message: 'Create backup?',
      default: true,
    })
    if (!proceed) {
      console.log(colors.yellow('\n⚠️  Backup cancelled.\n'))
      return
    }
  }

  // Build tar command
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e])
  // Also exclude the output file itself
  excludeArgs.push('--exclude', output.startsWith('/') ? output : `./${output}`)

  const tarArgs: string[] = []
  if (useZstd) {
    tarArgs.push('-I', 'zstd -T0', ...excludeArgs, '-cf', output, '/')
  } else {
    tarArgs.push('--gzip', ...excludeArgs, '-cf', output, '/')
  }

  const spinner = new Kia(colors.cyan('Creating backup archive...'))
  spinner.start()

  try {
    const cmd = useSudo ? 'sudo' : 'tar'
    const cmdArgs = useSudo ? ['tar', ...tarArgs] : tarArgs
    const command = new Deno.Command(cmd, {
      args: cmdArgs,
      stdout: 'piped',
      stderr: 'piped',
    })
    const result = await command.output()

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr)
      // tar exits with code 1 for "file changed as we read it" which is normal for system backup
      if (result.code > 1) {
        spinner.fail('Backup failed')
        console.log(colors.red(`\ntar error:\n${stderr}`))
        Deno.exit(1)
      }
    }

    const fileInfo = await Deno.stat(output)
    spinner.succeed(
      `Backup created: ${output} (${formatBytes(fileInfo.size ?? 0)})`,
    )
  } catch (error) {
    spinner.fail('Backup failed')
    console.log(colors.red(String(error)))
    Deno.exit(1)
  }

  // Upload
  if (options.upload) {
    await uploadBackup(output, hostname, options.region as StorageRegion, options.retention ?? 7)
  }

  console.log(colors.green('\n✅ Backup complete.\n'))
}

/** Threshold for switching to multipart upload (5 GB). */
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024

/** Chunk size for multipart upload (100 MB). */
const MULTIPART_CHUNK_SIZE = 100 * 1024 * 1024

/** Maximum concurrent chunk uploads. */
const MULTIPART_CONCURRENCY = 4

async function uploadBackup(
  filePath: string,
  hostname: string,
  region?: StorageRegion,
  retention = 7,
): Promise<void> {
  const apiKey = await getApiKeyFromYml()
  const filename = filePath.includes('/') ? filePath.split('/').pop()! : filePath
  const remotePath = `backups/${filename}`
  const fileInfo = await Deno.stat(filePath)
  const fileSize = fileInfo.size ?? 0

  try {
    let uploadRegion: string

    if (fileSize > MULTIPART_THRESHOLD_BYTES) {
      // ── Multipart upload for large backups ──
      console.log(
        colors.cyan(
          `\n📦 Large backup detected (${formatBytes(fileSize)}). Using multipart upload.\n`,
        ),
      )
      const result = await uploadBackupMultipart(apiKey, filePath, remotePath, fileSize, region)
      if (!result) return
      uploadRegion = result.region
    } else {
      // ── Single presigned PUT ──
      const result = await uploadBackupSingle(apiKey, filePath, filename, remotePath, fileSize, region)
      if (!result) return
      uploadRegion = result.region
    }

    console.log(
      colors.white(
        `\n  Remote: ${colors.green(remotePath)}\n  Region: ${colors.green(uploadRegion)}`,
      ),
    )

    // Retention cleanup
    if (retention > 0) {
      await cleanupOldBackups(apiKey, hostname, retention, region)
    }
  } catch (error) {
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
  }
}

async function uploadBackupSingle(
  apiKey: string,
  filePath: string,
  filename: string,
  remotePath: string,
  fileSize: number,
  region?: StorageRegion,
): Promise<{ region: string } | null> {
  const spinner = new Kia(colors.cyan('Requesting presigned upload URL...'))
  spinner.start()

  try {
    const presign = await presignUpload(apiKey, remotePath, region)
    spinner.succeed('Got presigned URL')

    const uploadSpinner = new Kia(
      colors.cyan(
        `Uploading ${filename} (${formatBytes(fileSize)})...`,
      ),
    )
    uploadSpinner.start()

    const file = await Deno.open(filePath, { read: true })
    try {
      const uploadRes = await fetch(presign.url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileSize),
        },
        body: file.readable,
      })

      if (!uploadRes.ok) {
        uploadSpinner.fail('Upload failed')
        console.log(colors.red(`Upload failed (HTTP ${uploadRes.status})`))
        return null
      }
    } catch (err) {
      try { file.close() } catch { /* already closed */ }
      throw err
    }

    uploadSpinner.succeed('Upload complete')
    return { region: presign.region }
  } catch (error) {
    spinner.fail('Upload failed')
    throw error
  }
}

async function uploadBackupMultipart(
  apiKey: string,
  filePath: string,
  remotePath: string,
  fileSize: number,
  region?: StorageRegion,
): Promise<{ region: string } | null> {
  const totalParts = Math.ceil(fileSize / MULTIPART_CHUNK_SIZE)

  // Initiate
  const initSpinner = new Kia(colors.cyan('Initiating multipart upload...'))
  initSpinner.start()

  let upload: Awaited<ReturnType<typeof multipartCreate>>
  try {
    upload = await multipartCreate(apiKey, remotePath, fileSize, region, 'application/octet-stream')
    initSpinner.succeed(
      `Multipart upload initiated (${totalParts} parts × ${formatBytes(MULTIPART_CHUNK_SIZE)})`,
    )
  } catch (error) {
    initSpinner.fail('Failed to initiate multipart upload')
    throw error
  }

  // Upload parts with bounded concurrency
  const completedParts: { partNumber: number; etag: string }[] = []

  try {
    const partDescs: { partNumber: number; offset: number; size: number }[] = []
    let offset = 0
    let partNumber = 1
    while (offset < fileSize) {
      const size = Math.min(MULTIPART_CHUNK_SIZE, fileSize - offset)
      partDescs.push({ partNumber, offset, size })
      offset += size
      partNumber++
    }

    const inflight = new Set<Promise<void>>()

    for (const desc of partDescs) {
      const task = (async () => {
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

        const presign = await multipartPresign(
          apiKey,
          upload.uploadId,
          upload.key,
          desc.partNumber,
          region,
        )

        const res = await fetch(presign.url, {
          method: 'PUT',
          headers: { 'Content-Length': String(chunk.byteLength) },
          body: chunk,
        })

        if (!res.ok) {
          throw new Error(`Part ${desc.partNumber} upload failed (HTTP ${res.status})`)
        }

        const etag = res.headers.get('etag') ?? ''
        completedParts.push({ partNumber: desc.partNumber, etag })

        const done = completedParts.length
        const pct = Math.round((done / totalParts) * 100)
        const bar = '█'.repeat(Math.round(pct / 4)) + '░'.repeat(25 - Math.round(pct / 4))
        Deno.stdout.writeSync(
          new TextEncoder().encode(
            `\r  ${colors.cyan(bar)} ${colors.white(`${done}/${totalParts} parts`)} (${pct}%)`,
          ),
        )
      })()

      const tracked = task.then(
        () => { inflight.delete(tracked) },
        (err) => { inflight.delete(tracked); throw err },
      )
      inflight.add(tracked)

      if (inflight.size >= MULTIPART_CONCURRENCY) {
        await Promise.race(inflight)
      }
    }

    await Promise.all(inflight)
    console.log() // newline after progress bar
  } catch (error) {
    console.log(colors.red(`\n\n❌ Multipart upload failed: ${error instanceof Error ? error.message : String(error)}`))
    return null
  }

  // Complete
  const completeSpinner = new Kia(colors.cyan('Completing multipart upload...'))
  completeSpinner.start()

  try {
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
    throw error
  }
}

async function cleanupOldBackups(
  apiKey: string,
  hostname: string,
  retentionDays: number,
  region?: StorageRegion,
): Promise<void> {
  const prefix = `backups/backup-${hostname}-`
  try {
    const list = await storageList(apiKey, { prefix, region })
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)

    let deleted = 0
    for (const file of list.files) {
      const filename = file.path.split('/').pop() || ''
      const ts = parseTimestampFromFilename(filename)
      if (ts && ts < cutoff) {
        await storageDelete(apiKey, file.path, region)
        console.log(colors.dim(`  🗑️  Deleted old backup: ${file.path}`))
        deleted++
      }
    }

    if (deleted > 0) {
      console.log(
        colors.green(
          `\n  Cleaned up ${deleted} backup(s) older than ${retentionDays} days`,
        ),
      )
    }
  } catch (error) {
    console.log(
      colors.yellow(
        `\n⚠️  Could not clean up old backups: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
}
