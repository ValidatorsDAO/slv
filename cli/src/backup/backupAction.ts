import { colors } from '@cliffy/colors'
import Kia from 'https://deno.land/x/kia@0.4.1/mod.ts'
import {
  type CredentialProblem,
  printCredentialProblem,
  resolveStorageAccessKey,
  sanitizeSudoUser,
} from '/lib/getApiKeyFromYml.ts'
import { formatBytes } from '/src/storage/upload/uploadAction.ts'
import {
  type BackupTool,
  buildExcludeList,
  findExistingPaths,
  printExcludes,
  type PrivateKeyFinder,
  searchSshKeys,
  secretExcludes,
  type SshKeySearch,
  sshScanNote,
} from '@/backup/excludes.ts'
import { setupCron } from '@/backup/cron.ts'
import { resticBackup, type ResticBackupOptions } from '@/backup/restic.ts'
import { notifyDiscordWebhook } from '/lib/notifyDiscordWebhook.ts'

/**
 * Resolve the webhook URL from (in priority order):
 * 1. --webhook CLI option
 * 2. SLV_BACKUP_WEBHOOK environment variable
 * 3. Original user's environment when running under sudo
 *
 * This must be called BEFORE any sudo escalation to capture the env
 * before sudo resets it.
 */
function getWebhookUrl(cliOption?: string): string | undefined {
  // 1. CLI option always wins
  if (cliOption) return cliOption

  // 2. Direct environment variable (works in cron and sudo -E)
  const direct = Deno.env.get('SLV_BACKUP_WEBHOOK')
  if (direct) return direct

  // 3. When running under sudo, check the original user's environment
  const sudoUser = sanitizeSudoUser()
  if (sudoUser) {
    try {
      const cmd = new Deno.Command('su', {
        args: ['-', sudoUser, '-c', 'echo $SLV_BACKUP_WEBHOOK'],
        stdout: 'piped',
        stderr: 'piped',
      })
      const result = cmd.outputSync()
      const val = new TextDecoder().decode(result.stdout).trim()
      if (val) return val
    } catch {
      // ignore — su may not be available or user shell may fail
    }
  }

  return undefined
}

/**
 * Wrapper around the shared {@link notifyDiscordWebhook} helper.
 * Kept here as a thin rename so the ~six call sites below don't need
 * to be touched when the default timeout / result handling shifts.
 */
const notifyWebhook = (webhookUrl: string, message: string): Promise<unknown> =>
  notifyDiscordWebhook(webhookUrl, message)

/**
 * The backup cannot get its ERPC credential (no login, an expired login, a
 * failed refresh, or no storage access key). A scheduled run has nobody
 * watching its output, so tell the webhook too, then exit 1.
 */
async function stopWithoutCredential(
  problem: CredentialProblem,
  webhookUrl: string | undefined,
): Promise<never> {
  printCredentialProblem(problem)
  if (webhookUrl) {
    await notifyWebhook(
      webhookUrl,
      `❌ **SLV Backup Failed**\n**Host**: ${await getHostname()}\n**Error**: ${problem.lines[0]}\nRun \`slv login\` on this host to sign in to ERPC again.`,
    )
  }
  Deno.exit(1)
}

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

/** What a request for an unencrypted upload asked for. */
export type PlainBackupRequest = 'upload' | 'cron'

/**
 * A plain tar archive is not encrypted, so it is never uploaded and never
 * scheduled for upload. `--restic` is the encrypted path; `--cron off` schedules
 * nothing, so it stays available to remove an older schedule.
 */
export function plainBackupRequest(options: {
  upload?: boolean
  cron?: string
  restic?: boolean
}): PlainBackupRequest | null {
  if (options.restic) return null
  if (options.upload) return 'upload'
  if (options.cron && options.cron !== 'off') return 'cron'
  return null
}

