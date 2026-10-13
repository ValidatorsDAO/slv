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
  '/var/log/*',
  'backup-*.tar.zst',
  'backup-*.tar.gz',
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
 * Key material and credentials. A tar backup, a restic backup, a
 * `slv migrate linux` copy and a restore never carry these, and nothing takes an
 * entry out of the list: `--include` and SLV_BACKUP_EXCLUDES cannot.
 *
 * Every entry is an absolute path pattern anchored at the filesystem root. The
 * same string is the pattern for GNU tar `--exclude`, restic `--exclude` and
 * rsync `--exclude`, and a directory takes everything below it along. In restic
 * and rsync a `*` stays inside one path component, so the keypair and identity
 * patterns reach files directly inside a home directory; tar's `*` also crosses
 * `/`, so tar skips a match nested deeper as well. A plain `--exclude` cannot
 * spare `*.pub`, so `id_*` also skips the public `id_*.pub` keys.
 */
export const KEY_MATERIAL_EXCLUDES: readonly string[] = Object.freeze([
  // slv key store and validator keypair / identity files kept in a home directory
  '/root/.slv/keys',
  '/home/*/.slv/keys',
  '/root/*keypair*.json',
  '/home/*/*keypair*.json',
  '/root/*identity*.json',
  '/home/*/*identity*.json',
  // slv credentials: ERPC login and storage key, gateway token, webhook, restic password
  '/root/.slv/api.yml',
  '/home/*/.slv/api.yml',
  '/root/.slv/gateway/gateway.json',
  '/home/*/.slv/gateway/gateway.json',
  '/root/.slv/backup.env',
  '/home/*/.slv/backup.env',
  '/root/.slv/restic-password',
  '/home/*/.slv/restic-password',
  // private SSH keys: the user keys, and the host keys (the ssh_host_*.pub files are not matched)
  '/root/.ssh/id_*',
  '/home/*/.ssh/id_*',
  '/etc/ssh/ssh_host_*_key',
  // system credentials: password hashes (and the shadow- backup copies), VPN, DoubleZero and TLS private keys
  '/etc/shadow',
  '/etc/shadow-',
  '/etc/gshadow',
  '/etc/gshadow-',
  '/etc/wireguard',
  '/etc/doublezero/keys',
  '/etc/ssl/private',
  '/etc/nginx/ssl',
])

/** The tools that read an exclude list. */
export type BackupTool = 'tar' | 'restic' | 'rsync'

/**
 * Whether a restic backup keeps wallets. restic encrypts on this host before
 * anything is uploaded, so true keeps them in it; false adds WALLET_EXCLUDES to
 * restic's exclude list as well. tar archives and `slv migrate linux` copies
 * never carry wallets.
 */
export const RESTIC_INCLUDES_WALLETS = true

/**
 * Wallets: `wallet*.json` (and the `wallet.json.bak.<ts>` copies `slv bot init`
 * makes) anywhere under `~/slv/`, the `~/.slv/wallet-rescue/` store, and the
 * Solana CLI keypair `~/.config/solana/id.json`, under `/root` and `/home/*`.
 * The pattern syntax is the one of KEY_MATERIAL_EXCLUDES. A `**` needs at least
 * one directory in tar and rsync, so the files directly in `~/slv/` have their
 * own entry.
 */
export const WALLET_EXCLUDES: readonly string[] = Object.freeze([
  '/root/slv/wallet*.json*',
  '/root/slv/**/wallet*.json*',
  '/home/*/slv/wallet*.json*',
  '/home/*/slv/**/wallet*.json*',
  '/root/.slv/wallet-rescue',
  '/home/*/.slv/wallet-rescue',
  '/root/.config/solana/id.json',
  '/home/*/.config/solana/id.json',
])

/**
 * What a backup read by `tool` never carries: KEY_MATERIAL_EXCLUDES, and
 * WALLET_EXCLUDES except in a restic backup while RESTIC_INCLUDES_WALLETS holds.
 * `resticIncludesWallets` stands in for the constant.
 */
export function secretExcludes(
  tool: BackupTool = 'tar',
  resticIncludesWallets: boolean = RESTIC_INCLUDES_WALLETS,
): string[] {
  const keepsWallets = tool === 'restic' && resticIncludesWallets
  return [...KEY_MATERIAL_EXCLUDES, ...(keepsWallets ? [] : WALLET_EXCLUDES)]
}

/**
 * Files that belong to one machine's disks, network and SSH identity. A backup
 * keeps them; a restore leaves them alone unless `--include-system` is given.
 */
export const SYSTEM_IDENTITY_EXCLUDES: readonly string[] = Object.freeze([
  '/etc/fstab',
  '/boot',
  '/etc/netplan',
  '/etc/machine-id',
  '/etc/ssh/ssh_host_*',
])

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
 * secretExcludes(tool) are always part of the result.
 */
