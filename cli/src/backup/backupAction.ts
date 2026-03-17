import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import {
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

  // Root check
  if (Deno.uid() !== 0) {
    console.log(
      colors.yellow(
        '\n⚠️  Warning: Not running as root. Backup may miss files due to permission errors.',
      ),
    )
    console.log(
      colors.yellow('   Consider running with: sudo slv backup create\n'),
    )
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
    const command = new Deno.Command('tar', {
      args: tarArgs,
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

async function uploadBackup(
  filePath: string,
  hostname: string,
  region?: StorageRegion,
  retention = 7,
): Promise<void> {
  const apiKey = await getApiKeyFromYml()
  const filename = filePath.includes('/') ? filePath.split('/').pop()! : filePath
  const remotePath = `backups/${filename}`

  const spinner = new Kia(colors.cyan('Requesting presigned upload URL...'))
  spinner.start()

  try {
    const presign = await presignUpload(apiKey, remotePath, region)
    spinner.succeed('Got presigned URL')

    const fileInfo = await Deno.stat(filePath)
    const uploadSpinner = new Kia(
      colors.cyan(
        `Uploading ${filename} (${formatBytes(fileInfo.size ?? 0)})...`,
      ),
    )
    uploadSpinner.start()

    const file = await Deno.open(filePath, { read: true })
    const uploadRes = await fetch(presign.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.readable,
    })

    if (!uploadRes.ok) {
      uploadSpinner.fail('Upload failed')
      console.log(
        colors.red(`Upload failed (HTTP ${uploadRes.status})`),
      )
      return
    }

    uploadSpinner.succeed('Upload complete')
    console.log(
      colors.white(
        `\n  Remote: ${colors.green(remotePath)}\n  Region: ${colors.green(presign.region)}`,
      ),
    )

    // Retention cleanup
    if (retention > 0) {
      await cleanupOldBackups(apiKey, hostname, retention, region)
    }
  } catch (error) {
    spinner.fail('Upload failed')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
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
