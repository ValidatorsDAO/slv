// ---------------------------------------------------------------------------
// Read-only command lines
//
// With auto-execute on, a command runs without a person only when its whole
// line is read-only. `isReadOnlyLine` answers that. A line is read-only when
// every simple command in it (pipelines, `;`, `&&`, `||`, `( )`, `{ }`) is a
// program from the table below, used in a form in which no option or operand
// writes a file, runs another program, changes the state of the system or of
// a service, or sends data over the network. Anything the reader cannot
// follow is not read-only, and so is a program that is not in the table and a
// `${...}` expansion with an operator, whose value can stand for any path or
// option.
// ---------------------------------------------------------------------------

import {
  ASSIGNMENT,
  PATTERN,
  readCommandLine,
  readWrapper,
  RUNTIME,
  type SimpleCommand,
  SOLANA_OPTIONS,
  SOLANA_READ_ONLY,
  SYSTEMCTL_OPTIONS,
} from '@/ai/console/commandGate.ts'

/** Whether a line is read-only, and what keeps it from being so. */
export type ReadOnlyResult = {
  readOnly: boolean
  /** Why the line is not read-only; empty when it is. */
  reasons: string[]
}

/** Why a use of a program is not read-only, or null when it only reads. */
type Check = (args: string[]) => string | null

const OPTION_INJECTION =
  'an argument that is only known when the shell runs, which can be an option'

/**
 * Words that can stand for something else than they are written as: an
 * expansion can be an option, and a pattern that starts with a wildcard can
 * match a file name that starts with a dash.
 */
function unknownWord(args: string[], allowPatterns: boolean): string | null {
  for (const arg of args) {
    if (arg.includes(RUNTIME)) return OPTION_INJECTION
    if (arg.includes(PATTERN)) {
      if (!allowPatterns) return 'a pattern where the program counts operands'
      if ('-{[\u0000\u0001'.includes(arg[0])) {
        return 'a pattern that can match a file name that is an option'
      }
    }
  }
  return null
}

type Rules = {
  /** short options that write, run, change or send; found in any cluster */
  badShort?: string
  /** long options with the same effect; an abbreviation of one counts too */
  badLong?: readonly string[]
  /** long options that look like an abbreviation of a bad one and are not */
  goodLong?: readonly string[]
  /** short options whose value is the rest of the word or the next word */
  valueShort?: string
  /** long options whose value is the next word */
  valueLong?: readonly string[]
  /** the most operands the program may have */
  maxOperands?: number
  /** options stop at the first operand, so a later word is an operand */
  optionsEndAtOperand?: boolean
  /** words that are only known when the shell runs are not allowed */
  strict?: boolean
}

type Scanned = { reason: string | null; operands: string[] }

/** Read the options of a program against what it must not be given. */
function scan(args: string[], rules: Rules, program: string): Scanned {
  const operands: string[] = []
  const fail = (reason: string): Scanned => ({ reason, operands })
  if (rules.strict) {
    const unknown = unknownWord(args, rules.maxOperands === undefined)
    if (unknown !== null) return fail(`${program} with ${unknown}`)
  }
  let options = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (rules.optionsEndAtOperand && operands.length > 0) options = false
    if (options && arg === '--') {
      options = false
    } else if (options && arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]
      if (
        rules.badLong?.some((bad) => bad.startsWith(name)) &&
        !rules.goodLong?.includes(name)
      ) {
        return fail(`${program} --${name}`)
      }
      if (!arg.includes('=') && rules.valueLong?.includes(name)) i++
    } else if (options && arg.startsWith('-') && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const ch = arg[k]
        if (rules.badShort?.includes(ch)) return fail(`${program} -${ch}`)
        if (rules.valueShort?.includes(ch)) {
          if (k === arg.length - 1) i++
          break
        }
      }
    } else {
      operands.push(arg)
    }
  }
  if (rules.maxOperands !== undefined && operands.length > rules.maxOperands) {
    return fail(`${program} with more than ${rules.maxOperands} operand`)
  }
  return { reason: null, operands }
}

const scanned = (program: string, rules: Rules): Check => (args) =>
  scan(args, rules, program).reason

