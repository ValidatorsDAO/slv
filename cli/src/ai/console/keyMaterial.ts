// The names that mark key material and credentials for the AI console. The
// file tools (toolSafety.ts) apply them to a resolved path; the command gate
// (commandGate.ts) applies them to the words of a command line. Both read the
// same classes from here, together with the note that says what stays readable
// outside them.

/**
 * What `auto_execute: true` changes, in the words of the agent config schema,
 * the onboarding text and the run_command and read_file tool descriptions.
 */
export const AUTO_EXECUTE_NOTE =
  'With auto_execute on, the console runs read-only commands without asking, and every other command needs a person to confirm it in a terminal. A read-only command can still read files outside the refused classes (keys and credentials), and output redaction hides only three key shapes: a PEM private key, a JSON array of 64 integers and a base58 Solana keypair.'

/** Base names, in lower case, of key files anywhere on disk. */
export const KEYPAIR_FILE_NAME = /keypair.*\.json$/
export const IDENTITY_FILE_NAME = /identity.*\.json$/

/** The environment of a process, as a lower-case absolute path. */
export const PROCESS_ENVIRON =
  /^\/proc\/(self|thread-self|\d+)\/(task\/\d+\/)?environ$/

// Placeholders the command reader leaves in a word for text it cannot know:
// RUNTIME for an expansion, PATTERN for a glob character.
export const RUNTIME = '\u0000'
export const PATTERN = '\u0001'
const PLACEHOLDERS = `${RUNTIME}${PATTERN}`

// A path component starts at the start of a word, after a separator or after
// a placeholder.
const START = `(?<![^/\\s'"=:${PLACEHOLDERS}])`
// One path component.
const NAME = `[^/\\s'"]`
// The end of a path component: nothing that would continue its name.
const NAME_END = `(?![A-Za-z0-9_.-])`
const HOME_SLV = `${START}\\.slv/`

// Secrets and memory of the machine that sit at a fixed absolute path. Each
// source matches a whole path; a process under /proc is `self`, `thread-self`
// or a number, and a word of a command line may leave an expansion or a glob
// in its place.
const PASSWORD_HASHES = 'the password hashes (/etc/shadow, /etc/gshadow)'
const HOST_KEY = 'an SSH host private key'
const KERNEL_MEMORY = 'the memory of the kernel (/proc/kcore)'
const PROCESS_MEMORY = 'the memory of a process'
const MACHINE_MEMORY =
  'the memory or the I/O ports of the machine (/dev/mem, /dev/kmem, /dev/port)'
const PROCESS_SLOT = `(?:self|thread-self|\\d+|[${PLACEHOLDERS}]+)`
const TASK_SLOT = `(?:task/(?:\\d+|[${PLACEHOLDERS}]+)/)?`
const SYSTEM_PATHS: Array<[string, string]> = [
  ['/etc/g?shadow-?', PASSWORD_HASHES],
  [`/etc/ssh/ssh_host_${NAME}*_key`, HOST_KEY],
  ['/proc/kcore', KERNEL_MEMORY],
  [`/proc/${PROCESS_SLOT}/${TASK_SLOT}mem`, PROCESS_MEMORY],
  ['/dev/(?:mem|kmem|port)', MACHINE_MEMORY],
]
const SYSTEM_PATH_EXACT = SYSTEM_PATHS.map((
  [source, reason],
): [RegExp, string] => [new RegExp(`^${source}$`, 'i'), reason])

/**
 * Why a file tool must not handle this absolute path, or null: a password
 * hash file, an SSH host private key, the memory of the kernel or of a
 * process, a memory device.
 */
export function systemSecretReason(path: string): string | null {
  for (const [pattern, reason] of SYSTEM_PATH_EXACT) {
    if (pattern.test(path)) return reason
  }
  return null
}

