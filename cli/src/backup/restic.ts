import { colors } from '@cliffy/colors'
import { resolveHome, type StorageAccessKey } from '/lib/getApiKeyFromYml.ts'
import {
  buildExcludeList,
  findPrivateKeys,
  KEY_MATERIAL_EXCLUDES,
  type PrivateKeyFinder,
  SYSTEM_IDENTITY_EXCLUDES,
} from '@/backup/excludes.ts'

const RESTIC_PASSWORD_FILE_NAME = '.slv/restic-password'
const RESTIC_REPO_HOST = 'user-api.erpc.global'
const RESTIC_REPO_PATH = '/v3/storage/restic'

/**
 * NOTE on REST backend authentication:
 *
 * restic uses Basic Auth for REST backend URLs.  We embed the storage access
 * key in the URL: rest:https://<keyId>:<secret>@host/path — the key id is the
 * username and the secret is the password.  The REST path accepts only a
 * storage access key; an ERPC login access token or an API key is not accepted
 * there.
 *
 * The credentials stay in the URL (rather than RESTIC_REST_USERNAME /
 * RESTIC_REST_PASSWORD) because restic 0.16, which Ubuntu 24.04 ships, does
 * not read those variables.  The URL works with all restic versions (0.14+).
 */

/** Build the restic repository URL with embedded Basic Auth credentials. */
function resticRepoUrl(key: StorageAccessKey, region?: string): string {
  const base =
    `rest:https://${encodeURIComponent(key.id)}:${encodeURIComponent(key.secret)}@${RESTIC_REPO_HOST}${RESTIC_REPO_PATH}`
  if (region) {
    return `${base}?region=${encodeURIComponent(region)}`
  }
  return base
}

function resticPasswordPath(): string {
  return `${resolveHome()}/${RESTIC_PASSWORD_FILE_NAME}`
}

/** Check whether restic is installed. */
export async function hasRestic(): Promise<boolean> {
  try {
    const cmd = new Deno.Command('which', {
      args: ['restic'],
      stdout: 'piped',
      stderr: 'piped',
    })
    return (await cmd.output()).success
  } catch {
    return false
  }
}

/**
 * This host's name as `slv backup create` puts it in its tags and archive names:
 * the `hostname` command's.
 */
export async function currentHostname(): Promise<string> {
  try {
    const command = new Deno.Command('hostname', {
      stdout: 'piped',
      stderr: 'piped',
    })
    const result = await command.output()
    const name = new TextDecoder().decode(result.stdout).trim()
    if (name) return name
  } catch {
    // no hostname command: ask the OS
  }
  try {
    return Deno.hostname()
  } catch {
    return 'unknown'
  }
}

/** Print installation guidance when restic is missing. */
export function printResticInstallGuide(): void {
  console.log(colors.red('\n❌ restic is not installed.\n'))
  console.log(colors.white('  Install via package manager:'))
  console.log(colors.cyan('    apt install restic        # Debian / Ubuntu'))
  console.log(colors.cyan('    dnf install restic        # Fedora / RHEL'))
  console.log(colors.cyan('    pacman -S restic           # Arch'))
  console.log(colors.white('\n  Or download from: https://github.com/restic/restic/releases\n'))
}

/**
 * Run a restic command with the given args and environment.
 * Streams stdout/stderr to the terminal.
 */
async function runRestic(
  args: string[],
  env: Record<string, string>,
): Promise<{ success: boolean; code: number; stderr: string }> {
  const command = new Deno.Command('restic', {
    args,
    env: { ...Deno.env.toObject(), ...env },
    stdout: 'inherit',
    stderr: 'piped',
  })
  const result = await command.output()
  const stderr = new TextDecoder().decode(result.stderr)
  return { success: result.success, code: result.code, stderr }
}

/**
 * Get the restic encryption password, creating one if it doesn't exist.
 */
export async function getOrCreateResticPassword(): Promise<string> {
  const filePath = resticPasswordPath()
  try {
    return (await Deno.readTextFile(filePath)).trim()
  } catch {
    // Generate a new password
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const password = btoa(String.fromCharCode(...bytes))
      .replace(/[+/=]/g, '')
      .slice(0, 48)

    const slvDir = `${resolveHome()}/.slv`
    await Deno.mkdir(slvDir, { recursive: true, mode: 0o700 })
    await Deno.writeTextFile(filePath, password + '\n', { mode: 0o600 })

    console.log(colors.yellow('\n⚠️  Restic encryption password generated and saved to:'))
    console.log(colors.white(`   ${filePath}`))
    console.log(
      colors.yellow('   BACK UP THIS FILE — without it, backups cannot be restored.\n'),
    )

    return password
  }
}

/**
 * Get the existing restic password. Throws if not found.
 */
