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
import { hasRestic, resticRestore } from '@/backup/restic.ts'

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

/**
 * Check if the argument looks like a tar archive (legacy backup format).
 */
function isTarArchive(arg: string): boolean {
  return /\.(tar\.(zst|gz)|tgz)$/i.test(arg)
}

export const importAction = async (
  options: {
    region?: string
    yes?: boolean
  },
  file?: string,
) => {
  // If the argument is not a tar archive, treat it as a restic snapshot ID
  if (file && !isTarArchive(file) && !(await fileExists(file))) {
    // Restic restore mode
    if (Deno.uid() !== 0) {
      console.log(colors.red('\n❌ Restore must be run as root to extract files to /.'))
      console.log(colors.yellow('   Run with: sudo slv backup restore\n'))
      Deno.exit(1)
    }

    if (!(await hasRestic())) {
      const { printResticInstallGuide } = await import('@/backup/restic.ts')
      printResticInstallGuide()
      Deno.exit(1)
    }

    const apiKey = await getApiKeyFromYml()

    console.log(colors.bold(colors.red('\n⚠️  WARNING: This will restore restic snapshot over the current filesystem.')))
    console.log(colors.white(`\n  Snapshot: ${file}`))
    console.log(colors.white(`  Target:   /\n`))

    if (!options.yes) {
      const { Confirm } = await import('@cliffy/prompt')
      const proceed = await Confirm.prompt({
        message: 'Proceed with restic restore?',
        default: false,
      })
      if (!proceed) {
        console.log(colors.yellow('\n⚠️  Restore cancelled.\n'))
        return
      }
    }

    await resticRestore(apiKey, file, options.region)
    console.log(colors.green('\n✅ Restore completed. Please reboot to apply changes:'))
    console.log(colors.white('   $ sudo reboot\n'))
    return
  }

  // If no argument provided and restic is available, offer choice between
  // restic and tar. Under --yes (non-interactive / agent-driven), skip the
  // Select and default to tar — the same path a machine without restic
  // installed would take. Agents that explicitly want restic should pass
  // a snapshot id as the positional argument.
  if (!file && await hasRestic() && !options.yes) {
    try {
      const mode = await Select.prompt({
        message: 'Restore from:',
        options: [
          { name: 'Cloud storage (tar archive)', value: 'tar' },
          { name: 'Restic snapshot (latest)', value: 'restic' },
        ],
      })

      if (mode === 'restic') {
        if (Deno.uid() !== 0) {
          console.log(colors.red('\n❌ Restore must be run as root.'))
          console.log(colors.yellow('   Run with: sudo slv backup restore\n'))
          Deno.exit(1)
        }

        const apiKey = await getApiKeyFromYml()
        if (!options.yes) {
          const { Confirm } = await import('@cliffy/prompt')
          const proceed = await Confirm.prompt({
            message: 'Restore latest restic snapshot to /?',
            default: false,
          })
          if (!proceed) {
            console.log(colors.yellow('\n⚠️  Restore cancelled.\n'))
            return
          }
        }

        await resticRestore(apiKey, undefined, options.region)
        console.log(colors.green('\n✅ Restore completed. Please reboot to apply changes:'))
        console.log(colors.white('   $ sudo reboot\n'))
        return
      }
      // Fall through to tar mode below
    } catch {
      // Non-interactive, fall through to tar mode
    }
  }

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
    } else if (options.yes) {
      // Non-interactive mode with no file specified — refuse rather than
      // falling into the interactive Select, which would hang run_command.
      // Agents must pass an explicit filename (use `slv backup list` to
      // discover it first).
      console.log(
        colors.red(
          '\n❌ --yes was passed but no backup file was specified.',
        ),
      )
      console.log(
        colors.white(
          '   Run `slv backup list` first, then `slv backup restore <filename> -y`.\n',
        ),
      )
      return
    } else {
      // Interactive selection (TTY users only)
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

  // Root filesystem overwrite warning. This is destructive (tar -xf over /),
  // so we always print a loud banner. The confirmation itself is skipped when
  // the caller explicitly passes --yes, so AI agents and automation can run
  // restores end-to-end without hanging on a TTY prompt they cannot answer.
  // If you are running interactively and want the safety net, simply omit
  // --yes and the original Confirm prompt still fires.
  {
    console.log(colors.red('\n⚠️  WARNING: This will extract files over the root filesystem (/).'))
    console.log(colors.red('   Existing files WILL be overwritten.'))
    console.log(colors.red('   A reboot is required after import.\n'))

    if (!options.yes) {
      const { Confirm } = await import('@cliffy/prompt')
      const proceed = await Confirm.prompt({
        message: 'Are you SURE you want to overwrite the root filesystem?',
        default: false,
      })
      if (!proceed) {
        console.log(colors.yellow('Import cancelled.'))
        return
      }
    } else {
      console.log(
        colors.yellow(
          '   --yes provided — proceeding without interactive confirmation.',
        ),
      )
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