// The classes that are a place: a directory or a file under a home directory.
// The key files that are named by their file name are read by `nameReason`.
const PLACES: Array<[RegExp, string]> = [
  [
    new RegExp(`${START}\\.slv/keys${NAME_END}`, 'i'),
    'the files under ~/.slv/keys',
  ],
  [
    new RegExp(`${HOME_SLV}gateway/gateway\\.json`, 'i'),
    'the gateway credentials (~/.slv/gateway/gateway.json)',
  ],
  [
    new RegExp(`${HOME_SLV}backup\\.env`, 'i'),
    'the backup credentials (~/.slv/backup.env)',
  ],
  [
    new RegExp(`${HOME_SLV}restic-password`, 'i'),
    'the backup password (~/.slv/restic-password)',
  ],
  [
    new RegExp(`${HOME_SLV}\\.?api\\.yml`, 'i'),
    'the ERPC login (~/.slv/api.yml)',
  ],
  [
    new RegExp(
      `${START}\\.ssh/id_${NAME}*(?<!\\.pub)(?=$|[/\\s'"${PLACEHOLDERS}])`,
      'i',
    ),
    'an SSH private key',
  ],
  [
    new RegExp(
      `${START}/proc/(?:self|thread-self|\\d+|[${PLACEHOLDERS}]+)/(?:task/(?:\\d+|[${PLACEHOLDERS}]+)/)?environ${NAME_END}`,
      'i',
    ),
    'the environment of a process',
  ],
  // a path is matched by its tail, so a path through /proc/PID/root counts
  ...SYSTEM_PATHS.map(([source, reason]): [RegExp, string] => [
    new RegExp(`${source}${NAME_END}`, 'i'),
    reason,
  ]),
]

/** The same places with the `g` flag, to read every match of a word. */
const GLOBAL_PLACES = PLACES.map((
  [pattern, reason],
): [RegExp, string] => [new RegExp(pattern.source, 'gi'), reason])

/**
 * What an expansion may stand for in front of the rest of a word: a
 * directory that ends in the name one of the places starts with.
 */
const STAND_INS = [
  '/home/solv/.slv',
  '/home/solv/.slv/gateway',
  '/home/solv/.ssh',
]

// The home directories the patterns below are written for. A path under any
// other home is read as if it were under the first one.
const HOMES = ['/home/solv', '/root']
const KEY_DIRECTORIES = HOMES.map((home) => `${home}/.slv/keys`)

/**
 * The home directories of this process: HOME, and the home of the user who ran
 * sudo. The list is empty where the environment cannot be read.
 */
export function ownHomes(): string[] {
  const homes: string[] = []
  try {
    const home = Deno.env.get('HOME')
    if (home) homes.push(home)
    const sudoUser = Deno.env.get('SUDO_USER')
    if (sudoUser && /^[A-Za-z0-9._-]+$/.test(sudoUser)) {
      homes.push(sudoUser === 'root' ? '/root' : `/home/${sudoUser}`)
    }
  } catch { /* no permission to read the environment */ }
  return homes.map((home) => home.replace(/\/+$/, '')).filter((home) =>
    home.startsWith('/') && home.length > 1
  )
}

/** The start of a path under any user's home: /home/NAME or /Users/NAME. */
const NAMED_HOME = /^\/(?:home|users)\/[^/]+(?=\/|$)/i

/**
 * The path with the home directory it starts with, if it starts with one,
 * written as the first of HOMES: /home/NAME and /Users/NAME for any name, and
 * the home of this process.
 */
function underFirstHome(path: string): string {
  const named = NAMED_HOME.exec(path)
  if (named !== null) return HOMES[0] + path.slice(named[0].length)
  const lower = path.toLowerCase()
  for (const home of ownHomes()) {
    const own = home.toLowerCase()
    if (lower === own || lower.startsWith(`${own}/`)) {
      return HOMES[0] + path.slice(home.length)
    }
  }
  return path
}
// Files a pattern word may stand for, under a home directory.
const FILE_PROBES: Array<[string, string]> = [
  ['.slv/gateway/gateway.json', 'the gateway credentials'],
  ['.slv/backup.env', 'the backup credentials'],
  ['.slv/restic-password', 'the backup password'],
  ['.slv/api.yml', 'the ERPC login'],
  ['.slv/api.yml.lock', 'the ERPC login'],
  ['.ssh/id_rsa', 'an SSH private key'],
  ['.ssh/id_ed25519', 'an SSH private key'],
  ['.ssh/id_ecdsa', 'an SSH private key'],
  ['identity.json', 'an identity key file'],
  ['unstaked-identity.json', 'an identity key file'],
  ['mainnet-validator-keypair.json', 'a keypair file'],
  ['testnet-validator-keypair.json', 'a keypair file'],
]

// File names in the current directory a pattern may stand for. The console
// can run in a home directory that holds them.
const NAME_PROBES: Array<[string, string]> = [
  ['identity.json', 'an identity key file'],
  ['unstaked-identity.json', 'an identity key file'],
  ['keypair.json', 'a keypair file'],
  ['mainnet-validator-keypair.json', 'a keypair file'],
  ['testnet-validator-keypair.json', 'a keypair file'],
  ['id_rsa', 'an SSH private key'],
  ['id_ed25519', 'an SSH private key'],
  ['id_ecdsa', 'an SSH private key'],
]