export async function getResticPassword(): Promise<string> {
  const filePath = resticPasswordPath()
  try {
    const pw = (await Deno.readTextFile(filePath)).trim()
    if (!pw) throw new Error('empty')
    return pw
  } catch {
    console.log(colors.red(`\n❌ Restic password file not found: ${filePath}`))
    console.log(
      colors.yellow(
        '   This file is created during the first backup.\n' +
          '   If you are restoring on a new machine, copy the password file first.\n',
      ),
    )
    Deno.exit(1)
  }
}

/** Options for resticBackup. */
export interface ResticBackupOptions {
  region?: string
  exclude?: string[]
  include?: string[]
  retention?: number
  /** Stands in for RESTIC_INCLUDES_WALLETS. */
  resticIncludesWallets?: boolean
  /** Looks for SSH private keys; the search of this host when absent. */
  findPrivateKeys?: PrivateKeyFinder
}

/**
 * Create a backup using restic.
 */
export async function resticBackup(
  key: StorageAccessKey,
  options: ResticBackupOptions,
): Promise<void> {
  if (!(await hasRestic())) {
    printResticInstallGuide()
    Deno.exit(1)
  }

  await getOrCreateResticPassword() // ensure password file exists
  const repo = resticRepoUrl(key, options.region)

  // Use RESTIC_PASSWORD_FILE instead of RESTIC_PASSWORD to avoid
  // leaking the passphrase via /proc/{pid}/environ.
  const env = {
    RESTIC_REPOSITORY: repo,
    RESTIC_PASSWORD_FILE: resticPasswordPath(),
  }

  // Build exclude list
  const excludes = buildExcludeList({
    extraExcludes: options.exclude,
    extraIncludes: options.include,
    includeSSH: true,
    tool: 'restic',
    resticIncludesWallets: options.resticIncludesWallets,
    privateKeys: await (options.findPrivateKeys ?? findPrivateKeys)(),
  })
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e])
  // Exclude sensitive credential files from backup
  excludeArgs.push('--exclude', resticPasswordPath())
  excludeArgs.push('--exclude', `${resolveHome()}/.slv/api.yml`)
  excludeArgs.push('--exclude', `${resolveHome()}/.slv/backup.env`)

  // Get hostname for tagging
  const hostname = await currentHostname()

  // restic init (first time only — ignore "already initialized" error)
  console.log(colors.cyan('\n🔧 Initializing restic repository (if needed)...'))
  const initResult = await runRestic(['init'], env)
  if (!initResult.success && !initResult.stderr.includes('already initialized') && !initResult.stderr.includes('config file already exists')) {
    console.log(colors.red('\n❌ Failed to initialize restic repository'))
    if (initResult.stderr) console.log(colors.red(initResult.stderr))
    Deno.exit(1)
  }

  // restic backup
  console.log(colors.cyan('\n📦 Creating restic backup...'))
  const backupResult = await runRestic(
    [
      'backup',
      '/',
      ...excludeArgs,
      '--tag',
      `host:${hostname}`,
    ],
    env,
  )

  if (!backupResult.success) {
    // restic exit code 3 = warnings (incomplete backup), 1 = fatal
    if (backupResult.code === 1) {
      console.log(colors.red('\n❌ Restic backup failed'))
      if (backupResult.stderr) console.log(colors.red(backupResult.stderr))
      Deno.exit(1)
    }
    // Code 3 = warnings, continue
    if (backupResult.stderr) {
      console.log(colors.yellow(`\n⚠️  Restic warnings:\n${backupResult.stderr}`))
    }
  }

  console.log(colors.green('\n✅ Restic backup complete'))

  // Retention policy
  if (options.retention && options.retention > 0) {
    console.log(colors.cyan(`\n🧹 Applying retention policy (keep within ${options.retention} days)...`))
    const forgetResult = await runRestic(
      [
        'forget',
        '--keep-within',
        `${options.retention}d`,
        '--prune',
      ],
      env,
    )

    if (!forgetResult.success) {
      console.log(
        colors.yellow(
          `\n⚠️  Retention cleanup had issues: ${forgetResult.stderr}`,
        ),
      )
    }
  }
}

/** What a restic restore leaves alone: the system identity files unless asked for, and key material. */
export function resticRestoreExcludes(includeSystem = false): string[] {
  return [
    ...(includeSystem ? [] : SYSTEM_IDENTITY_EXCLUDES),
    ...KEY_MATERIAL_EXCLUDES,
  ]
}

/**
 * The `restic restore` arguments. `host` limits "latest" to that host's
 * snapshots; without it any host's will do. Wallets are not excluded: a restic
 * backup keeps them.
 */
export function buildResticRestoreArgs(options: {
  snapshotId?: string
  host?: string
  includeSystem?: boolean
}): string[] {
  const args = ['restore', options.snapshotId || 'latest', '--target', '/']
  if (options.host) args.push('--host', options.host)
  for (const pattern of resticRestoreExcludes(options.includeSystem)) {
    args.push('--exclude', pattern)
  }
  return args
}

