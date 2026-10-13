// Where slv keeps key material and wallets, and the other places that hold a
// secret. This is the one list. The backup builds its exclude lists from it
// (src/backup/excludes.ts), and the AI console builds the classes of paths that
// its file tools and its command gate refuse from it
// (src/ai/console/keyMaterial.ts), so the two cannot name different places.
//
// A location is one or more path patterns:
// - a pattern that starts with `/` is an absolute path (a system location); any
//   other pattern is relative to a home directory;
// - `*` stands for any characters inside one path component;
// - `**` stands for directories: one or more when it ends the pattern, none or
//   more when it stands between components.

/** How a location names files. */
export type LocationKind =
  /** one file, or a few files that are written out */
  | 'file'
  /** a directory: it and everything below it */
  | 'directory'
  /** every file whose path matches a pattern with `*` */
  | 'glob'

/** The two lists of the backup that a location belongs to. */
export type LocationGroup = 'key' | 'wallet'

export interface KeyLocation {
  /**
   * The patterns of this location. They are all home-relative or all absolute.
   */
  readonly paths: readonly string[]
  readonly kind: LocationKind
  readonly group: LocationGroup
  /** How a refusal names the location. */
  readonly reason: string
  /**
   * Only the AI console reads this entry. The backup lists leave it out.
   */
  readonly consoleOnly?: boolean
  /**
   * The console holds names that go on after the path as well, such as
   * `api.yml.bak`.
   */
  readonly copies?: boolean
  /**
   * The patterns are file names, and the console reads them in every
   * directory. The backup lists the name directly in a home directory.
   */
  readonly anywhere?: boolean
  /**
   * Names, in lower case, that stay readable inside the location: a name
   * written out, or `*` followed by the end of a name.
   */
  readonly open?: readonly string[]
  /**
   * Typical names for a pattern with `*`. The console reads a glob word as
   * naming the location when it can stand for one of them.
   */
  readonly examples?: readonly string[]
  /**
   * The console may run in the directory that holds the files: it reads a glob
   * word with no directory in it as naming them when it can stand for one of
   * the examples. Implied by `anywhere`.
   */
  readonly inCwd?: boolean
}

/** The name of the ERPC login, which the file tools name in their message. */
export const ERPC_LOGIN = 'the ERPC login (~/.slv/api.yml)'

const PASSWORD_HASHES = 'the password hashes (/etc/shadow, /etc/gshadow)'

/**
 * What stays readable under `.ssh`: the public keys and the files that hold no
 * private key.
 */
const SSH_OPEN: readonly string[] = [
  '*.pub',
  'authorized_keys',
  'authorized_keys2',
  'known_hosts',
  'known_hosts.old',
  'config',
]

