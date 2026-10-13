import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import { getStorageAccessKey, getUserApiAuth } from '/lib/getApiKeyFromYml.ts'
import type { UserApiAuth } from '/lib/userApi/auth.ts'
import {
  presignDownload,
  storageList,
  StorageApiError,
  type StorageRegion,
} from '/src/storage/api.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import { Select } from '@cliffy/prompt'
import { currentHostname, hasRestic, resticRestore } from '@/backup/restic.ts'
import {
  SYSTEM_IDENTITY_EXCLUDES,
  tarExtractExcludeArgs,
} from '@/backup/excludes.ts'

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

const ARCHIVE_NAME = /^backup-(.+)-\d{8}-\d{6}\.tar\.(?:zst|gz)$/

/**
 * The host an archive was taken on: the `<hostname>` of its
 * `backup-<hostname>-<timestamp>.tar.(zst|gz)` name, or null for any other name.
 */
export function archiveHostname(path: string): string | null {
  const name = path.split('/').pop() ?? ''
  return ARCHIVE_NAME.exec(name)?.[1] ?? null
}

/**
 * A tar restore writes over this host's own files, so an archive taken on
 * another host is refused unless --other-host says that is meant. A name that
 * carries no host (a renamed archive, or one made with -o) cannot be checked and
 * is refused the same way.
 */
async function requireSameHost(
  path: string,
  otherHost: boolean,
): Promise<void> {
  const name = path.split('/').pop() ?? path
  const archiveHost = archiveHostname(path)
  if (archiveHost === null) {
    if (otherHost) {
      console.log(
        colors.yellow(
          `\n⚠️  Cannot tell which host ${name} was taken on: its name is not backup-<hostname>-<timestamp>. Restoring it because --other-host was given.`,
        ),
      )
      return
    }
    console.log(
      colors.red(
        `\n❌ Cannot tell which host ${name} was taken on: its name is not backup-<hostname>-<timestamp>.`,
      ),
    )
    console.log(
      colors.yellow(
        '   If it was taken on this host, or you mean to restore it anyway, run the restore again with --other-host.\n',
      ),
    )
    Deno.exit(1)
  }
  const thisHost = await currentHostname()
  if (archiveHost.toLowerCase() === thisHost.toLowerCase()) return
  if (otherHost) {
    console.log(
      colors.yellow(
        `\n⚠️  ${name} was taken on ${archiveHost}, not on this host (${thisHost}). Restoring it because --other-host was given.`,
      ),
    )
    return
  }
  console.log(
    colors.red(
      `\n❌ ${name} was taken on ${archiveHost}, not on this host (${thisHost}).`,
    ),
  )
  console.log(
    colors.white(
      "   Restoring it would overwrite this host's files with another host's.",
    ),
  )
  console.log(
    colors.yellow(
      '   If that is what you want, run the restore again with --other-host.\n',
    ),
  )
  Deno.exit(1)
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
  const file = await Deno.open(output, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  })
  await res.body.pipeTo(file.writable)
}