/** Programs of which no option or operand writes, runs, changes or sends. */
const ANY_FORM = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'du',
  'grep',
  'egrep',
  'fgrep',
  'cut',
  'tr',
  'nl',
  'column',
  'comm',
  'cmp',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'b2sum',
  'base64',
  'jq',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'pwd',
  'echo',
  'true',
  'false',
  'seq',
  'sleep',
  'cal',
  'ps',
  'pgrep',
  'uptime',
  'free',
  'vmstat',
  'iostat',
  'mpstat',
  'nproc',
  'lscpu',
  'lsblk',
  'lsmem',
  'lsusb',
  'uname',
  'id',
  'whoami',
  'groups',
  'who',
  'w',
  'last',
  'netstat',
]

const PROGRAMS: Record<string, Check> = {}
for (const name of ANY_FORM) PROGRAMS[name] = () => null

// ---------------------------------------------------------------------------
// Files and text
// ---------------------------------------------------------------------------

PROGRAMS.sort = scanned('sort', {
  strict: true,
  badShort: 'o',
  badLong: ['output', 'compress-program'],
})
// the second operand of uniq is a file that it writes
PROGRAMS.uniq = scanned('uniq', {
  strict: true,
  valueShort: 'fsw',
  valueLong: ['skip-fields', 'skip-chars', 'check-chars'],
  maxOperands: 1,
  optionsEndAtOperand: true,
})
// diff -l passes its output through pr
PROGRAMS.diff = scanned('diff', {
  strict: true,
  badShort: 'l',
  badLong: ['paginate'],
})
// -C writes a compiled magic file, -z and -Z run the decompressors
PROGRAMS.file = scanned('file', {
  strict: true,
  badShort: 'CzZ',
  badLong: ['compile', 'uncompress', 'uncompress-noreport'],
})
// --pre and --hostname-bin run a program, -z runs the decompressors
PROGRAMS.rg = scanned('rg', {
  strict: true,
  badShort: 'z',
  badLong: ['pre', 'pre-glob', 'search-zip', 'hostname-bin'],
})
PROGRAMS.df = scanned('df', { strict: true, badLong: ['sync'] })

