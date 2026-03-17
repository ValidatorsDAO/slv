import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import { getApiKeyFromYml } from '/lib/getApiKeyFromYml.ts'
import {
  presignDownload,
  storageList,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { Select } from '@cliffy/prompt'

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

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path)
    return info.isFile
  } catch {
    return false
  }
}

async function downloadFile(
  url: string,
  output: string,
): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status})`)
  }
  const file = await Deno.open(output, { write: true, create: true, truncate: true })
  await res.body.pipeTo(file.writable)
}

async function selectRemoteBackup(
  apiKey: string,
  region?: StorageRegion,
): Promise<string | null> {
  const spinner = new Kia(colors.cyan('Fetching backup list...'))
  spinner.start()

  try {
    const list = await storageList(apiKey, { prefix: 'backups/', region })
    spinner.stop()

    if (list.files.length === 0) {
      console.log(colors.yellow('\nNo backups found in cloud storage.\n'))
      return null
    }

    // Sort by lastModified descending
    const sorted = list.files.sort(
      (a, b) =>
        new Date(b.lastModified).getTime() -
        new Date(a.lastModified).getTime(),
    )

    const choices = sorted.map((f) => ({
      name: `${f.path}  (${formatBytes(f.size)}, ${f.lastModified})`,
      value: f.path,
    }))

    const selected = await Select.prompt({
      message: 'Select a backup to restore',
      options: choices,
    })

    return selected
  } catch (error) {
    spinner.fail('Failed to list backups')
    if (error instanceof StorageApiError) {
      console.log(colors.red(`\n${error.message}`))
    } else {
      console.log(colors.red(String(error)))
    }
    return null
  }
}

export const importAction = async (
  options: {
    region?: string
    yes?: boolean
  },
  file?: string,
) => {
  let localFile: string

  if (file && await fileExists(file)) {
    // Local file provided
    localFile = file
  } else {
    // Download from cloud storage
    const apiKey = await getApiKeyFromYml()
    const region = options.region as StorageRegion | undefined

    let remotePath: string | null

    if (file) {
      // Treat as remote path
      remotePath = file.startsWith('backups/') ? file : `backups/${file}`
    } else {
      // Interactive selection
      remotePath = await selectRemoteBackup(apiKey, region)
    }

    if (!remotePath) {
      console.log(colors.yellow('No backup selected.\n'))
      return
    }

    const spinner = new Kia(colors.cyan('Requesting download URL...'))
    spinner.start()

    try {
      const presign = await presignDownload(apiKey, remotePath, region)
      spinner.succeed('Got download URL')

      const filename = remotePath.split('/').pop() || 'backup.tar.zst'
      localFile = `/tmp/${filename}`

      const dlSpinner = new Kia(
        colors.cyan(`Downloading ${filename}...`),
      )
      dlSpinner.start()

      await downloadFile(presign.url, localFile)

      const info = await Deno.stat(localFile)
      dlSpinner.succeed(
        `Downloaded: ${localFile} (${formatBytes(info.size ?? 0)})`,
      )
    } catch (error) {
      spinner.fail('Download failed')
      if (error instanceof StorageApiError) {
        console.log(colors.red(`\n${error.message}`))
      } else {
        console.log(colors.red(String(error)))
      }
      return
    }
  }

  // Detect compression
  const useZstd = localFile.endsWith('.tar.zst')
  if (useZstd && !(await hasZstd())) {
    console.log(
      colors.red(
        '❌ This backup uses zstd compression but zstd is not installed.',
      ),
    )
    console.log(colors.yellow('   Install zstd: apt install zstd\n'))
    Deno.exit(1)
  }

  // Root check
  if (Deno.uid() !== 0) {
    console.log(
      colors.red(
        '\n❌ Restore must be run as root to extract files to /.',
      ),
    )
    console.log(colors.yellow('   Run with: sudo slv backup restore\n'))
    Deno.exit(1)
  }

  // Warning
  console.log(
    colors.bold(colors.red('\n⚠️  WARNING: This will extract the backup over the current filesystem.')),
  )
  console.log(
    colors.red('⚠️  Existing files may be overwritten. A reboot is recommended after import.'),
  )
  console.log(
    colors.white(`\n  File:        ${localFile}`),
  )
  console.log(
    colors.white(`  Compression: ${useZstd ? 'zstd' : 'gzip'}`),
  )
  console.log(
    colors.white(`  Target:      /\n`),
  )

  // Confirmation for download/general proceed (skipped with --yes)
  if (!options.yes) {
    const { Confirm } = await import('@cliffy/prompt')
    const proceed = await Confirm.prompt({
      message: 'Proceed with restore?',
      default: false,
    })
    if (!proceed) {
      console.log(colors.yellow('\n⚠️  Restore cancelled.\n'))
      return
    }
  }

  // Root filesystem overwrite confirmation — ALWAYS prompt, even with --yes
  {
    const { Confirm } = await import('@cliffy/prompt')
    console.log(colors.red('\n⚠️  WARNING: This will extract files over the root filesystem (/).'))
    console.log(colors.red('   Existing files WILL be overwritten.'))
    console.log(colors.red('   A reboot is required after import.\n'))

    const proceed = await Confirm.prompt({
      message: 'Are you SURE you want to overwrite the root filesystem?',
      default: false,
    })
    if (!proceed) {
      console.log(colors.yellow('Import cancelled.'))
      return
    }
  }

  // Extract
  const tarArgs: string[] = []
  if (useZstd) {
    tarArgs.push('-I', 'zstd -d', '-xf', localFile, '-C', '/')
  } else {
    tarArgs.push('--gzip', '-xf', localFile, '-C', '/')
  }

  const spinner = new Kia(colors.cyan('Restoring backup...'))
  spinner.start()

  try {
    const command = new Deno.Command('tar', {
      args: tarArgs,
      stdout: 'piped',
      stderr: 'piped',
    })
    const result = await command.output()

    if (!result.success && result.code > 1) {
      const stderr = new TextDecoder().decode(result.stderr)
      spinner.fail('Restore failed')
      console.log(colors.red(`\ntar error:\n${stderr}`))
      Deno.exit(1)
    }

    spinner.succeed('Restore complete')
  } catch (error) {
    spinner.fail('Restore failed')
    console.log(colors.red(String(error)))
    Deno.exit(1)
  }

  console.log(
    colors.green('\n✅ Import completed. Please reboot to apply changes:'),
  )
  console.log(colors.white('   $ sudo reboot\n'))
}