/** The hosts a named snapshot was taken on, or why restic could not tell. */
async function snapshotHosts(
  env: Record<string, string>,
  snapshotId: string,
): Promise<{ hosts: string[] } | { error: string }> {
  const command = new Deno.Command('restic', {
    args: ['snapshots', '--json', snapshotId],
    env: { ...Deno.env.toObject(), ...env },
    stdout: 'piped',
    stderr: 'piped',
  })
  const result = await command.output()
  if (!result.success) {
    return { error: new TextDecoder().decode(result.stderr).trim() }
  }
  const hosts: string[] = []
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout))
    const items = Array.isArray(parsed) ? parsed : []
    for (const item of items) {
      // a flat list of snapshots, or groups that hold a list each
      const group = (item as { snapshots?: unknown })?.snapshots
      const snapshots = Array.isArray(group) ? group : [item]
      for (const snapshot of snapshots) {
        const hostname = (snapshot as { hostname?: unknown })?.hostname
        if (typeof hostname === 'string' && hostname) hosts.push(hostname)
      }
    }
  } catch {
    // not JSON: no host to compare
  }
  return { hosts }
}

/** Options of a restic restore. */
export interface ResticRestoreOptions {
  /** Restore a snapshot of another host (--other-host). */
  otherHost?: boolean
  /** Restore the system identity files too (--include-system). */
  includeSystem?: boolean
}

/**
 * Restore from a restic snapshot. Only snapshots of this host unless
 * `otherHost`: "latest" is this host's latest, and a named snapshot has to have
 * been taken here. The system identity files are left alone unless
 * `includeSystem`; key material is never restored.
 */
export async function resticRestore(
  key: StorageAccessKey,
  snapshotId?: string,
  region?: string,
  options: ResticRestoreOptions = {},
): Promise<void> {
  if (!(await hasRestic())) {
    printResticInstallGuide()
    Deno.exit(1)
  }

  await getResticPassword() // validate password file exists
  const repo = resticRepoUrl(key, region)

  const env = {
    RESTIC_REPOSITORY: repo,
    RESTIC_PASSWORD_FILE: resticPasswordPath(),
  }

  const host = options.otherHost ? undefined : await currentHostname()
  if (host && snapshotId && snapshotId !== 'latest') {
    // --host picks "latest" only, so a named snapshot is checked here
    const taken = await snapshotHosts(env, snapshotId)
    if ('error' in taken) {
      console.log(
        colors.red(`\n❌ Could not read restic snapshot ${snapshotId}`),
      )
      if (taken.error) console.log(colors.red(taken.error))
      Deno.exit(1)
    }
    const elsewhere = taken.hosts.length === 0 ||
      taken.hosts.some((name) => name.toLowerCase() !== host.toLowerCase())
    if (elsewhere) {
      const where = taken.hosts.length > 0
        ? `taken on ${taken.hosts.join(', ')}`
        : 'taken on a host restic does not name'
      console.log(
        colors.red(
          `\n❌ Snapshot ${snapshotId} was ${where}, not on this host (${host}).`,
        ),
      )
      console.log(
        colors.yellow(
          '   If that is what you want, run the restore again with --other-host.\n',
        ),
      )
      Deno.exit(1)
    }
  }

  console.log(colors.cyan('\n📥 Restoring from restic snapshot...'))
  const result = await runRestic(
    buildResticRestoreArgs({
      snapshotId,
      host,
      includeSystem: options.includeSystem,
    }),
    env,
  )

  if (!result.success) {
    console.log(colors.red('\n❌ Restic restore failed'))
    if (result.stderr) console.log(colors.red(result.stderr))
    Deno.exit(1)
  }

  console.log(colors.green('\n✅ Restic restore complete'))
}

/**
 * List restic snapshots, those of every host unless `options.host` names one.
 * Returns raw JSON output from restic.
 */
export async function resticSnapshots(
  key: StorageAccessKey,
  region?: string,
  options: { host?: string } = {},
): Promise<string> {
  if (!(await hasRestic())) {
    printResticInstallGuide()
    Deno.exit(1)
  }

  await getResticPassword() // validate password file exists
  const repo = resticRepoUrl(key, region)

  const env = {
    ...Deno.env.toObject(),
    RESTIC_REPOSITORY: repo,
    RESTIC_PASSWORD_FILE: resticPasswordPath(),
  }

  const command = new Deno.Command('restic', {
    args: [
      'snapshots',
      '--json',
      ...(options.host ? ['--host', options.host] : []),
    ],
    env,
    stdout: 'piped',
    stderr: 'piped',
  })
  const result = await command.output()

  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr)
    console.log(colors.red(`\n❌ Failed to list restic snapshots: ${stderr}`))
    return '[]'
  }

  return new TextDecoder().decode(result.stdout)
}