function plainBackupRefusal(request: PlainBackupRequest): string[] {
  if (request === 'upload') {
    return [
      'A plain tar archive is never uploaded: it is not encrypted.',
      'Back up to cloud storage with restic, which encrypts on this host before anything leaves it:',
      '  slv backup create --restic -y',
      'Restic signs in with your ERPC login: run `slv login` first if this host has not.',
      'Without --restic the archive stays on this host:  slv backup create -y',
      'A cron job from an older version still calls --upload. Replace it:  slv backup create --cron daily --restic -y',
    ]
  }
  return [
    'A plain tar archive is never scheduled for upload: it is not encrypted.',
    'Schedule the encrypted backup instead:',
    '  slv backup create --cron daily --restic -y',
    'To stop an existing schedule:  slv backup create --cron off',
  ]
}

/**
 * Refuse a plain upload or a plain schedule before any archive is created. An
 * unattended run (a cron entry written by an older version calls --upload) has
 * nobody watching its output, so the webhook hears about it too.
 */
async function refusePlainBackup(
  request: PlainBackupRequest,
  webhookUrl: string | undefined,
): Promise<never> {
  const lines = plainBackupRefusal(request)
  console.log(colors.red(`\n❌ ${lines[0]}\n`))
  for (const line of lines.slice(1)) console.log(colors.white(`  ${line}`))
  console.log('')
  if (request === 'upload' && webhookUrl) {
    const host = await getHostname()
    await notifyWebhook(
      webhookUrl,
      ['❌ **SLV Backup Refused**', `**Host**: ${host}`, ...lines].join('\n'),
    )
  }
  Deno.exit(1)
}

/** tar runs under this umask, so it creates the archive with mode 0600. */
const PRIVATE_TAR_SCRIPT = 'umask 077 && exec tar "$@"'

/**
 * The command that writes the local archive. The archive is private to its
 * owner (mode 0600), whatever the output path.
 */
export function buildTarCreateCommand(options: {
  useSudo: boolean
  useZstd: boolean
  excludes: string[]
  output: string
}): { cmd: string; args: string[] } {
  const excludeArgs = options.excludes.flatMap((e) => ['--exclude', e])
  // Also exclude the output file itself
  excludeArgs.push(
    '--exclude',
    options.output.startsWith('/') ? options.output : `./${options.output}`,
  )

  const tarArgs: string[] = []
  if (options.useZstd) {
    tarArgs.push('-I', 'zstd -T0', ...excludeArgs, '-cf', options.output, '/')
  } else {
    tarArgs.push('--gzip', ...excludeArgs, '-cf', options.output, '/')
  }

  const wrapped = ['sh', '-c', PRIVATE_TAR_SCRIPT, 'tar', ...tarArgs]
  return options.useSudo
    ? { cmd: 'sudo', args: wrapped }
    : { cmd: wrapped[0], args: wrapped.slice(1) }
}

/**
 * tar writes into a file that is already there without changing its mode, so a
 * regular file left at the output path (an earlier archive, or any file) is
 * brought to 0600 before tar writes a byte into it. A path that does not exist
 * yet is created by tar under umask 077.
 */
async function makeExistingArchivePrivate(output: string): Promise<void> {
  let info: Deno.FileInfo
  try {
    info = await Deno.stat(output)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return
    throw error
  }
  if (info.isFile && ((info.mode ?? 0) & 0o077) !== 0) {
    await Deno.chmod(output, 0o600)
  }
}

/** What `backupAction` looks things up with; replaced in tests. */
export interface BackupDeps {
  /** The files and directories on this host that match `patterns`. */
  findFiles?: (patterns: readonly string[]) => Promise<string[]> | string[]
  /** The SSH private keys this user can find on this host, by path. */
  findPrivateKeys?: PrivateKeyFinder
  /** The same search as root (through sudo), for a run whose tar runs under sudo. */
  findPrivateKeysAsRoot?: PrivateKeyFinder
  /** The .ssh directories this user cannot list. */
  findUnlistedSshDirs?: () => Promise<string[]> | string[]
}

const OFFLINE_COPY =
  'Keep an offline copy of these files: this backup does not contain them.'

