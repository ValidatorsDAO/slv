import { colors } from '@cliffy/colors'

/** Default exclude list — system pseudo-filesystems and volatile dirs */
export const DEFAULT_EXCLUDES = [
  '/dev/*',
  '/proc/*',
  '/sys/*',
  '/tmp/*',
  '/run/*',
  '/mnt/*',
  '/media/*',
  '/lost+found',
  '/swapfile',
  '/snap/*',
]

/** SSH-related excludes (used by migrate linux to preserve remote access) */
export const SSH_EXCLUDES = [
  '/root/.ssh/authorized_keys',
  '/home/*/.ssh/authorized_keys',
  '/etc/ssh/sshd_config',
  '/etc/ssh/sshd_config.d/*',
  '/etc/ssh/ssh_host_*',
]

/**
 * Read custom excludes from SLV_BACKUP_EXCLUDES env var.
 * Comma-separated: export SLV_BACKUP_EXCLUDES="/var/log/journal/*,/home/solv/.cache/*"
 */
export function getCustomExcludes(): string[] {
  const env = Deno.env.get('SLV_BACKUP_EXCLUDES') || ''
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Build a unified exclude list from defaults, env var, and CLI options.
 */
export function buildExcludeList(options: {
  extraExcludes?: string[]
  extraIncludes?: string[] // paths to remove from the exclude list
  includeSSH?: boolean // true for backup (keep SSH files), false for migrate
}): string[] {
  const base = [...DEFAULT_EXCLUDES]
  if (!options.includeSSH) {
    base.push(...SSH_EXCLUDES)
  }
  const custom = getCustomExcludes()
  const all = [...base, ...custom, ...(options.extraExcludes || [])]

  const includes = new Set(options.extraIncludes || [])
  return all.filter((e) => !includes.has(e))
}

/** Pretty-print the current exclude list */
export function printExcludes(excludes: string[]): void {
  console.log(colors.bold('\n📋 Current exclude list:\n'))
  for (const e of excludes) {
    console.log(colors.dim(`  • ${e}`))
  }
  console.log(
    colors.yellow(
      '\n⚠️  Default excludes protect system pseudo-filesystems (/dev, /proc, /sys, etc.)',
    ),
  )
  console.log(
    colors.yellow(
      '   Modifying these may cause backup corruption or extremely large archives.',
    ),
  )
  console.log(
    colors.yellow(
      '   Use SLV_BACKUP_EXCLUDES env var or --exclude/--include CLI options to customize.\n',
    ),
  )
}