// the dump programs: one file operand, and for xxd no reverse mode
const DUMP_FLAGS: Record<string, { flags: string; values: string }> = {
  od: { flags: 'abcdfilosxvh', values: 'AjNt' },
  hexdump: { flags: 'bcCdoxvVh', values: 'efns' },
  strings: { flags: 'adfowvVh', values: 'ntesTU' },
}
for (const [name, { flags, values }] of Object.entries(DUMP_FLAGS)) {
  PROGRAMS[name] = (args) => {
    const unknown = unknownWord(args, false)
    if (unknown !== null) return `${name} with ${unknown}`
    const operands: string[] = []
    let options = true
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (options && arg === '--') {
        options = false
      } else if (options && arg.startsWith('--')) {
        // the long forms carry their value after `=`
        continue
      } else if (options && arg.startsWith('-') && arg.length > 1) {
        for (let k = 1; k < arg.length; k++) {
          const ch = arg[k]
          if (values.includes(ch)) {
            if (k === arg.length - 1) i++
            break
          }
          if (!flags.includes(ch) && !'Sw'.includes(ch)) {
            return `${name} with an option the gate cannot read`
          }
        }
      } else {
        operands.push(arg)
      }
    }
    return operands.length > 1 ? `${name} with more than one file` : null
  }
}
// xxd writes its second operand and its reverse mode writes a file
PROGRAMS.xxd = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `xxd with ${unknown}`
  const flags = new Set([
    '-a',
    '-b',
    '-C',
    '-E',
    '-e',
    '-i',
    '-p',
    '-ps',
    '-u',
    '-d',
    '-v',
    '-h',
    '-autoskip',
    '-bits',
    '-capitalize',
    '-ebcdic',
    '-EBCDIC',
    '-include',
    '-plain',
    '-postscript',
    '-uppercase',
    '-decimal',
    '-version',
    '-help',
  ])
  const values = new Set([
    '-c',
    '-g',
    '-l',
    '-o',
    '-n',
    '-s',
    '-cols',
    '-groupsize',
    '-len',
    '-name',
    '-seek',
  ])
  // the options come first: the word after the input file is the output file,
  // whatever it looks like
  let operands = 0
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (operands > 0) return 'xxd with an output file'
    if (values.has(arg)) {
      i++
    } else if (arg.startsWith('-') && arg.length > 1) {
      if (!flags.has(arg)) return 'xxd with an option the gate cannot read'
    } else {
      operands++
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Shell built-ins
// ---------------------------------------------------------------------------

PROGRAMS.date = (args) => {
  const r = scan(args, {
    strict: true,
    badShort: 's',
    badLong: ['set'],
    valueShort: 'dfr',
    valueLong: ['date', 'file', 'reference', 'rfc-3339'],
  }, 'date')
  if (r.reason !== null) return r.reason
  // an operand that is not a format sets the clock
  return r.operands.every((o) => o.startsWith('+'))
    ? null
    : 'date with an operand that sets the clock'
}
PROGRAMS.hostname = (args) => {
  const r = scan(args, {
    strict: true,
    badShort: 'bF',
    badLong: ['boot', 'file'],
  }, 'hostname')
  if (r.reason !== null) return r.reason
  return r.operands.length === 0 ? null : 'hostname with an operand'
}
// env runs the program it is given
PROGRAMS.env = (args) =>
  args.length === 0 ? null : 'env with an argument, which can run a program'
// printenv prints the variables it is given by name
PROGRAMS.printenv = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `printenv with ${unknown}`
  return args.some((a) => a.startsWith('-')) ? 'printenv with an option' : null
}
// which and type look names up; -a lists every match
PROGRAMS.which = (args) => {
  const unknown = unknownWord(args, true)
  if (unknown !== null) return `which with ${unknown}`
  const names = args.filter((a) => a !== '-a')
  if (names.length === 0) return 'which without a name'
  return names.some((a) => a.startsWith('-'))
    ? 'which with an option other than -a'
    : null
}
PROGRAMS.type = (args) => {
  const unknown = unknownWord(args, true)
  if (unknown !== null) return `type with ${unknown}`
  const names = args.filter((a) => !/^-[atpP]+$/.test(a))
  if (names.length === 0) return 'type without a name'
  return names.some((a) => a.startsWith('-'))
    ? 'type with an option other than -a, -t, -p and -P'
    : null
}
// cd changes the directory for the rest of the line, and the key-material
// classes of the command gate read the words of a line, not the directory
// they are relative to. So cd is read-only only for a directory written as an
// absolute or home path, without `..`, outside the places the classes name.
PROGRAMS.cd = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `cd with ${unknown}`
  const operands = args.filter((a) => !/^-[LP]+$/.test(a))
  if (operands.some((a) => a.startsWith('-') && a.length > 1)) {
    return 'cd with an option other than -L and -P'
  }
  if (operands.length !== 1) return 'cd other than cd [-L|-P] DIRECTORY'
  const directory = operands[0]
  if (!/^(?:\/|~(?:[A-Za-z_][A-Za-z0-9._-]*)?(?:\/|$))/.test(directory)) {
    return 'cd to a directory that is not written as an absolute or home path'
  }
  const parts = directory.toLowerCase().split('/')
  if (parts.includes('..')) return 'cd to a path with ..'
  if (
    parts.includes('.slv') || parts.includes('.ssh') ||
    /^\/proc(?:\/|$)/.test(directory.toLowerCase())
  ) {
    return 'cd into ~/.slv, ~/.ssh or /proc'
  }
  return null
}
PROGRAMS.ulimit = (args) =>
  args.length === 1 && args[0] === '-a' ? null : 'ulimit other than -a'
// printf -v NAME and the %n conversion assign a variable
PROGRAMS.printf = (args) => {
  // the option position and the format must be known when the line is read
  const at = args[0] === '--' ? 1 : 0
  const unknown = unknownWord(args.slice(0, at + 1), false)
  if (unknown !== null) return `printf with ${unknown}`
  if (args[0]?.startsWith('-v')) return 'printf -v, which assigns'
  return args[at] !== undefined && /%[-+ #0-9.*'hlLjzqtI]*n/.test(args[at])
    ? 'printf with a %n conversion, which assigns'
    : null
}
// test -v and test -R read a name as an expression
const testCheck: Check = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `test with ${unknown}`
  return args.includes('-v') || args.includes('-R')
    ? 'test -v or -R, which read a name as an expression'
    : null
}
PROGRAMS.test = testCheck
PROGRAMS['['] = testCheck
PROGRAMS.command = (args) => {
  if (args[0] !== '-v' || args.length < 2) {
    return 'command other than command -v NAME'
  }
  return unknownWord(args.slice(1), false) === null
    ? null
    : 'command -v with a name that is only known when the shell runs'
}

