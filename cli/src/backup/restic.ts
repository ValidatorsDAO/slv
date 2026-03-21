import { colors } from '@cliffy/colors'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { buildExcludeList } from '@/backup/excludes.ts'

const RESTIC_PASSWORD_FILE_NAME = '.slv/restic-password'
const RESTIC_REPO_HOST = 'user-api.erpc.global'
const RESTIC_REPO_PATH = '/v3/storage/restic/'

/**
 * NOTE on REST backend authentication:
 *
 * restic uses Basic Auth for REST backend URLs.  We embed the API key as the
 * username in the URL: rest:https://<apiKey>:x@host/path
 *
 * The user-api accepts both Bearer and Basic auth.  With Basic auth the
 * username is treated as the API key and the password is ignored.
 *
 * This works with all restic versions (0.14+).
 */

/** Build the restic repository URL with embedded Basic Auth credentials. */
function resticRepoUrl(apiKey: string, region?: string): string {
  const base = `rest:https://${encodeURIComponent(apiKey)}:x@${RESTIC_REPO_HOST}${RESTIC_REPO_PATH}`
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
}

/**
 * Create a backup using restic.
 */
export async function resticBackup(
  apiKey: string,
  options: ResticBackupOptions,
): Promise<void> {
  if (!(await hasRestic())) {
    printResticInstallGuide()
    Deno.exit(1)
  }

  await getOrCreateResticPassword() // ensure password file exists
  const repo = resticRepoUrl(apiKey, options.region)

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
  })
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e])
  // Exclude sensitive credential files from backup
  excludeArgs.push('--exclude', resticPasswordPath())
  excludeArgs.push('--exclude', `${resolveHome()}/.slv/api.yml`)
  excludeArgs.push('--exclude', `${resolveHome()}/.slv/backup.env`)

  // Get hostname for tagging
  const hostnameCmd = new Deno.Command('hostname', { stdout: 'piped', stderr: 'piped' })
  const hostnameResult = await hostnameCmd.output()
  const hostname = new TextDecoder().decode(hostnameResult.stdout).trim() || 'unknown'

  // restic init (first time only — ignore "already initialized" error)
  console.log(colors.cyan('\n🔧 Initializing restic repository (if needed)...'))
  const initResult = await runRestic(['init'], env)
  if (!initResult.success && !initResult.stderr.includes('already initialized')) {
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

/**
 * Restore from a restic snapshot.
 */
export async function resticRestore(
  apiKey: string,
  snapshotId?: string,
  region?: string,
): Promise<void> {
  if (!(await hasRestic())) {
    printResticInstallGuide()
    Deno.exit(1)
  }

  await getResticPassword() // validate password file exists
  const repo = resticRepoUrl(apiKey, region)

  const env = {
    RESTIC_REPOSITORY: repo,
    RESTIC_PASSWORD_FILE: resticPasswordPath(),
  }

  console.log(colors.cyan('\n📥 Restoring from restic snapshot...'))
  const result = await runRestic(
    [
      'restore',
      snapshotId || 'latest',
      '--target',
      '/',
    ],
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
 * List restic snapshots.
 * Returns raw JSON output from restic.
 */
export async function resticSnapshots(
  apiKey: string,
  region?: string,
): Promise<string> {
  if (!(await hasRestic())) {
    printResticInstallGuide()
    Deno.exit(1)
  }

  await getResticPassword() // validate password file exists
  const repo = resticRepoUrl(apiKey, region)

  const env = {
    ...Deno.env.toObject(),
    RESTIC_REPOSITORY: repo,
    RESTIC_PASSWORD_FILE: resticPasswordPath(),
  }

  const command = new Deno.Command('restic', {
    args: ['snapshots', '--json'],
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