/**
 * The key material and wallets on this host that a backup read by `tool` leaves
 * out, the SSH private keys found under any name, and the .ssh directories left
 * out as a whole.
 */
async function filesLeftOut(
  tool: BackupTool,
  deps: BackupDeps,
  search: SshKeySearch,
): Promise<string[]> {
  const find = deps.findFiles ?? ((patterns) => findExistingPaths(patterns))
  let found: string[] = []
  try {
    found = await find(secretExcludes(tool))
  } catch {
    // nothing found by pattern
  }
  const wholeDirs = search.wholeDirs.map((dir) =>
    `${dir}  (the whole directory: this user could not list it)`
  )
  return [...new Set([...found, ...search.keys, ...wholeDirs])].sort()
}

function printLeftOut(files: string[]): void {
  // the search runs as the user who started the backup, not as root
  const notRoot = Deno.uid() !== 0
  if (files.length === 0 && !notRoot) return
  if (files.length > 0) {
    console.log(colors.yellow('\n⚠️  Left out of this backup:'))
    for (const file of files) console.log(colors.white(`   ${file}`))
    console.log(colors.yellow(`   ${OFFLINE_COPY}`))
  }
  if (notRoot) {
    console.log(
      colors.dim(
        '   Files only root can read are not in this list; run as root to list them.',
      ),
    )
  }
  console.log('')
}