export const KEY_LOCATIONS: readonly KeyLocation[] = Object.freeze(
  [
    // slv key store and validator keypair / identity files kept in a home directory
    {
      paths: ['.slv/keys'],
      kind: 'directory',
      group: 'key',
      reason: 'the files under ~/.slv/keys',
    },
    {
      paths: ['*keypair*.json'],
      kind: 'glob',
      group: 'key',
      reason: 'a keypair file',
      anywhere: true,
      copies: true,
      examples: [
        'keypair.json',
        'mainnet-validator-keypair.json',
        'testnet-validator-keypair.json',
      ],
    },
    {
      paths: ['*identity*.json'],
      kind: 'glob',
      group: 'key',
      reason: 'an identity key file',
      anywhere: true,
      copies: true,
      examples: ['identity.json', 'unstaked-identity.json'],
    },
    // slv credentials: ERPC login and storage key, gateway token, webhook, restic password
    {
      paths: ['.slv/api.yml'],
      kind: 'file',
      group: 'key',
      reason: ERPC_LOGIN,
      copies: true,
    },
    {
      paths: ['.slv/gateway/gateway.json'],
      kind: 'file',
      group: 'key',
      reason: 'the gateway credentials (~/.slv/gateway/gateway.json)',
      copies: true,
    },
    {
      paths: ['.slv/backup.env'],
      kind: 'file',
      group: 'key',
      reason: 'the backup credentials (~/.slv/backup.env)',
      copies: true,
    },
    {
      paths: ['.slv/restic-password'],
      kind: 'file',
      group: 'key',
      reason: 'the backup password (~/.slv/restic-password)',
      copies: true,
    },
    // private SSH keys: the user keys, and the host keys (the ssh_host_*.pub files are not matched)
    {
      paths: ['.ssh/id_*'],
      kind: 'glob',
      group: 'key',
      reason: 'an SSH private key',
      open: SSH_OPEN,
      examples: ['id_rsa', 'id_ed25519', 'id_ecdsa'],
      inCwd: true,
    },
    {
      paths: ['/etc/ssh/ssh_host_*_key'],
      kind: 'glob',
      group: 'key',
      reason: 'an SSH host private key',
      examples: [
        'ssh_host_rsa_key',
        'ssh_host_dsa_key',
        'ssh_host_ecdsa_key',
        'ssh_host_ed25519_key',
      ],
    },
    // system credentials: password hashes (and the shadow- backup copies), VPN, DoubleZero and TLS private keys
    {
      paths: ['/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-'],
      kind: 'file',
      group: 'key',
      reason: PASSWORD_HASHES,
      copies: true,
    },
    {
      paths: ['/etc/wireguard'],
      kind: 'directory',
      group: 'key',
      reason: 'the WireGuard keys (/etc/wireguard)',
    },
    {
      paths: ['/etc/doublezero/keys'],
      kind: 'directory',
      group: 'key',
      reason: 'the DoubleZero keys (/etc/doublezero/keys)',
    },
    {
      paths: ['/etc/ssl/private'],
      kind: 'directory',
      group: 'key',
      reason: 'the TLS private keys (/etc/ssl/private)',
    },
    {
      paths: ['/etc/nginx/ssl'],
      kind: 'directory',
      group: 'key',
      reason: 'the nginx TLS keys (/etc/nginx/ssl)',
    },
    // read by the console only: the temporary files of the ERPC login, and an SSH private key under any name
    {
      paths: ['.slv/.api.yml*'],
      kind: 'glob',
      group: 'key',
      reason: ERPC_LOGIN,
      consoleOnly: true,
      examples: ['.api.yml.tmp'],
    },
    {
      paths: ['.ssh/**'],
      kind: 'glob',
      group: 'key',
      reason: 'an SSH private key',
      consoleOnly: true,
      open: SSH_OPEN,
    },
    // wallets: wallet*.json (and the wallet.json.bak.<ts> copies `slv bot init` makes) anywhere under ~/slv, the wallet rescue store, the Solana CLI keypair
    {
      paths: ['slv/wallet*.json*', 'slv/**/wallet*.json*'],
      kind: 'glob',
      group: 'wallet',
      reason: 'a wallet (~/slv/**/wallet*.json*)',
      examples: ['wallet.json', 'wallet.json.bak.1', 'wallet-1.json'],
    },
    {
      paths: ['.slv/wallet-rescue'],
      kind: 'directory',
      group: 'wallet',
      reason: 'the wallet rescue store (~/.slv/wallet-rescue)',
    },
    {
      paths: ['.config/solana/id.json'],
      kind: 'file',
      group: 'wallet',
      reason: 'the Solana CLI keypair (~/.config/solana/id.json)',
      copies: true,
    },
  ] satisfies KeyLocation[],
)

/**
 * The home directories a backup pattern is written for, in the order of its
 * lists: root's, then every user's under /home.
 */
export const BACKUP_HOMES: readonly string[] = Object.freeze([
  '/root',
  '/home/*',
])

/** Is the pattern relative to a home directory? */
export const isHomeRelative = (path: string): boolean => !path.startsWith('/')

/**
 * The exclude patterns of one location, for GNU tar, restic and rsync: a
 * home-relative pattern once for each of BACKUP_HOMES, one home after the
 * other; an absolute pattern as it is.
 */
export function expandForBackup(location: KeyLocation): string[] {
  if (!isHomeRelative(location.paths[0])) return [...location.paths]
  return BACKUP_HOMES.flatMap((home) =>
    location.paths.map((path) => `${home}/${path}`)
  )
}

/**
 * The exclude patterns of one group: every location the backup shares with the
 * console.
 */
export function backupPatterns(group: LocationGroup): string[] {
  return KEY_LOCATIONS.filter((location) =>
    location.group === group && !location.consoleOnly
  ).flatMap(expandForBackup)
}