// ---------------------------------------------------------------------------
// Processes and the system
// ---------------------------------------------------------------------------

// pidstat -e runs the program that follows it
PROGRAMS.pidstat = scanned('pidstat', { strict: true, badShort: 'e' })
// top without -b is interactive
PROGRAMS.top = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `top with ${unknown}`
  const batch = args.some((a) =>
    a === '--batch' || (/^-[A-Za-z0-9]+$/.test(a) && a.includes('b'))
  )
  return batch ? null : 'top without -b, which is interactive'
}
// lspci -q and -Q look the ids up by DNS, and -xx and -M probe the hardware
PROGRAMS.lspci = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `lspci with ${unknown}`
  let probes = 0
  for (const arg of args) {
    if (/^-[A-Za-z]*[qQM]/.test(arg)) return 'lspci -q, -Q or -M'
    if (/^-[A-Za-z]+$/.test(arg)) probes += (arg.match(/x/g) ?? []).length
  }
  return probes > 1 ? 'lspci -xx, which probes' : null
}
// lsof +m writes a mount supplement, -D uses a device cache file, -e, -O and
// -M are risky, and @host is looked up
PROGRAMS.lsof = (args) => {
  const unknown = unknownWord(args, true)
  if (unknown !== null) return `lsof with ${unknown}`
  for (const arg of args) {
    if (arg.includes('@')) return 'lsof with a host name'
    if (arg[0] !== '-' && arg[0] !== '+') continue
    // the characters up to an option that takes a value are options
    const plus = arg[0] === '+'
    for (const ch of arg.slice(1)) {
      if ('cdgipsuFrTSxL'.includes(ch)) break
      if ('eOMD'.includes(ch) || (plus && ch === 'm')) {
        return `lsof ${arg[0]}${ch}, which writes or is risky`
      }
    }
  }
  return null
}
PROGRAMS.ss = scanned('ss', {
  strict: true,
  badShort: 'KD',
  badLong: ['kill', 'diag'],
})
PROGRAMS.sysctl = (args) => {
  const r = scan(args, {
    strict: true,
    badShort: 'wpf',
    badLong: ['write', 'load', 'system'],
    valueShort: 'r',
    valueLong: ['pattern'],
  }, 'sysctl')
  if (r.reason !== null) return r.reason
  return r.operands.some((o) => o.includes('='))
    ? 'sysctl name=value, which writes'
    : null
}
PROGRAMS.dmesg = scanned('dmesg', {
  strict: true,
  badShort: 'CcDEn',
  badLong: [
    'clear',
    'read-clear',
    'console-off',
    'console-on',
    'console-level',
  ],
  valueShort: 'fFlsK',
  valueLong: [
    'since',
    'until',
    'facility',
    'level',
    'file',
    'kmsg-file',
    'time-format',
    'buffer-size',
  ],
})
PROGRAMS.journalctl = scanned('journalctl', {
  strict: true,
  badShort: 'MH',
  badLong: [
    'vacuum-size',
    'vacuum-time',
    'vacuum-files',
    'rotate',
    'flush',
    'sync',
    'relinquish-var',
    'smart-relinquish-var',
    'setup-keys',
    'update-catalog',
    'cursor-file',
    'host',
    'machine',
    'image',
    'image-policy',
  ],
  goodLong: ['cursor', 'after-cursor'],
  valueShort: 'SUutpgoDcF',
  valueLong: [
    'since',
    'until',
    'unit',
    'user-unit',
    'identifier',
    'priority',
    'facility',
    'grep',
    'output',
    'directory',
    'file',
    'root',
    'namespace',
    'cursor',
    'after-cursor',
    'field',
    'output-fields',
  ],
})

const SYSTEMCTL_READ_ONLY = new Set([
  'status',
  'show',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'list-timers',
  'list-sockets',
  'cat',
])
PROGRAMS.systemctl = (args) => {
  const unknown = unknownWord(args, true)
  if (unknown !== null) return `systemctl with ${unknown}`
  // options may follow the verb, so every one is read, and -H and -M are not
  // among the ones the gate can read
  const read = readWrapper({ ...SYSTEMCTL_OPTIONS, permute: true }, args)
  if (read.unreadable) return 'systemctl with an option the gate cannot read'
  const verb = read.rest[0]
  return verb !== undefined && SYSTEMCTL_READ_ONLY.has(verb)
    ? null
    : 'systemctl other than a verb that only reports'
}

