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
 * An exclude pattern for one path, for GNU tar, restic and rsync alike. The
 * characters they read as wildcard syntax or escapes (`\`, `*`, `?`, `[`) are
 * written as `?`, which all three read the same way: a path is matched even when
 * its name holds one of them (and a few other names of the same length are
 * matched too).
 */
export function exactExclude(path: string): string {
  return path.replace(/[\\*?[]/g, '?').replace(/\uFFFD/g, '*')
}

/**
 * Build a unified exclude list from defaults, env var, and CLI options.
 * secretExcludes(tool), the `privateKeys` found and the `unlistedSshDirs` are
 * always part of the result.
 */
export function buildExcludeList(options: {
  extraExcludes?: string[]
  extraIncludes?: string[] // paths to remove from the exclude list (never key material or wallets)
  includeSSH?: boolean // true for backup (keep SSH files), false for migrate
  tool?: BackupTool // who reads the list; wallets stay in a restic backup (default: tar)
  resticIncludesWallets?: boolean // stands in for RESTIC_INCLUDES_WALLETS
  privateKeys?: readonly string[] // SSH private keys found by the search, by path
  unlistedSshDirs?: readonly string[] // .ssh directories to leave out as a whole
}): string[] {
  const base = [...DEFAULT_EXCLUDES]
  if (!options.includeSSH) {
    base.push(...SSH_EXCLUDES)
  }
  const custom = getCustomExcludes()
  const all = [...base, ...custom, ...(options.extraExcludes || [])]

  // --include lifts an exclude from the list above. The key-material, wallet
  // and private-key entries are added after this step, so no include can lift
  // them.
  const includes = new Set(options.extraIncludes || [])
  const kept = all.filter((e) => !includes.has(e))
  const secrets = [
    ...secretExcludes(options.tool, options.resticIncludesWallets),
    ...[...(options.privateKeys ?? []), ...(options.unlistedSshDirs ?? [])]
      .map(exactExclude),
  ]
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

/** Where a private key header is looked for: the start of the file. */
const HEAD_BYTES = 8192

/** The header of a PEM or OpenSSH private key (and of a PuTTY one). */
const PRIVATE_KEY_HEADER =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|PuTTY-User-Key-File-/

/** ssh files that are not private keys; an unreadable one of these is left alone. */
const NOT_KEY_NAMES = new Set(['authorized_keys', 'known_hosts', 'config'])

const readHeadOfFile = async (path: string): Promise<Uint8Array> => {
  const file = await Deno.open(path, { read: true })
  try {
    const head = new Uint8Array(HEAD_BYTES)
    let filled = 0
    while (filled < HEAD_BYTES) {
      const count = await file.read(head.subarray(filled))
      if (count === null) break
      filled += count
    }
    return head.subarray(0, filled)
  } finally {
    file.close()
  }
}

/** Looks for SSH private keys; replaced in tests. */
export type PrivateKeyFinder = () => Promise<string[]> | string[]

/** The `.ssh` directories of root and of every user with a directory in `/home`. */
const sshDirs = async (root: string): Promise<string[]> => [
  '/root/.ssh',
  ...(await readNames(`${root}/home`)).map((user) => `/home/${user}/.ssh`),
]

/**
 * Which of the regular files at `paths` are SSH private keys: those whose first
 * bytes hold a PEM, OpenSSH or PuTTY private key header, and those `readHead`
 * cannot read, unless their name is `*.pub`, `authorized_keys`, `known_hosts` or
 * `config`. The same rule for a search as this user and a search as root.
 */
const classifyKeys = async (
  paths: readonly string[],
  readHead: (path: string) => Promise<Uint8Array>,
): Promise<string[]> => {
  const keys = new Set<string>()
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    let head: Uint8Array
    try {
      head = await readHead(path)
    } catch {
      // a file that cannot be read may be a key: fail closed
      if (!name.endsWith('.pub') && !NOT_KEY_NAMES.has(name)) keys.add(path)
      continue
    }
    if (PRIVATE_KEY_HEADER.test(new TextDecoder().decode(head))) keys.add(path)
  }
  return [...keys].sort()
}

/**
 * The SSH private keys directly in `/root/.ssh` and `/home/<user>/.ssh`,
 * whatever they are called: a regular file whose first bytes hold a PEM, OpenSSH
 * or PuTTY private key header. A file that cannot be read counts as a private
 * key too, unless its name is `*.pub`, `authorized_keys`, `known_hosts` or
 * `config`. A symlink, a directory or anything below one is not looked at. Paths
 * come back without `root`, sorted. A directory this user cannot list is not
 * searched: see findUnlistedSshDirs and findPrivateKeysAsRoot.
 */
export async function findPrivateKeys(
  options: {
    root?: string
    readHead?: (path: string) => Promise<Uint8Array>
  } = {},
): Promise<string[]> {
  const root = (options.root ?? '').replace(/\/+$/, '')
  const readHead = options.readHead ?? readHeadOfFile
  const paths: string[] = []
  for (const dir of await sshDirs(root)) {
    try {
      for await (const entry of Deno.readDir(`${root}${dir}`)) {
        if (entry.isFile) paths.push(`${dir}/${entry.name}`)
      }
    } catch {
      // no such directory, or one this user cannot list
    }
  }
  return await classifyKeys(paths, (path) => readHead(`${root}${path}`))
}

/**
 * The `.ssh` directories of root and of every user in `/home` that this user
 * cannot list. A directory that does not exist is not one. Paths come back
 * without `root`, sorted.
 */
export async function findUnlistedSshDirs(
  options: { root?: string } = {},
): Promise<string[]> {
  const root = (options.root ?? '').replace(/\/+$/, '')
  const unlisted: string[] = []
  for (const dir of await sshDirs(root)) {
    try {
      for await (const _entry of Deno.readDir(`${root}${dir}`)) break
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) unlisted.push(dir)
    }
  }
  return unlisted.sort()
}

/**
 * Lists the regular files directly in the `.ssh` directories. `$1` is the
 * directory the file system is under (empty for this host); the shell expands the
 * `/home/*` glob, so it runs with the privilege of whoever starts it. A directory
 * that cannot be listed even so is one nothing running as that user can read
 * either: it ends the script with 0 all the same, and only a missing `find` or a
 * refused `sudo` is a failure.
 */
const LIST_SSH_FILES = [
  'root=$1',
  'command -v find >/dev/null 2>&1 || exit 127',
  'set --',
  'for dir in "$root"/root/.ssh "$root"/home/*/.ssh; do',
  '  [ -d "$dir" ] && set -- "$@" "$dir"',
  'done',
  '[ "$#" -eq 0 ] || find -H "$@" -mindepth 1 -maxdepth 1 -type f -print0 2>/dev/null',
  'exit 0',
].join('\n')

/** Run a command and return what it wrote; a failure rejects with its error text. */
const runCommand = async (argv: readonly string[]): Promise<Uint8Array> => {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  })
  const result = await command.output()
  if (!result.success) {
    const reason = new TextDecoder().decode(result.stderr).trim()
    throw new Error(reason || `${argv[0]} exited with ${result.code}`)
  }
  return result.stdout
}