export function buildExcludeList(options: {
  extraExcludes?: string[]
  extraIncludes?: string[] // paths to remove from the exclude list (never key material or wallets)
  includeSSH?: boolean // true for backup (keep SSH files), false for migrate
  tool?: BackupTool // who reads the list; wallets stay in a restic backup (default: tar)
  resticIncludesWallets?: boolean // stands in for RESTIC_INCLUDES_WALLETS
}): string[] {
  const base = [...DEFAULT_EXCLUDES]
  if (!options.includeSSH) {
    base.push(...SSH_EXCLUDES)
  }
  const custom = getCustomExcludes()
  const all = [...base, ...custom, ...(options.extraExcludes || [])]

  // --include lifts an exclude from the list above. The key-material and
  // wallet entries are added after this step, so no include can lift them.
  const includes = new Set(options.extraIncludes || [])
  const kept = all.filter((e) => !includes.has(e))
  const secrets = secretExcludes(options.tool, options.resticIncludesWallets)
  return [...new Set([...kept, ...secrets])]
}

/**
 * `tar -x` arguments that keep the restore away from key material and, unless
 * `includeSystem`, from the system identity files.
 *
 * In an archive made by `tar -cf out /` the member names have no leading `/`
 * (`etc/fstab`); another tool may store `./etc/fstab` or `/etc/fstab`. All
 * three spellings are excluded, and `--anchored` keeps each one from matching a
 * same-named path deeper in the tree (`opt/app/boot`).
 */
export function tarExtractExcludeArgs(
  options: { includeSystem?: boolean } = {},
): string[] {
  const patterns = [
    ...(options.includeSystem ? [] : SYSTEM_IDENTITY_EXCLUDES),
    ...KEY_MATERIAL_EXCLUDES,
  ]
  const args = ['--anchored']
  for (const pattern of patterns) {
    const relative = pattern.replace(/^\/+/, '')
    for (const name of [relative, `./${relative}`, `/${relative}`]) {
      args.push('--exclude', name)
    }
  }
  return args
}

/** Directories a `**` never goes into: build output and dependencies. */
const NOT_DESCENDED = new Set(['node_modules', 'target', '.git'])

/** How many directories deep a `**` goes. */
const MAX_DEPTH = 8

/** One path component of a pattern as a regular expression: `*` and `?` stay inside the component. */
const componentRegExp = (component: string): RegExp => {
  const source = component
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${source}$`)
}

const readNames = async (dir: string, onlyDirs = false): Promise<string[]> => {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!onlyDirs || entry.isDirectory) names.push(entry.name)
    }
  } catch {
    // unreadable or missing: nothing to list
  }
  return names
}

/**
 * The files and directories on this host that match `patterns` (absolute, in the
 * syntax of KEY_MATERIAL_EXCLUDES: `*` stays inside one path component, `**`
 * crosses directories). Paths this user cannot see are not found. `root` puts
 * the search under another directory; the paths come back without it.
 */
export async function findExistingPaths(
  patterns: readonly string[],
  options: { root?: string } = {},
): Promise<string[]> {
  const root = (options.root ?? '').replace(/\/+$/, '')
  const found = new Set<string>()

  const exists = async (logical: string): Promise<boolean> => {
    try {
      await Deno.lstat(root + logical)
      return true
    } catch {
      return false
    }
  }
  const isDirectory = async (logical: string): Promise<boolean> => {
    try {
      return (await Deno.stat(root + logical)).isDirectory
    } catch {
      return false
    }
  }

  const walk = async (
    logical: string,
    parts: string[],
    depth: number,
  ): Promise<void> => {
    if (parts.length === 0) return
    const [head, ...rest] = parts
    if (head === '**') {
      await walk(logical, rest, depth) // no directory at all
      if (depth >= MAX_DEPTH) return
      for (const name of await readNames(root + (logical || '/'), true)) {
        if (!NOT_DESCENDED.has(name)) {
          await walk(`${logical}/${name}`, parts, depth + 1)
        }
      }
      return
    }
    let names = [head]
    if (/[*?]/.test(head)) {
      const matches = componentRegExp(head)
      names = (await readNames(root + (logical || '/'))).filter((name) =>
        matches.test(name)
      )
    }
    for (const name of names) {
      const path = `${logical}/${name}`
      if (rest.length === 0) {
        if (await exists(path)) found.add(path)
      } else if (await isDirectory(path)) {
        await walk(path, rest, depth)
      }
    }
  }

  for (const pattern of patterns) {
    await walk('', pattern.split('/').filter(Boolean), 0)
  }
  return [...found].sort()
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
      '   Use SLV_BACKUP_EXCLUDES env var or --exclude/--include CLI options to customize.',
    ),
  )
  console.log(
    colors.yellow(
      '   Key material and credentials (keypairs, ~/.slv credentials, SSH private keys, /etc/shadow, ...)',
    ),
  )
  console.log(
    colors.yellow(
      '   are always excluded: --include and SLV_BACKUP_EXCLUDES cannot lift them.',
    ),
  )
  console.log(
    colors.yellow(
      RESTIC_INCLUDES_WALLETS
        ? '   Wallets stay out of tar archives and migrate copies; a restic backup keeps them.\n'
        : '   Wallets are left out of every backup.\n',
    ),
  )
}