async function selectRemoteBackup(
  auth: UserApiAuth,
  region?: StorageRegion,
): Promise<string | null> {
  const spinner = new Kia(colors.cyan('Fetching backup list...'))
  spinner.start()

  try {
    const list = await storageList(auth, { prefix: 'backups/', region })
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

    const selected = await Select.prompt<string>({
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
    otherHost?: boolean
    includeSystem?: boolean
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

    const storageKey = await getStorageAccessKey()

    console.log(colors.bold(colors.red('\n⚠️  WARNING: This will restore restic snapshot over the current filesystem.')))
    console.log(colors.white(`\n  Snapshot: ${file}`))
    console.log(colors.white(`  Target:   /`))
    printRestoreScope(options, 'snapshot')

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

    await resticRestore(storageKey, file, options.region, {
      otherHost: options.otherHost,
      includeSystem: options.includeSystem,
    })
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

        const storageKey = await getStorageAccessKey()
        console.log(colors.white('\n  Target:       /'))
        printRestoreScope(options, 'snapshot')
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

        await resticRestore(storageKey, undefined, options.region, {
          otherHost: options.otherHost,
          includeSystem: options.includeSystem,
        })
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
  let downloadDir: string | undefined

  if (file && await fileExists(file)) {
    // Local file provided
    await requireSameHost(file, !!options.otherHost)
    localFile = file
  } else {
    // A named remote archive carries its host in the name: decide before signing
    // in or downloading anything.
    if (file) {
      await requireSameHost(
        file.startsWith('backups/') ? file : `backups/${file}`,
        !!options.otherHost,
      )
    }

    // Download from cloud storage
    const auth = await getUserApiAuth()
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
      remotePath = await selectRemoteBackup(auth, region)
    }

    if (!remotePath) {
      console.log(colors.yellow('No backup selected.\n'))
      return
    }

    // Picked from the list: decide before downloading.
    if (!file) await requireSameHost(remotePath, !!options.otherHost)

    const spinner = new Kia(colors.cyan('Requesting download URL...'))
    spinner.start()

    try {
      const presign = await presignDownload(auth, remotePath, region)
      spinner.succeed('Got download URL')

      const filename = remotePath.split('/').pop() || 'backup.tar.zst'
      // Download into a directory of its own (mode 0700); it is removed when the
      // restore ends.
      downloadDir = await Deno.makeTempDir({ prefix: 'slv-restore-' })
      localFile = `${downloadDir}/${filename}`

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
      await removeDownload(downloadDir)
      return
    }
  }

  // Deno.exit does not run finally blocks, so restoreArchive returns the exit
  // code and the downloaded archive is removed before the process exits.
  let exitCode: number
  try {
    exitCode = await restoreArchive(localFile, options)
  } finally {
    await removeDownload(downloadDir)
  }
  if (exitCode !== 0) Deno.exit(exitCode)
}

/** Remove the directory a downloaded archive was written to. */
async function removeDownload(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await Deno.remove(dir, { recursive: true })
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return
    const reason = String(error)
    console.log(
      colors.yellow(
        `\n⚠️  Could not remove the downloaded archive in ${dir}: ${reason}`,
      ),
    )
  }
}

/**
 * What a restore leaves alone. `source` names what is restored from; a snapshot
 * restore also says whose snapshots it takes.
 */
function printRestoreScope(
  options: { otherHost?: boolean; includeSystem?: boolean },
  source: 'archive' | 'snapshot',
): void {
  const systemPaths = SYSTEM_IDENTITY_EXCLUDES.join(', ')
  if (source === 'snapshot') {
    console.log(
      colors.white(
        options.otherHost
          ? '  Snapshots:    any host (--other-host)'
          : '  Snapshots:    this host only',
      ),
    )
  }
  if (options.includeSystem) {
    console.log(
      colors.red(`  System:       ${systemPaths} come from the ${source}`),
    )
  } else {
    console.log(
      colors.white(`  Not restored: ${systemPaths} (--include-system)`),
    )
  }
  console.log(colors.white('  Never restored: key material and credentials\n'))
}

/** The `tar -x` command line for a restore over `/`. */
export function buildTarExtractArgs(options: {
  localFile: string
  useZstd: boolean
  includeSystem: boolean
}): string[] {
  const excludes = tarExtractExcludeArgs({
    includeSystem: options.includeSystem,
  })
  return options.useZstd
    ? ['-I', 'zstd -d', '-xf', options.localFile, '-C', '/', ...excludes]
    : ['--gzip', '-xf', options.localFile, '-C', '/', ...excludes]
}

/** Extract a tar archive over `/`. Returns the process exit code. */
async function restoreArchive(
  localFile: string,
  options: { yes?: boolean; includeSystem?: boolean },
): Promise<number> {
  // Detect compression
  const useZstd = localFile.endsWith('.tar.zst')
  if (useZstd && !(await hasZstd())) {
    console.log(
      colors.red(
        '❌ This backup uses zstd compression but zstd is not installed.',
      ),
    )
    console.log(colors.yellow('   Install zstd: apt install zstd\n'))
    return 1
  }

  // Root check
  if (Deno.uid() !== 0) {
    console.log(
      colors.red(
        '\n❌ Restore must be run as root to extract files to /.',
      ),
    )
    console.log(colors.yellow('   Run with: sudo slv backup restore\n'))
    return 1
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
    colors.white(`  Target:      /`),
  )
  printRestoreScope(options, 'archive')

  // Confirmation for download/general proceed (skipped with --yes)
  if (!options.yes) {
    const { Confirm } = await import('@cliffy/prompt')
    const proceed = await Confirm.prompt({
      message: 'Proceed with restore?',
      default: false,
    })
    if (!proceed) {
      console.log(colors.yellow('\n⚠️  Restore cancelled.\n'))
      return 0
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
        return 0
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
  const tarArgs = buildTarExtractArgs({
    localFile,
    useZstd,
    includeSystem: !!options.includeSystem,
  })

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
      return 1
    }

    spinner.succeed('Restore complete')
  } catch (error) {
    spinner.fail('Restore failed')
    console.log(colors.red(String(error)))
    return 1
  }

  console.log(
    colors.green('\n✅ Import completed. Please reboot to apply changes:'),
  )
  console.log(colors.white('   $ sudo reboot\n'))
  return 0
}