PROGRAMS.timedatectl = (args) => {
  const r = scan(args, {
    strict: true,
    badShort: 'HM',
    badLong: ['host', 'machine'],
    valueShort: 'p',
    valueLong: ['property'],
  }, 'timedatectl')
  if (r.reason !== null) return r.reason
  return r.operands.length === 1 && ['status', 'show'].includes(r.operands[0])
    ? null
    : 'timedatectl other than status or show'
}
PROGRAMS.chronyc = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `chronyc with ${unknown}`
  const operands = args.filter((a) => !a.startsWith('-'))
  const options = args.filter((a) => a.startsWith('-'))
  if (!options.every((o) => ['-n', '-c', '-v'].includes(o))) {
    return 'chronyc with an option other than -n, -c and -v'
  }
  return operands.length === 1 &&
      ['tracking', 'sources', 'sourcestats'].includes(operands[0])
    ? null
    : 'chronyc other than tracking, sources and sourcestats'
}

const IP_FLAGS = new Set([
  '-4',
  '-6',
  '-s',
  '-stats',
  '-statistics',
  '-d',
  '-details',
  '-h',
  '-human',
  '-human-readable',
  '-iec',
  '-o',
  '-oneline',
  '-r',
  '-resolve',
  '-a',
  '-all',
  '-t',
  '-timestamp',
  '-c',
  '-color',
  '-br',
  '-brief',
  '-j',
  '-json',
  '-p',
  '-pretty',
])
const IP_OBJECTS = new Set([
  'addr',
  'address',
  'a',
  'link',
  'l',
  'route',
  'r',
  'neigh',
  'neighbor',
  'neighbour',
  'n',
  'rule',
  'maddr',
  'maddress',
])
const IP_VERBS = new Set(['show', 'list', 'ls', 'get'])
PROGRAMS.ip = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `ip with ${unknown}`
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (IP_FLAGS.has(args[i])) i++
    else if (args[i] === '-f' || args[i] === '-family') i += 2
    else return 'ip with an option other than a display option'
  }
  const object = args[i]
  if (object === undefined || !IP_OBJECTS.has(object)) {
    return 'ip other than addr, link, route, neigh, rule and maddr'
  }
  const verb = args[i + 1]
  if (verb === undefined) return null
  if (!IP_VERBS.has(verb)) return `ip ${object} ${verb}`
  return args.slice(i + 2).some((a) => a.startsWith('-'))
    ? 'ip with an option after the verb'
    : null
}