// Files at a fixed path that a pattern word may stand for, as the components
// of the path; # stands for a number.
const SYSTEM_TEMPLATES: Array<[string[], string]> = [
  [['etc', 'shadow'], PASSWORD_HASHES],
  [['etc', 'gshadow'], PASSWORD_HASHES],
  [['etc', 'shadow-'], PASSWORD_HASHES],
  [['etc', 'gshadow-'], PASSWORD_HASHES],
  [['etc', 'ssh', 'ssh_host_rsa_key'], HOST_KEY],
  [['etc', 'ssh', 'ssh_host_dsa_key'], HOST_KEY],
  [['etc', 'ssh', 'ssh_host_ecdsa_key'], HOST_KEY],
  [['etc', 'ssh', 'ssh_host_ed25519_key'], HOST_KEY],
  [['proc', 'kcore'], KERNEL_MEMORY],
  [['proc', 'self', 'mem'], PROCESS_MEMORY],
  [['proc', 'thread-self', 'mem'], PROCESS_MEMORY],
  [['proc', '#', 'mem'], PROCESS_MEMORY],
  [['proc', 'self', 'task', '#', 'mem'], PROCESS_MEMORY],
  [['proc', '#', 'task', '#', 'mem'], PROCESS_MEMORY],
  [['dev', 'mem'], MACHINE_MEMORY],
  [['dev', 'kmem'], MACHINE_MEMORY],
  [['dev', 'port'], MACHINE_MEMORY],
]

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The text with `.`, `..` and repeated `/` removed from its paths. */
function collapsePaths(text: string): string {
  const out: string[] = []
  for (const part of text.split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      if (out[out.length - 1] !== '') out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** Split a brace body at the commas that are not inside a nested pair. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(from, i))
      from = i + 1
    }
  }
  parts.push(body.slice(from))
  return parts
}

/**
 * The words a brace expansion makes of `text`: `a{b,c}` gives `ab` and `ac`.
 * Past a limit the text is kept as written.
 */
function expandBraces(text: string, limit = 64): string[] {
  const out: string[] = []
  const walk = (s: string): void => {
    if (out.length >= limit) return
    let depth = 0
    let open = -1
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '{') {
        if (depth === 0) open = i
        depth++
      } else if (s[i] === '}' && depth > 0) {
        depth--
        if (depth === 0) {
          const parts = splitAlternatives(s.slice(open + 1, i))
          if (parts.length > 1) {
            for (const part of parts) {
              walk(s.slice(0, open) + part + s.slice(i + 1))
            }
            return
          }
        }
      }
    }
    out.push(s)
  }
  walk(text)
  if (out.length >= limit) out.push(text)
  return out
}

/**
 * A pattern word as a regular expression over a whole path. A bracket
 * expression of the word is one too: `[ab]` stands for a or b.
 */
function patternToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === PATTERN || ch === RUNTIME) {
      source += '[^/]*'
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close === -1) {
        source += escapeRegExp(ch)
      } else {
        let body = pattern.slice(i + 1, close)
        const negated = body[0] === '!' || body[0] === '^'
        if (negated) body = body.slice(1)
        source += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
        i = close
      }
    } else {
      source += escapeRegExp(ch)
    }
  }
  try {
    return new RegExp(`^${source}$`, 'i')
  } catch {
    // a bracket expression that is not a valid class: read it as written
    return new RegExp(
      `^${
        [...pattern].map((c) =>
          c === PATTERN || c === RUNTIME ? '[^/]*' : escapeRegExp(c)
        ).join('')
      }$`,
      'i',
    )
  }
}

/** Can a component of a pattern word be a number: digits only? */
function standsForNumber(pattern: string): boolean {
  if (pattern === '') return false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === PATTERN || ch === RUNTIME) continue
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close !== -1) {
        const one = patternToRegExp(pattern.slice(i, close + 1))
        if (!'0123456789'.split('').some((digit) => one.test(digit))) {
          return false
        }
        i = close
        continue
      }
    }
    if (!/[0-9]/.test(ch)) return false
  }
  return true
}

/**
 * Can a pattern word stand for a path that ends in one of the system files
 * above? The last components of the word are read against the components of
 * the file, so that a path through /proc/PID/root counts. A relative word
 * counts only when it writes out one of the components itself, so that `*` and
 * a/*b name nothing, unless it starts with `..`, which may reach the root.
 */