/** Post the list to the webhook, in as many messages as Discord's size limit needs. */
async function postLeftOut(
  webhookUrl: string | undefined,
  host: string,
  files: string[],
): Promise<void> {
  if (!webhookUrl || files.length === 0) return
  const head = `⚠️ **SLV Backup left these files out**\n**Host**: ${host}`
  const limit = 1800 - OFFLINE_COPY.length
  const messages: string[] = []
  let message = head
  for (const file of files) {
    if (message !== head && message.length + file.length + 1 > limit) {
      messages.push(`${message}\n${OFFLINE_COPY}`)
      message = head
    }
    message += `\n${file}`
  }
  messages.push(`${message}\n${OFFLINE_COPY}`)
  for (const text of messages) await notifyWebhook(webhookUrl, text)
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
  webhook?: string
  restic?: boolean
  yes?: boolean
}, deps: BackupDeps = {}) => {
  // Capture webhook URL BEFORE any sudo escalation resets the environment
  const webhookUrl = getWebhookUrl(options.webhook)

  const tool: BackupTool = options.restic ? 'restic' : 'tar'

  // SSH private keys under any name are looked for once, when a list is built,
  // with the privilege of the archiver: as root too when tar runs under sudo
  let scan: Promise<SshKeySearch> | undefined
  const sshSearch = (underSudo = false): Promise<SshKeySearch> =>
    scan ??= searchSshKeys({
      underSudo,
      find: deps.findPrivateKeys,
      findAsRoot: deps.findPrivateKeysAsRoot,
      findUnlisted: deps.findUnlistedSshDirs,
    })
  const buildList = async (underSudo = false): Promise<string[]> => {
    const search = await sshSearch(underSudo)
    return buildExcludeList({
      extraExcludes: options.exclude,
      extraIncludes: options.include,
      includeSSH: true, // backup includes SSH files
      tool,
      privateKeys: search.keys,
      unlistedSshDirs: search.wholeDirs,
    })
  }

  // --list-excludes: show and exit
  if (options.listExcludes) {
    printExcludes(await buildList())
    return
  }

  // A plain tar archive is never uploaded and never scheduled for upload: only
  // --restic, which encrypts before anything leaves this host, may do either.
  const plain = plainBackupRequest(options)
  if (plain) return await refusePlainBackup(plain, webhookUrl)

  // --cron: set up cron job (restic only; `--cron off` removes it)
  if (options.cron) {
    await setupCron(options.cron, options.retention ?? 7, !!options.restic)
    if (!options.restic) return // cron-only mode
  }

  // --restic: use restic for incremental backup
  if (options.restic) {
    // Pre-flight: restic connects with the storage access key
    const storage = await resolveStorageAccessKey()
    if (!storage.ok) return await stopWithoutCredential(storage, webhookUrl)
    const storageKey = storage.key
    const hostname = await getHostname()
    const excludes = await buildList()
    const resticOpts: ResticBackupOptions = {
      region: options.region,
      exclude: options.exclude,
      include: options.include,
      retention: options.retention,
      findPrivateKeys: async () => (await sshSearch()).keys,
    }

    console.log(colors.bold(colors.blue('\n🗄️  SLV Backup (restic mode)\n')))
    console.log(colors.white(`  Region:    ${options.region || 'default'}`))
    console.log(colors.white(`  Retention: ${options.retention ?? 7} days`))
    printExcludes(excludes)

    if (!options.yes) {
      const { Confirm } = await import('@cliffy/prompt')
      const proceed = await Confirm.prompt({
        message: 'Create restic backup?',
        default: true,
      })
      if (!proceed) {
        console.log(colors.yellow('\n⚠️  Backup cancelled.\n'))
        return
      }
    }

    try {
      await resticBackup(storageKey, resticOpts)
      if (webhookUrl) {
        await notifyWebhook(
          webhookUrl,
          `✅ **SLV Restic Backup Complete**\n**Host**: ${hostname}\n**Region**: ${options.region || 'default'}`,
        )
      }
    } catch (error) {
      if (webhookUrl) {
        await notifyWebhook(
          webhookUrl,
          `❌ **SLV Restic Backup Failed**\n**Host**: ${hostname}\n**Error**: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      throw error
    }

    const left = await filesLeftOut(tool, deps, await sshSearch())
    printLeftOut(left)
    await postLeftOut(webhookUrl, hostname, left)

    console.log(colors.green('\n✅ Backup complete.\n'))
    return
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

  const excludes = await buildList(useSudo)

  // Show plan
  console.log(colors.bold(colors.blue('\n🗄️  SLV Backup\n')))
  console.log(colors.white(`  Output:      ${output}`))
  console.log(colors.white(`  Compression: ${useZstd ? 'zstd (multi-threaded)' : 'gzip'}`))
  console.log(colors.white('  Mode:        0600 (owner only)'))
  console.log(
    colors.white(
      '  Upload:      no (a plain tar archive stays on this host; --restic backs up to cloud storage)',
    ),
  )

  printExcludes(excludes)
  const search = await sshSearch(useSudo)
  if (search.rootSearchFailed) {
    console.log(
      colors.yellow(
        sshScanNote('tar', search.wholeDirs, 'sudo slv backup create'),
      ),
    )
  }

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
  const tar = buildTarCreateCommand({ useSudo, useZstd, excludes, output })

  const spinner = new Kia(colors.cyan('Creating backup archive...'))
  spinner.start()

  try {
    await makeExistingArchivePrivate(output)
    const command = new Deno.Command(tar.cmd, {
      args: tar.args,
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
    const fileSizeFormatted = formatBytes(fileInfo.size ?? 0)
    spinner.succeed(
      `Backup created: ${output} (${fileSizeFormatted})`,
    )

    // Notify webhook on backup creation success
    if (webhookUrl) {
      await notifyWebhook(
        webhookUrl,
        `✅ **SLV Backup Complete**\n**Host**: ${hostname}\n**File**: ${output}\n**Size**: ${fileSizeFormatted}`,
      )
    }
  } catch (error) {
    spinner.fail('Backup failed')
    console.log(colors.red(String(error)))

    // Notify webhook on backup failure
    if (webhookUrl) {
      await notifyWebhook(
        webhookUrl,
        `❌ **SLV Backup Failed**\n**Host**: ${hostname}\n**Error**: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    Deno.exit(1)
  }

  const left = await filesLeftOut(tool, deps, search)
  printLeftOut(left)
  await postLeftOut(webhookUrl, hostname, left)

  console.log(colors.green('\n✅ Backup complete.\n'))
  console.log(
    colors.dim(
      '   This archive stays on this host. For an encrypted cloud backup run: slv backup create --restic -y\n',
    ),
  )
}