const ETHTOOL_FLAGS = new Set([
  '-i',
  '--driver',
  '-k',
  '--show-features',
  '--show-offload',
  '-g',
  '--show-ring',
  '-l',
  '--show-channels',
  '-S',
  '--statistics',
  '-a',
  '--show-pause',
  '-c',
  '--show-coalesce',
  '-x',
  '--show-rxfh',
  '-T',
  '--show-time-stamping',
])
PROGRAMS.ethtool = (args) => {
  const device = args[args.length - 1]
  const interfaceName = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/
  if (
    (args.length !== 1 && args.length !== 2) ||
    !interfaceName.test(device) ||
    (args.length === 2 && !ETHTOOL_FLAGS.has(args[0]))
  ) {
    return 'ethtool other than an interface, with at most one option that shows'
  }
  return null
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

// options that choose the cluster, the account or the file the keys are in,
// and the one that writes an account to a file
const SOLANA_DENIED_LONG = [
  'url',
  'ws',
  'keypair',
  'config',
  'fee-payer',
  'signer',
  'output-file',
]
PROGRAMS.solana = (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `solana with ${unknown}`
  for (const arg of args) {
    if (arg.startsWith('--')) {
      // an abbreviation of a long option counts, and --output is the format
      const name = arg.slice(2).split('=')[0]
      if (
        name !== '' && name !== 'output' &&
        SOLANA_DENIED_LONG.some((denied) => denied.startsWith(name))
      ) {
        return `solana --${name}, which names a cluster, a key, a config or a file`
      }
    } else if (/^-[^-]*[ukCo]/.test(arg)) {
      return `solana ${arg}, which names a cluster, a key, a config or a file`
    }
  }
  const read = readWrapper(SOLANA_OPTIONS, args)
  if (read.unreadable) return 'solana with an option the gate cannot read'
  const sub = read.rest[0]?.toLowerCase()
  if (sub === undefined) return null
  const second = read.rest[1]?.toLowerCase()
  if (sub === 'config' && second === 'get') return null
  if (sub === 'feature' && second === 'status') return null
  return SOLANA_READ_ONLY.has(sub) ? null : `solana ${sub}`
}

const validatorCheck = (name: string): Check => (args) => {
  const unknown = unknownWord(args, false)
  if (unknown !== null) return `${name} with ${unknown}`
  let i = 0
  while (i < args.length) {
    if (args[i] === '-l' || args[i] === '--ledger') i += 2
    else if (args[i].startsWith('--ledger=')) i++
    else break
  }
  const rest = args.slice(i)
  return rest.length === 1 &&
      ['--version', '-V', '--help', 'contact-info', 'monitor'].includes(rest[0])
    ? null
    : `${name} other than its version, help, contact-info and monitor`
}
PROGRAMS['agave-validator'] = validatorCheck('agave-validator')
PROGRAMS['solana-validator'] = validatorCheck('solana-validator')
PROGRAMS.slv = (args) =>
  args.length === 1 && ['--version', '-V', '--help'].includes(args[0])
    ? null
    : 'slv other than its version and help'

// ---------------------------------------------------------------------------
// Redirections and simple commands
// ---------------------------------------------------------------------------

/** Why a redirection is not read-only, or null. */
function redirectReason(operator: string, target: string): string | null {
  // bash opens a connection for these names
  if (target.includes('/dev/tcp') || target.includes('/dev/udp')) {
    return 'a redirection to the network'
  }
  // copying a file descriptor writes nothing
  if (operator === '<&') {
    return /^(?:[0-9]+|-)$/.test(target)
      ? null
      : 'a redirection (<&) from something other than a file descriptor'
  }
  if (operator === '>&') {
    if (/^(?:[0-9]+|-)$/.test(target)) return null
  } else if (operator === '<') {
    if (!target.includes(RUNTIME) && !target.includes(PATTERN)) return null
    return 'an input redirection from a file known only at run time'
  }
  if (target === '/dev/null') return null
  return `a redirection (${operator}) that writes to ${
    target.includes(RUNTIME) ? 'a file known only at run time' : target
  }`
}

/** Why one simple command is not read-only, or null. */
function commandReason(command: SimpleCommand): string | null {
  for (const { operator, target } of command.redirections) {
    const reason = redirectReason(operator, target)
    if (reason !== null) return reason
  }
  const words = command.words
  if (words.length === 0) return null
  // the braces of a group are not commands
  if (words.length === 1 && words[0] === '}') return null
  const i = words[0] === '{' ? 1 : 0
  const first = words[i]
  if (first === undefined) return null
  if (ASSIGNMENT.test(first)) return 'an assignment'
  if (first.includes('/')) return 'a command named by a path'
  if (first.includes(RUNTIME) || first.includes(PATTERN)) {
    return 'a command named by an expansion or a pattern'
  }
  if (!Object.hasOwn(PROGRAMS, first)) {
    return `${first} is not a read-only program`
  }
  return PROGRAMS[first](words.slice(i + 1))
}

/** Is every command of this line a program that only reads? */
export function isReadOnlyLine(line: string): ReadOnlyResult {
  if (typeof line !== 'string') {
    return { readOnly: false, reasons: ['a command line that is not text'] }
  }
  const reasons = new Set<string>()
  try {
    const read = readCommandLine(line)
    const notes = read.notes
    if (read.unparsable) reasons.add('a command line the gate cannot read')
    if (notes.substitution) {
      reasons.add('a command substitution or a backquote')
    }
    if (notes.processSubstitution) reasons.add('a process substitution')
    if (notes.promptExpansion) reasons.add('a ${...@P} expansion')
    if (
      notes.arithmeticSyntax || notes.arithmeticExpansion || notes.arithmetic
    ) {
      reasons.add(
        'arithmetic or an expansion that reads a value as an expression',
      )
    }
    if (notes.background) reasons.add('a command run in the background')
    if (notes.parameterAssignment) reasons.add('an assignment')
    if (notes.parameterOperator) {
      reasons.add('a parameter expansion with an operator')
    }
    for (const command of read.commands) {
      const reason = commandReason(command)
      if (reason !== null) reasons.add(reason)
    }
  } catch {
    reasons.add('a command line the gate cannot read')
  }
  return { readOnly: reasons.size === 0, reasons: [...reasons] }
}