function systemPatternReason(pattern: string): string | null {
  const parts = pattern.split('/')
  const rooted = pattern.startsWith('/') || pattern.startsWith('../')
  for (const [template, reason] of SYSTEM_TEMPLATES) {
    if (parts.length < template.length) continue
    const tail = parts.slice(parts.length - template.length)
    const matches = template.every((name, i) =>
      name === '#'
        ? standsForNumber(tail[i])
        : patternToRegExp(tail[i]).test(name)
    )
    const written = template.some((name, i) =>
      name !== '#' && tail[i].toLowerCase() === name
    )
    if (matches && (rooted || written)) return reason
  }
  return null
}

/**
 * Can a file name with glob characters stand for a key file in the current
 * directory? At least two characters besides `.json` must be written out, so
 * that `*.json` and `*` name nothing.
 */
function nameInDirectoryReason(name: string): string | null {
  const written = name.replace(/\.json$/i, '').replace(/\[[^\]]*\]/g, '')
    .replace(/[\u0000\u0001]/g, '')
  if (written.length < 2) return null
  const pattern = patternToRegExp(name)
  for (const [probe, reason] of NAME_PROBES) {
    if (pattern.test(probe)) return reason
  }
  return null
}

/**
 * Can a word with glob characters stand for key material under a home
 * directory? A tilde or an expansion in front of the first slash stands for
 * the home directory.
 */
function patternReason(text: string): string | null {
  let t = text.replace(/^(?:~|\u0000)[^/\u0000\u0001]*(?=\/|$)/, HOMES[0])
  if (/^\.(slv|ssh)\//.test(t)) t = `${HOMES[0]}/${t}`
  if (!t.includes('/')) return nameInDirectoryReason(t)
  const system = systemPatternReason(t)
  if (system !== null) return system
  // a path relative to a directory the gate does not know names nothing here
  if (!t.startsWith('/')) return null
  t = underFirstHome(t)
  const parts = t.split('/')
  for (let k = 1; k <= parts.length; k++) {
    const prefix = patternToRegExp(parts.slice(0, k).join('/'))
    if (KEY_DIRECTORIES.some((dir) => prefix.test(dir))) {
      return 'the files under ~/.slv/keys'
    }
  }
  const whole = patternToRegExp(t)
  for (const home of HOMES) {
    for (const [file, reason] of FILE_PROBES) {
      if (whole.test(`${home}/${file}`)) return reason
    }
  }
  return null
}

/**
 * An expansion in front of the rest of a word may be a directory that
 * completes a place: `$d/keys/x.json` names ~/.slv/keys/x.json when d is
 * ~/.slv. A place counts only when the match reaches into the text that is
 * written out, so that `$d` alone names nothing.
 */
function standInReason(text: string): string | null {
  let at = text.indexOf(RUNTIME)
  for (let n = 0; at !== -1 && n < 4; n++) {
    for (const standIn of STAND_INS) {
      const candidate = text.slice(0, at) + standIn +
        text.slice(at + 1).split(RUNTIME).join('x')
      for (const [pattern, reason] of GLOBAL_PLACES) {
        pattern.lastIndex = 0
        for (const match of candidate.matchAll(pattern)) {
          if (match.index + match[0].length > at + standIn.length) return reason
        }
      }
    }
    at = text.indexOf(RUNTIME, at + 1)
  }
  return null
}

/**
 * A key file named by its file name, in any directory: a `.json` file with
 * keypair or identity in its name.
 */
function nameReason(text: string): string | null {
  for (const component of text.split(/[/\s'"]+/)) {
    const lower = component.toLowerCase()
    const json = lower.lastIndexOf('.json')
    if (json === -1) continue
    const keypair = lower.indexOf('keypair')
    if (keypair !== -1 && json >= keypair + 7) return 'a keypair file'
    const identity = lower.indexOf('identity')
    if (identity !== -1 && json >= identity + 8) return 'an identity key file'
  }
  return null
}

function classReason(text: string): string | null {
  for (const [pattern, reason] of PLACES) {
    if (pattern.test(text)) return reason
  }
  const named = nameReason(text)
  if (named !== null) return named
  if (text.includes(RUNTIME)) {
    const reason = standInReason(text)
    if (reason !== null) return reason
  }
  return text.includes(PATTERN) ? patternReason(text) : null
}

/**
 * Why a word of a command line names key material, or null. The word is read
 * as written: a path is matched by its tail, so `~/.slv/keys/k.json`,
 * `$HOME/.slv/keys/k.json` and `/home/solv/.slv/keys/k.json` all count, and
 * so do the words a brace expansion makes of it. A word with glob characters
 * counts when it can expand to key material under a home directory.
 */
export function keyMaterialInWord(word: string): string | null {
  for (const alternative of expandBraces(word)) {
    const reason = classReason(alternative) ??
      classReason(collapsePaths(alternative))
    if (reason !== null) return reason
  }
  return null
}