/**
 * The same search as findPrivateKeys, run as root through `sudo -n` (it never
 * asks for a password): one command lists the files, and `head` reads the first
 * bytes of each, which go through the same classification. Rejects when the
 * listing fails, for instance when sudo is not allowed. `root` and `sudo` (the
 * command prefix, empty to run without sudo) are there for tests.
 */
export async function findPrivateKeysAsRoot(
  options: { root?: string; sudo?: readonly string[] } = {},
): Promise<string[]> {
  const root = (options.root ?? '').replace(/\/+$/, '')
  const sudo = options.sudo ?? ['sudo', '-n']
  const listing = await runCommand([
    ...sudo,
    'sh',
    '-c',
    LIST_SSH_FILES,
    'sh',
    root,
  ])
  const paths = new TextDecoder().decode(listing).split('\0')
    .filter((path) => path !== '')
    .map((path) => path.slice(root.length))
  return await classifyKeys(
    paths,
    (path) =>
      runCommand([
        ...sudo,
        'head',
        '-c',
        String(HEAD_BYTES),
        '--',
        `${root}${path}`,
      ]),
  )
}

/** What the search for SSH private keys of one run found. */
export interface SshKeySearch {
  /** The private keys found, by path. */
  keys: string[]
  /** The `.ssh` directories to leave out as a whole: nothing could list them. */
  wholeDirs: string[]
  /** The archiver runs as root, and the search as root failed. */
  rootSearchFailed: boolean
}

/**
 * The search for SSH private keys that a run makes before it builds its exclude
 * lists, with the privilege of its archiver. As this user always. Under sudo
 * (`underSudo`: tar or rsync run as root) also as root, and what that finds is
 * added. When the search as root fails, every `.ssh` directory this user cannot
 * list is left out as a whole, since nothing has looked inside it.
 */
export async function searchSshKeys(options: {
  underSudo: boolean
  find?: PrivateKeyFinder
  findAsRoot?: PrivateKeyFinder
  findUnlisted?: () => Promise<string[]> | string[]
}): Promise<SshKeySearch> {
  const asUser = await (options.find ?? findPrivateKeys)()
  if (!options.underSudo) {
    return {
      keys: [...new Set(asUser)].sort(),
      wholeDirs: [],
      rootSearchFailed: false,
    }
  }
  try {
    const asRoot = await (options.findAsRoot ?? findPrivateKeysAsRoot)()
    return {
      keys: [...new Set([...asUser, ...asRoot])].sort(),
      wholeDirs: [],
      rootSearchFailed: false,
    }
  } catch {
    const unlisted = await (options.findUnlisted ?? findUnlistedSshDirs)()
    return {
      keys: [...new Set(asUser)].sort(),
      wholeDirs: [...new Set(unlisted)].sort(),
      rootSearchFailed: true,
    }
  }
}

/**
 * What to tell the operator when `tool` runs as root and the search for SSH
 * private keys as root failed: the `.ssh` directories this user cannot list are
 * excluded as a whole.
 */
export function sshScanNote(
  tool: 'tar' | 'rsync',
  dirs: readonly string[],
  rerun: string,
): string {
  const names = dirs.join(', ')
  const left = dirs.length > 0
    ? ` These .ssh directories could not be listed by this user and are excluded as a whole: ${names}.`
    : ''
  return `\n⚠️  ${tool} runs as root, but the search for SSH private keys could not run as root (sudo -n failed).${left} Run as root (${rerun}) to look inside them.\n`
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
