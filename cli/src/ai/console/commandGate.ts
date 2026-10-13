// ---------------------------------------------------------------------------
// Commands that need a person at a terminal
//
// `classifyCommand` reads a shell command line and reports whether it runs a
// command of a gated class: ansible-playbook, the slv verbs that change nodes
// or keys, ssh/scp/rsync, solana-keygen, op, rm with -r or -f, the validator
// programs, systemctl and service verbs that change a unit, solana
// subcommands that sign, interpreters, and the programs that run their
// arguments. A line that names key material, or has a command substitution,
// is gated as well. A gated command always needs a confirmation in a
// terminal. A line the reader cannot parse, or whose command is only known
// when the shell runs, counts as gated.
// ---------------------------------------------------------------------------

import {
  AUTO_EXECUTE_NOTE,
  keyMaterialInWord,
} from '@/ai/console/keyMaterial.ts'
import { awkProgramRisk, sedScriptRisk } from '@/ai/console/scriptRisk.ts'

/** What `classifyCommand` found in a command line. */
export type CommandClassification = {
  gated: boolean
  /** The command words that put the line in a gated class. */
  reasons: string[]
}

/** Stands in a word for text that is only known when the shell runs. */
const RUNTIME = '\u0000'
/** Stands in a word for an unquoted glob or brace character. */
const PATTERN = '\u0001'

const MAX_NESTING = 8

type SimpleCommand = {
  words: string[]
  /** The words after a redirection operator: the files it opens. */
  redirects: string[]
  hereDocs: string[]
  hereStrings: string[]
}

/** What the reader saw in a command line besides its commands. */
type ParseNotes = {
  /** `$(`, a backquote or an escaped form of them outside single quotes */
  substitution: boolean
  /** a `${...@P}` expansion */
  promptExpansion: boolean
}

type ParseState = {
  src: string
  pos: number
  commands: SimpleCommand[]
  unparsable: boolean
  notes: ParseNotes
}

const isNameStart = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z_]/.test(c)
const isNameChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9_]/.test(c)
const hasUnknownPart = (word: string): boolean =>
  word.includes(RUNTIME) || word.includes(PATTERN)

function parseNested(st: ParseState, text: string, depth: number): void {
  const sub: ParseState = {
    src: text,
    pos: 0,
    commands: st.commands,
    unparsable: false,
    notes: st.notes,
  }
  parseList(sub, null, depth + 1)
  if (sub.unparsable) st.unparsable = true
}

/** Index just after the `))` that closes `$((`, or -1. */
function arithmeticEnd(src: string, from: number): number {
  let level = 0
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '(') level++
    else if (c === ')') {
      if (level === 0) return src[i + 1] === ')' ? i + 2 : -1
      level--
    }
  }
  return -1
}

const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}

/** After `$'`: decode the escapes up to the closing quote. */
function readAnsiC(st: ParseState): string {
  const src = st.src
  let out = ''
  while (st.pos < src.length) {
    const c = src[st.pos]
    if (c === "'") {
      st.pos++
      return out
    }
    if (c !== '\\') {
      out += c
      st.pos++
      continue
    }
    const n = src[st.pos + 1]
    if (n !== undefined && Object.hasOwn(ANSI_C_ESCAPES, n)) {
      out += ANSI_C_ESCAPES[n]
      st.pos += 2
      continue
    }
    const numeric = n === undefined
      ? null
      : /^[0-7]$/.test(n)
      ? { digits: /^[0-7]{1,3}/, radix: 8, skip: 1 }
      : n === 'x'
      ? { digits: /^[0-9a-fA-F]{1,2}/, radix: 16, skip: 2 }
      : n === 'u'
      ? { digits: /^[0-9a-fA-F]{1,4}/, radix: 16, skip: 2 }
      : n === 'U'
      ? { digits: /^[0-9a-fA-F]{1,8}/, radix: 16, skip: 2 }
      : null
    if (numeric !== null) {
      const rest = src.slice(st.pos + numeric.skip)
      const m = numeric.digits.exec(rest)
      if (m) {
        const code = parseInt(m[0], numeric.radix)
        out += code <= 0x10ffff ? String.fromCodePoint(code) : RUNTIME
        st.pos += numeric.skip + m[0].length
        continue
      }
    }
    if (n === 'c' && src[st.pos + 2] !== undefined) {
      out += String.fromCharCode(src.charCodeAt(st.pos + 2) & 0x1f)
      st.pos += 3
      continue
    }
    out += c
    st.pos++
  }
  st.unparsable = true
  return out
}

/** After a backquote: parse the commands inside up to the closing one. */
function readBackquote(st: ParseState, depth: number): string {
  const src = st.src
  st.notes.substitution = true
  st.pos++
  let inner = ''
  while (st.pos < src.length) {
    const c = src[st.pos]
    if (c === '\\') {
      const n = src[st.pos + 1]
      if (n === '`' || n === '\\' || n === '$') {
        inner += n
        st.pos += 2
        continue
      }
      inner += c
      st.pos++
      continue
    }
    if (c === '`') {
      st.pos++
      parseNested(st, inner, depth)
      return RUNTIME
    }
    inner += c
    st.pos++
  }
  st.unparsable = true
  return RUNTIME
}

/** After `${`: skip to the matching `}`, reading any substitution inside. */
function skipParameter(st: ParseState, depth: number): void {
  const src = st.src
  const start = st.pos
  let level = 1
  while (st.pos < src.length) {
    const c = src[st.pos]
    if (c === '\\') {
      st.pos += 2
    } else if (c === "'") {
      const end = src.indexOf("'", st.pos + 1)
      if (end === -1) break
      st.pos = end + 1
    } else if (c === '"') {
      st.pos++
      readDouble(st, depth, '"')
    } else if (c === '$' && src[st.pos + 1] === '{') {
      level++
      st.pos += 2
    } else if (c === '$') {
      readDollar(st, depth, false)
    } else if (c === '`') {
      readBackquote(st, depth)
    } else if (c === '}') {
      st.pos++
      level--
      if (level === 0) {
        // the P operator expands its value like a prompt string, which runs
        // the substitutions in it
        if (/@P/.test(src.slice(start, st.pos - 1))) {
          st.notes.promptExpansion = true
        }
        return
      }
    } else {
      st.pos++
    }
  }
  st.unparsable = true
}

/** At a `$`: read the expansion and return the text that stands for it. */
function readDollar(st: ParseState, depth: number, inDouble: boolean): string {
  const src = st.src
  const n = src[st.pos + 1]
  if (n === '(') {
    st.notes.substitution = true
    if (src[st.pos + 2] === '(') {
      const end = arithmeticEnd(src, st.pos + 3)
      if (end !== -1) {
        if (/`|\$\(/.test(src.slice(st.pos + 3, end - 2))) st.unparsable = true
        st.pos = end
        return RUNTIME
      }
    }
    st.pos += 2
    parseList(st, ')', depth + 1)
    return RUNTIME
  }
  if (n === '{') {
    st.pos += 2
    skipParameter(st, depth)
    return RUNTIME
  }
  if (n === '[') {
    // the old form of an arithmetic expansion, which also reads its operands
    // as expressions
    st.notes.substitution = true
  }
  if (n === "'" && !inDouble) {
    st.pos += 2
    return readAnsiC(st)
  }
  if (n === '"' && !inDouble) {
    st.pos += 2
    return readDouble(st, depth, '"')
  }
  if (isNameStart(n)) {
    st.pos++
    while (isNameChar(src[st.pos])) st.pos++
    return RUNTIME
  }
  if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
    st.pos += 2
    return RUNTIME
  }
  st.pos++
  return '$'
}

/**
 * Is the backslash at `pos` in front of a backquote or of `$(`? The shell
 * takes the text literally, and `let`, `declare`, `printf -v` and arithmetic
 * evaluate it again as an expression, which runs the substitution in it.
 */
function isEscapedSubstitution(src: string, pos: number): boolean {
  const n = src[pos + 1]
  return n === '`' || (n === '$' && src[pos + 2] === '(')
}

/** Inside double quotes (or a here-document body when `end` is null). */
function readDouble(
  st: ParseState,
  depth: number,
  end: '"' | null,
): string {
  const src = st.src
  let out = ''
  while (st.pos < src.length) {
    const c = src[st.pos]
    if (end !== null && c === end) {
      st.pos++
      return out
    }
    if (c === '\\') {
      const n = src[st.pos + 1]
      if (n === '$' || n === '`' || n === '"' || n === '\\') {
        if (end !== null && isEscapedSubstitution(src, st.pos)) {
          st.notes.substitution = true
        }
        out += n
        st.pos += 2
      } else if (n === '\n') {
        st.pos += 2
      } else {
        out += c
        st.pos++
      }
    } else if (c === '$') {
      out += readDollar(st, depth, true)
    } else if (c === '`') {
      out += readBackquote(st, depth)
    } else {
      out += c
      st.pos++
    }
  }
  if (end !== null) st.unparsable = true
  return out
}

function readHereDocBodies(
  st: ParseState,
  depth: number,
  pending: Array<
    { target: SimpleCommand; delimiter: string; raw: boolean; tabs: boolean }
  >,
): void {
  const src = st.src
  for (const doc of pending) {
    let body = ''
    while (st.pos < src.length) {
      const newline = src.indexOf('\n', st.pos)
      const lineEnd = newline === -1 ? src.length : newline
      const line = src.slice(st.pos, lineEnd)
      st.pos = newline === -1 ? src.length : newline + 1
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
      body += line + '\n'
    }
    doc.target.hereDocs.push(body)
    if (!doc.raw) {
      // an unquoted delimiter: the body is expanded like double-quoted text
      const sub: ParseState = {
        src: body,
        pos: 0,
        commands: st.commands,
        unparsable: false,
        notes: st.notes,
      }
      readDouble(sub, depth + 1, null)
      if (sub.unparsable) st.unparsable = true
    }
  }
  pending.length = 0
}

/**
 * Read commands up to the end of the text, or up to the `)` that closes a
 * group when `closer` is ')'. Every simple command found, including those
 * inside substitutions, is added to `st.commands` with its words after quote
 * removal. Text the shell only knows at run time is a placeholder.
 */
function parseList(st: ParseState, closer: ')' | null, depth: number): void {
  if (depth > MAX_NESTING) {
    st.unparsable = true
    st.pos = st.src.length
    return
  }
  const src = st.src
  let cur: SimpleCommand = {
    words: [],
    redirects: [],
    hereDocs: [],
    hereStrings: [],
  }
  let word = null as string | null
  let quoted = false
  let bracket = false
  let brace = false
  let globbed = false
  let redirect = null as 'plain' | 'string' | 'doc' | null
  let tabs = false
  const pendingDocs: Array<
    { target: SimpleCommand; delimiter: string; raw: boolean; tabs: boolean }
  > = []

  const append = (text: string) => {
    word = (word ?? '') + text
  }
  const endWord = () => {
    if (word === null) return
    const finished = globbed ? word + PATTERN : word
    if (redirect === 'doc') {
      pendingDocs.push({
        target: cur,
        delimiter: finished,
        raw: quoted,
        tabs,
      })
    } else if (redirect === 'string') {
      cur.hereStrings.push(finished)
    } else if (redirect === 'plain') {
      cur.redirects.push(finished)
    } else {
      cur.words.push(finished)
    }
    redirect = null
    word = null
    quoted = false
    bracket = false
    brace = false
    globbed = false
  }
  const endCommand = () => {
    endWord()
    if (redirect !== null) {
      // a redirection with nothing to redirect to
      st.unparsable = true
      redirect = null
    }
    if (cur.words.length > 0 || cur.redirects.length > 0) {
      st.commands.push(cur)
    }
    cur = { words: [], redirects: [], hereDocs: [], hereStrings: [] }
  }

  while (st.pos < src.length) {
    const c = src[st.pos]
    if (c === ' ' || c === '\t') {
      endWord()
      st.pos++
    } else if (c === '\n') {
      endCommand()
      st.pos++
      readHereDocBodies(st, depth, pendingDocs)
    } else if (c === '\\') {
      const n = src[st.pos + 1]
      if (n === undefined) {
        st.unparsable = true
        st.pos++
      } else if (n === '\n') {
        st.pos += 2
      } else {
        if (isEscapedSubstitution(src, st.pos)) st.notes.substitution = true
        append(n)
        quoted = true
        st.pos += 2
      }
    } else if (c === "'") {
      const end = src.indexOf("'", st.pos + 1)
      if (end === -1) {
        st.unparsable = true
        st.pos = src.length
      } else {
        append(src.slice(st.pos + 1, end))
        quoted = true
        st.pos = end + 1
      }
    } else if (c === '"') {
      st.pos++
      append(readDouble(st, depth, '"'))
      quoted = true
    } else if (c === '$') {
      const next = src[st.pos + 1]
      if (next === "'" || next === '"') quoted = true
      append(readDollar(st, depth, false))
    } else if (c === '`') {
      append(readBackquote(st, depth))
    } else if (c === '#' && word === null) {
      while (st.pos < src.length && src[st.pos] !== '\n') st.pos++
    } else if (c === ';') {
      endCommand()
      st.pos++
    } else if (c === '&') {
      if (src[st.pos + 1] === '&') {
        endCommand()
        st.pos += 2
      } else if (src[st.pos + 1] === '>') {
        endWord()
        redirect = 'plain'
        st.pos += src[st.pos + 2] === '>' ? 3 : 2
      } else {
        endCommand()
        st.pos++
      }
    } else if (c === '|') {
      endCommand()
      st.pos++
      if (src[st.pos] === '|' || src[st.pos] === '&') st.pos++
    } else if (c === '(') {
      endCommand()
      st.pos++
      parseList(st, ')', depth + 1)
    } else if (c === ')') {
      st.pos++
      if (closer === ')') {
        endCommand()
        return
      }
      st.unparsable = true
    } else if (c === '<' || c === '>') {
      if (src[st.pos + 1] === '(') {
        st.pos += 2
        parseList(st, ')', depth + 1)
        append(RUNTIME)
      } else {
        // a number glued to the operator is a file descriptor, not a word
        if (word !== null && !quoted && /^[0-9]+$/.test(word)) {
          word = null
        } else {
          endWord()
        }
        let length = 1
        let kind: 'plain' | 'string' | 'doc' = 'plain'
        tabs = false
        if (c === '<') {
          if (src.startsWith('<<<', st.pos)) {
            length = 3
            kind = 'string'
          } else if (src.startsWith('<<-', st.pos)) {
            length = 3
            kind = 'doc'
            tabs = true
          } else if (src.startsWith('<<', st.pos)) {
            length = 2
            kind = 'doc'
          } else if (src[st.pos + 1] === '&' || src[st.pos + 1] === '>') {
            length = 2
          }
        } else if (
          src[st.pos + 1] === '>' || src[st.pos + 1] === '&' ||
          src[st.pos + 1] === '|'
        ) {
          length = 2
        }
        st.pos += length
        redirect = kind
      }
    } else if (c === '*' || c === '?') {
      append(PATTERN)
      st.pos++
    } else if (c === '[') {
      append(c)
      bracket = true
      st.pos++
    } else if (c === ']') {
      append(c)
      if (bracket) globbed = true
      st.pos++
    } else if (c === '{') {
      append(c)
      brace = true
      st.pos++
    } else if (c === '}') {
      append(c)
      if (brace) globbed = true
      st.pos++
    } else {
      append(c)
      st.pos++
    }
  }
  endCommand()
  readHereDocBodies(st, depth, pendingDocs)
  if (closer !== null) st.unparsable = true
}

/** Commands that always need a person at a terminal, by command name. */
const GATED_COMMANDS = new Set([
  'ansible-playbook',
  'ansible',
  'ansible-pull',
  'ansible-console',
  'ansible-vault',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ssh-copy-id',
  'ssh-keygen',
  'ssh-add',
  'ssh-agent',
  'sshfs',
  'sshpass',
  'mosh',
  'autossh',
  'solana-keygen',
  'agave-keygen',
  'op',
  // the tools that install the validator software, rewrite the ledger or sign
  // token transactions with the keypair
  'agave-install',
  'solana-install',
  'agave-ledger-tool',
  'solana-ledger-tool',
  'spl-token',
  // the clients of the system bus, which can call into systemd
  'busctl',
  'dbus-send',
  'gdbus',
])

/** `slv v|validator|rpc|r <verb>` verbs that change nodes or keys. */
const SLV_NAMESPACES = new Set(['v', 'validator', 'rpc', 'r'])
const SLV_NODE_VERBS = new Set([
  'set:identity',
  'set:unstaked',
  'switch',
  'cleanup',
  'deploy',
  'restart',
  'stop',
  'start',
  'register:bls',
  'gen:vote-account',
  'init',
])
const SLV_NODE_VERB_PREFIXES = [
  'build:',
  'install:',
  'update:',
  'setup:',
  'patch:',
  'doublezero:',
]
/** Other slv command groups whose every verb changes a node. */
const SLV_NODE_GROUPS = new Set([
  'hermes',
  'h',
  'pythnet',
  'install',
  'i',
  'migrate',
  'add:ssh',
  'disable',
  'upgrade',
  'upgrade:settings',
])

const SHELLS = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'ksh',
  'ash',
  'mksh',
  'csh',
  'tcsh',
  'fish',
])

/** Words that start a command without being one. */
const LEADING_WORDS = new Set([
  '!',
  '{',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
])
/** Words after which the rest of the simple command is not a command. */
const NON_COMMAND_WORDS = new Set([
  'for',
  'select',
  'case',
  'in',
  'done',
  'fi',
  'esac',
  '}',
])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

// ---------------------------------------------------------------------------
// Local node and service control
//
// Each table lists what a program does that needs a person, or the short list
// of forms that only print. A form that is not on the read-only list is gated.
// ---------------------------------------------------------------------------

/** Programs that run, stop or reconfigure a validator on this machine. */
const VALIDATOR_BINARIES = new Set([
  'agave-validator',
  'solana-validator',
  'fdctl',
  'firedancer',
  'fddev',
  'firedancer-dev',
])
/**
 * The forms of those programs that only print: the version and the help text,
 * `contact-info` (prints the gossip entry of the node) and `monitor` (shows
 * the state of the running process). They change nothing.
 */
const VALIDATOR_READ_ONLY_FLAGS = new Set(['--version', '-V', '--help', '-h'])
const VALIDATOR_READ_ONLY_COMMANDS = new Set([
  'version',
  'help',
  'contact-info',
  'monitor',
])
/** Options in front of the subcommand that take a value. */
const VALIDATOR_VALUE_OPTIONS = new Set(['--ledger', '-l', '--config'])
/** Subcommands that change a running or a stopped validator. */
const VALIDATOR_CHANGING_COMMANDS = new Set([
  'exit',
  'set-identity',
  'authorized-voter',
  'set-log-filter',
  'wait-for-restart-window',
  'set-public-address',
  'repair-whitelist',
  'staked-nodes-overrides',
  'plugin',
  'run',
  'run1',
  'run-agave',
  'configure',
  'keys',
  'set-block-production-method',
  'manage-block-production',
  'repair-shred-from-peer-address',
  'set-relayer-config',
  'set-shred-receiver-address',
  'set-shred-retransmit-receiver-address',
  'set-block-engine-config',
  'init',
])

/** The options of systemctl that the gate can read; -H and -M are not among them. */
const SYSTEMCTL_OPTIONS: WrapperSpec = {
  argShort: 'nopst',
  flagShort: 'alqrhfi',
  argLong: [
    '--lines',
    '--output',
    '--property',
    '--type',
    '--state',
    '--signal',
    '--kill-whom',
    '--kill-who',
    '--job-mode',
    '--root',
    '--check-inhibitors',
    '--message',
    '--timestamp',
    '--preset-mode',
    '--when',
  ],
  flagLong: [
    '--all',
    '--recursive',
    '--reverse',
    '--after',
    '--before',
    '--with-dependencies',
    '--full',
    '--show-types',
    '--plain',
    '--no-pager',
    '--no-legend',
    '--no-ask-password',
    '--no-block',
    '--quiet',
    '--no-wall',
    '--system',
    '--user',
    '--global',
    '--runtime',
    '--force',
    '--now',
    '--ignore-inhibitors',
    '--dry-run',
    '--wait',
    '--value',
    '--failed',
    '--show-transaction',
    '--no-reload',
    '--read-only',
    '--mkdir',
    '--no-warn',
    '--help',
    '--version',
  ],
}
/** systemctl verbs that only report. */
const SYSTEMCTL_READ_ONLY_VERBS = new Set([
  'status',
  'show',
  'cat',
  'is-active',
  'is-enabled',
  'is-failed',
  'is-system-running',
  'list-units',
  'list-unit-files',
  'list-sockets',
  'list-timers',
  'list-dependencies',
  'list-jobs',
  'list-machines',
  'list-automounts',
  'list-paths',
  'get-default',
  'show-environment',
  'help',
])
/** Verbs of systemctl and service that change the state of a unit or the host. */
const STATE_VERBS = new Set([
  'start',
  'stop',
  'restart',
  'reload',
  'try-restart',
  'reload-or-restart',
  'try-reload-or-restart',
  'force-reload',
  'force-stop',
  'force-restart',
  'full-restart',
  'condrestart',
  'enable',
  'disable',
  'reenable',
  'preset',
  'preset-all',
  'mask',
  'unmask',
  'kill',
  'daemon-reload',
  'daemon-reexec',
  'isolate',
  'edit',
  'link',
  'revert',
  'set-property',
  'reset-failed',
  'add-wants',
  'add-requires',
  'set-default',
  'set-environment',
  'unset-environment',
  'import-environment',
  'reboot',
  'poweroff',
  'halt',
  'kexec',
  'suspend',
  'hibernate',
  'hybrid-sleep',
  'rescue',
  'emergency',
  'default',
  'exit',
  'switch-root',
  'freeze',
  'thaw',
  'clean',
  'bind',
  'mount-image',
  'cancel',
])

/** The options in front of a solana subcommand. */
const SOLANA_OPTIONS: WrapperSpec = {
  argShort: 'ukC',
  flagShort: 'vhV',
  argLong: [
    '--url',
    '--keypair',
    '--config',
    '--commitment',
    '--output',
    '--ws',
  ],
  flagLong: [
    '--verbose',
    '--help',
    '--version',
    '--no-address-labels',
    '--use-quic',
    '--use-udp',
    '--use-tpu-client',
    '--use-rpc',
  ],
}
/**
 * solana subcommands that neither sign nor change anything: they ask the
 * cluster or decode data. `config` and `feature` are read-only only with
 * `get` and `status`.
 */
const SOLANA_READ_ONLY = new Set([
  'account',
  'address',
  'balance',
  'block',
  'block-height',
  'block-production',
  'block-time',
  'catchup',
  'cluster-date',
  'cluster-version',
  'confirm',
  'decode-transaction',
  'epoch',
  'epoch-info',
  'fees',
  'first-available-block',
  'genesis-hash',
  'gossip',
  'help',
  'inflation',
  'largest-accounts',
  'leader-schedule',
  'live-slots',
  'logs',
  'nonce',
  'nonce-account',
  'rent',
  'slot',
  'stake-account',
  'stake-history',
  'stake-minimum-delegation',
  'stakes',
  'supply',
  'transaction-count',
  'transaction-history',
  'validators',
  'vote-account',
])
/** solana subcommands that sign a transaction or change an account or the config. */
const SOLANA_CHANGING = new Set([
  'airdrop',
  'authorize-nonce-account',
  'close',
  'create-address-with-seed',
  'create-nonce-account',
  'create-stake-account',
  'create-stake-account-checked',
  'create-vote-account',
  'deactivate-stake',
  'delegate-stake',
  'deploy',
  'merge-stake',
  'new-nonce',
  'ping',
  'program',
  'program-v4',
  'redelegate-stake',
  'send-transaction',
  'sign-offchain-message',
  'split-stake',
  'stake-authorize',
  'stake-authorize-checked',
  'stake-set-lockup',
  'stake-set-lockup-checked',
  'transfer',
  'upgrade-nonce-account',
  'vote-authorize-voter',
  'vote-authorize-voter-checked',
  'vote-authorize-withdrawer',
  'vote-authorize-withdrawer-checked',
  'vote-update-commission',
  'vote-update-validator',
  'withdraw-from-nonce-account',
  'withdraw-from-vote-account',
  'withdraw-stake',
])

/**
 * Shell built-ins that read an argument as an expression: an array subscript
 * in it can hold a command substitution, which they run.
 */
const EVALUATING_BUILTINS = new Set([
  'let',
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
  'unset',
  'test',
  '[',
  '[[',
])

/** Programs that stop processes or the host. */
const PROCESS_CONTROL = new Set([
  'kill',
  'pkill',
  'killall',
  'reboot',
  'poweroff',
  'halt',
  'shutdown',
  'telinit',
])

// ---------------------------------------------------------------------------
// Interpreters and programs that run what they are given
// ---------------------------------------------------------------------------

/** Language interpreters; a trailing version number is removed from a name. */
const INTERPRETERS = new Set([
  'python',
  'pypy',
  'perl',
  'ruby',
  'irb',
  'pry',
  'php',
  'lua',
  'luajit',
  'node',
  'nodejs',
  'bun',
  'bunx',
  'tsx',
  'ts-node',
  'npx',
  'pnpx',
  'rscript',
  'julia',
  'tclsh',
  'wish',
  'expect',
  'groovy',
  'jshell',
  'osascript',
])
/** The only arguments with which an interpreter does not run code. */
const INTERPRETER_VERSION_FLAGS = new Set([
  '--version',
  '-V',
  '-VV',
  '-v',
  '--help',
  '-h',
])
/** deno subcommands that only print. */
const DENO_READ_ONLY_COMMANDS = new Set(['help', 'info', 'types'])
const AWK_NAMES = new Set(['awk', 'gawk', 'mawk', 'nawk'])
/** Programs that run the command lines they are given, and are gated with only their version and help forms left. */
const RUN_ANYTHING = new Set(['parallel', 'gdb', 'lldb'])
/** tmux commands that list sessions, windows, panes and keys and show no text of them. */
const TMUX_READ_ONLY_COMMANDS = new Set([
  'ls',
  'list-sessions',
  'list-windows',
  'list-panes',
  'list-clients',
  'list-commands',
  'list-keys',
  'has-session',
])
const SCREEN_READ_ONLY_FLAGS = new Set([
  '-ls',
  '-list',
  '-v',
  '--version',
  '-h',
  '--help',
])

// ---------------------------------------------------------------------------
// The backstop: names found in the text of a command
// ---------------------------------------------------------------------------

/** Whitespace, shell metacharacters and the placeholders; not / . - : _ */
const TOKEN_SEPARATORS = /[\s|&;()<>$`"'\\{}[\]*?!#=,@\u0000\u0001]+/
/** Commands that print where a name resolves and run nothing. */
const LOOKUP_COMMANDS = new Set(['which', 'type', 'hash', 'whereis'])
/**
 * Words after the name of an interpreter that make it run code: a flag with
 * inline code, a subcommand of deno, or the name of a script.
 */
const CODE_FLAGS = new Set([
  '-c',
  '-e',
  '-E',
  '-r',
  '-p',
  '-m',
  '--eval',
  '--exec',
  'eval',
  'run',
  'task',
  'test',
  'repl',
  'compile',
  'install',
  'serve',
])
const SCRIPT_NAME = /\.(py|pl|rb|js|mjs|cjs|ts|php|lua|sh|r)$/i

/** How a wrapper command (sudo, env, timeout, ...) takes its options. */
type WrapperSpec = {
  /** short options with an argument */
  argShort?: string
  /** short options without an argument */
  flagShort?: string
  /** short options whose argument, if any, is glued to them */
  optionalShort?: string
  argLong?: string[]
  flagLong?: string[]
  /** words before the wrapped command (the duration of timeout) */
  positional?: number
  /** NAME=value words before the wrapped command */
  assignments?: boolean
  /** a number as an option (nice -10) */
  numeric?: boolean
  /** a lone `-` is an option (env, su) */
  dash?: boolean
  /** options whose argument is a command line for a shell */
  scriptShort?: string
  scriptLong?: string[]
  /** options after which the words that follow are a command line (sudo -s) */
  shellShort?: string
  shellLong?: string[]
  /** the words that follow are joined and run by a shell (watch) */
  restIsScript?: boolean
  /** the words that follow are not a command (su user) */
  restIsData?: boolean
  /** options that only look a name up (command -v) */
  lookupShort?: string
  /** `-c command` may follow the positional words (flock) */
  scriptAfterPositional?: boolean
  /** options may follow the operands (su, runuser) */
  permute?: boolean
  /** a long option the table does not list is a flag, with its value glued on (firejail) */
  longFlagsAny?: boolean
}

const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: {
    argShort: 'CDgpRrTtUu',
    flagShort: 'ABbEeHhiKklnPSsVv',
    argLong: [
      '--chdir',
      '--chroot',
      '--close-from',
      '--command-timeout',
      '--group',
      '--host',
      '--other-user',
      '--prompt',
      '--role',
      '--type',
      '--user',
      '--login-class',
    ],
    flagLong: [
      '--askpass',
      '--background',
      '--bell',
      '--edit',
      '--help',
      '--list',
      '--login',
      '--non-interactive',
      '--preserve-env',
      '--preserve-groups',
      '--remove-timestamp',
      '--reset-timestamp',
      '--set-home',
      '--shell',
      '--stdin',
      '--validate',
      '--version',
      '--no-update',
    ],
    assignments: true,
    shellShort: 'si',
    shellLong: ['--login', '--shell'],
  },
  doas: { argShort: 'aCu', flagShort: 'nsS' },
  env: {
    argShort: 'uCSP',
    flagShort: 'i0v',
    argLong: ['--unset', '--chdir', '--split-string', '--argv0'],
    flagLong: [
      '--ignore-environment',
      '--null',
      '--debug',
      '--help',
      '--version',
      '--default-signal',
      '--ignore-signal',
      '--block-signal',
      '--list-signal-handling',
    ],
    assignments: true,
    dash: true,
    scriptShort: 'S',
    scriptLong: ['--split-string'],
  },
  command: { flagShort: 'pVv', lookupShort: 'vV' },
  builtin: {},
  exec: { argShort: 'a', flagShort: 'cl' },
  nohup: { flagLong: ['--help', '--version'] },
  nice: {
    argShort: 'n',
    numeric: true,
    argLong: ['--adjustment'],
    flagLong: ['--help', '--version'],
  },
  ionice: {
    argShort: 'cnpPu',
    flagShort: 'thV',
    argLong: ['--class', '--classdata', '--pid', '--pgid', '--uid'],
    flagLong: ['--ignore', '--help', '--version'],
  },
  time: {
    argShort: 'fo',
    flagShort: 'apvqV',
    argLong: ['--format', '--output'],
    flagLong: [
      '--append',
      '--portability',
      '--verbose',
      '--quiet',
      '--help',
      '--version',
    ],
  },
  timeout: {
    argShort: 'sk',
    flagShort: 'v',
    argLong: ['--signal', '--kill-after'],
    flagLong: [
      '--foreground',
      '--preserve-status',
      '--verbose',
      '--help',
      '--version',
    ],
    positional: 1,
  },
  stdbuf: {
    argShort: 'ioe',
    argLong: ['--input', '--output', '--error'],
    flagLong: ['--help', '--version'],
  },
  setsid: {
    flagShort: 'cfwhV',
    flagLong: ['--ctty', '--fork', '--wait', '--help', '--version'],
  },
  flock: {
    argShort: 'wEc',
    flagShort: 'sxunoFVh',
    argLong: ['--timeout', '--conflict-exit-code', '--command'],
    flagLong: [
      '--shared',
      '--exclusive',
      '--unlock',
      '--nonblock',
      '--nb',
      '--no-fork',
      '--close',
      '--verbose',
      '--help',
      '--version',
    ],
    positional: 1,
    scriptShort: 'c',
    scriptLong: ['--command'],
    scriptAfterPositional: true,
  },
  taskset: {
    flagShort: 'apcVh',
    flagLong: ['--all-tasks', '--pid', '--cpu-list', '--help', '--version'],
    positional: 1,
  },
  chrt: {
    flagShort: 'bfiorRdmpavh',
    flagLong: ['--help', '--version'],
    positional: 1,
  },
  busybox: {},
  unbuffer: { flagShort: 'p' },
  watch: {
    argShort: 'n',
    optionalShort: 'd',
    flagShort: 'bcegpqrtwxhv',
    argLong: ['--interval'],
    flagLong: [
      '--differences',
      '--beep',
      '--color',
      '--no-color',
      '--errexit',
      '--chgexit',
      '--equexit',
      '--exec',
      '--help',
      '--no-title',
      '--no-wrap',
      '--precise',
      '--version',
    ],
    restIsScript: true,
  },
  xargs: {
    argShort: 'aEdILnPs',
    optionalShort: 'ile',
    flagShort: '0oprtvx',
    argLong: [
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-chars',
      '--max-procs',
      '--process-slot-var',
    ],
    flagLong: [
      '--null',
      '--open-tty',
      '--interactive',
      '--no-run-if-empty',
      '--verbose',
      '--exit',
      '--show-limits',
      '--help',
      '--version',
      '--replace',
      '--eof',
      '--max-lines',
    ],
  },
  su: {
    argShort: 'cgGsw',
    flagShort: 'lmpPVh',
    argLong: [
      '--command',
      '--group',
      '--supp-group',
      '--shell',
      '--whitelist-environment',
    ],
    flagLong: [
      '--login',
      '--preserve-environment',
      '--pty',
      '--fast',
      '--help',
      '--version',
    ],
    dash: true,
    scriptShort: 'c',
    scriptLong: ['--command'],
    restIsData: true,
    permute: true,
  },
  runuser: {
    argShort: 'ugGcsw',
    flagShort: 'lmpPfVh',
    argLong: [
      '--user',
      '--group',
      '--supp-group',
      '--command',
      '--shell',
      '--whitelist-environment',
    ],
    flagLong: [
      '--login',
      '--preserve-environment',
      '--pty',
      '--fast',
      '--help',
      '--version',
    ],
    dash: true,
    scriptShort: 'c',
    scriptLong: ['--command'],
    permute: true,
  },
  script: {
    argShort: 'cBIOTmoE',
    optionalShort: 't',
    flagShort: 'aefqVh',
    argLong: [
      '--command',
      '--log-io',
      '--log-in',
      '--log-out',
      '--log-timing',
      '--logging-format',
      '--output-limit',
      '--echo',
    ],
    flagLong: [
      '--append',
      '--return',
      '--flush',
      '--force',
      '--quiet',
      '--timing',
      '--help',
      '--version',
    ],
    scriptShort: 'c',
    scriptLong: ['--command'],
    restIsData: true,
    permute: true,
  },
  chroot: {
    argLong: ['--userspec', '--groups'],
    flagLong: ['--skip-chdir', '--help', '--version'],
    positional: 1,
  },
  setpriv: {
    flagShort: 'dVh',
    argLong: [
      '--reuid',
      '--regid',
      '--ruid',
      '--euid',
      '--rgid',
      '--egid',
      '--groups',
      '--inh-caps',
      '--bounding-set',
      '--ambient-caps',
      '--securebits',
      '--pdeathsig',
      '--selinux-label',
      '--apparmor-profile',
      '--landlock-access',
      '--landlock-rule',
    ],
    flagLong: [
      '--clear-groups',
      '--init-groups',
      '--keep-groups',
      '--no-new-privs',
      '--reset-env',
      '--dump',
      '--list-caps',
      '--help',
      '--version',
    ],
  },
  nsenter: {
    argShort: 'tSG',
    optionalShort: 'muinpCUTrw',
    flagShort: 'FZaVh',
    argLong: ['--target', '--setuid', '--setgid'],
    flagLong: [
      '--mount',
      '--uts',
      '--ipc',
      '--net',
      '--pid',
      '--cgroup',
      '--user',
      '--time',
      '--root',
      '--wd',
      '--no-fork',
      '--follow-context',
      '--preserve-credentials',
      '--env',
      '--all',
      '--help',
      '--version',
    ],
  },
  unshare: {
    argShort: 'RwSG',
    optionalShort: 'muinpUCT',
    flagShort: 'frcVh',
    argLong: [
      '--root',
      '--wd',
      '--setuid',
      '--setgid',
      '--propagation',
      '--setgroups',
      '--map-user',
      '--map-group',
      '--map-users',
      '--map-groups',
      '--monotonic',
      '--boottime',
    ],
    flagLong: [
      '--mount',
      '--uts',
      '--ipc',
      '--net',
      '--pid',
      '--user',
      '--cgroup',
      '--time',
      '--fork',
      '--kill-child',
      '--map-root-user',
      '--map-current-user',
      '--map-auto',
      '--keep-caps',
      '--mount-proc',
      '--help',
      '--version',
    ],
  },
  strace: {
    argShort: 'abeEIoOpPsSuUX',
    flagShort: 'cCdDfFhiknNqrtTvVwxyzZ',
    argLong: [
      '--output',
      '--trace',
      '--signal',
      '--status',
      '--summary-sort-by',
      '--string-limit',
      '--user',
      '--env',
      '--attach',
      '--columns',
      '--inject',
      '--fault',
      '--trace-path',
      '--secontext',
      '--decode-pids',
    ],
    flagLong: [
      '--follow-forks',
      '--summary',
      '--summary-only',
      '--no-abbrev',
      '--help',
      '--version',
      '--debug',
      '--instruction-pointer',
      '--absolute-timestamps',
      '--relative-timestamps',
      '--syscall-times',
      '--decode-fds',
      '--successful-only',
      '--failed-only',
      '--quiet',
    ],
  },
  'systemd-run': {
    argShort: 'upE',
    flagShort: 'rtPGqdShV',
    argLong: [
      '--unit',
      '--property',
      '--description',
      '--slice',
      '--service-type',
      '--uid',
      '--gid',
      '--nice',
      '--setenv',
      '--working-directory',
      '--on-active',
      '--on-boot',
      '--on-startup',
      '--on-unit-active',
      '--on-unit-inactive',
      '--on-calendar',
      '--on-clock-change',
      '--on-timezone-change',
      '--timer-property',
      '--background',
      '--job-mode',
    ],
    flagLong: [
      '--user',
      '--system',
      '--scope',
      '--remain-after-exit',
      '--send-sighup',
      '--pty',
      '--pipe',
      '--wait',
      '--collect',
      '--quiet',
      '--no-block',
      '--no-ask-password',
      '--same-dir',
      '--shell',
      '--no-pager',
      '--expand-environment',
      '--help',
      '--version',
    ],
  },
  pkexec: {
    argLong: ['--user'],
    flagLong: ['--keep-cwd', '--disable-internal-agent', '--help', '--version'],
  },
  sg: {
    positional: 1,
    dash: true,
    scriptShort: 'c',
    scriptAfterPositional: true,
    restIsScript: true,
  },
  firejail: { longFlagsAny: true },
  prlimit: { argShort: 'po', flagShort: 'hV', longFlagsAny: true },
}

type WrapperRead = {
  rest: string[]
  script?: string
  shell: boolean
  lookup: boolean
  unreadable: boolean
}

function readWrapper(spec: WrapperSpec, args: string[]): WrapperRead {
  const has = (list: string | undefined, ch: string) =>
    list !== undefined && list.includes(ch)
  const unreadable: WrapperRead = {
    rest: [],
    shell: false,
    lookup: false,
    unreadable: true,
  }
  let i = 0
  let script: string | undefined
  let shell = false
  let lookup = false
  // operands met between the options of a program that lets options follow them
  const operands: string[] = []
  while (i < args.length) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (a === '-' && spec.dash) {
      i++
      continue
    }
    if (!a.startsWith('-') || a === '-') {
      if (spec.permute) {
        operands.push(a)
        i++
        continue
      }
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq === -1 ? a : a.slice(0, eq)
      if (spec.argLong?.includes(name)) {
        const value = eq === -1 ? args[i + 1] : a.slice(eq + 1)
        if (spec.scriptLong?.includes(name)) script = value
        i += eq === -1 ? 2 : 1
      } else if (spec.flagLong?.includes(name)) {
        if (spec.shellLong?.includes(name)) shell = true
        i++
      } else if (spec.longFlagsAny) {
        i++
      } else {
        return unreadable
      }
      continue
    }
    let used = 1
    for (let k = 1; k < a.length; k++) {
      const ch = a[k]
      if (has(spec.argShort, ch)) {
        const attached = a.slice(k + 1)
        if (has(spec.scriptShort, ch)) {
          script = attached !== '' ? attached : args[i + 1]
        }
        if (attached === '') used = 2
        break
      }
      if (has(spec.optionalShort, ch)) break
      if (has(spec.flagShort, ch)) {
        if (has(spec.shellShort, ch)) shell = true
        if (has(spec.lookupShort, ch)) lookup = true
        continue
      }
      if (spec.numeric && ch >= '0' && ch <= '9') continue
      return unreadable
    }
    i += used
  }
  if (spec.assignments) {
    while (i < args.length && ASSIGNMENT.test(args[i])) i++
  }
  i += spec.positional ?? 0
  let rest = operands.concat(args.slice(i))
  if (
    spec.scriptAfterPositional && script === undefined &&
    (rest[0] === '-c' || rest[0] === '--command')
  ) {
    script = rest[1]
    rest = []
  }
  return { rest, script, shell, lookup, unreadable: false }
}

/** The name a command word runs, or null when only the shell knows it. */
function commandName(word: string): string | null {
  const last = word.slice(word.lastIndexOf('/') + 1)
  return hasUnknownPart(last) ? null : last.toLowerCase()
}

function isNodeVerb(verb: string): boolean {
  return SLV_NODE_VERBS.has(verb) ||
    SLV_NODE_VERB_PREFIXES.some((prefix) => verb.startsWith(prefix))
}

function analyzeSlv(args: string[], found: string[]): void {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i++
  const first = args[i]
  if (first === undefined) return
  if (hasUnknownPart(first)) {
    found.push('slv with a verb known only at run time')
    return
  }
  const group = first.toLowerCase()
  if (SLV_NAMESPACES.has(group)) {
    let j = i + 1
    while (j < args.length && args[j].startsWith('-')) j++
    const verb = args[j]
    if (verb === undefined) return
    if (hasUnknownPart(verb)) {
      found.push(`slv ${group} with a verb known only at run time`)
    } else if (isNodeVerb(verb.toLowerCase())) {
      found.push(`slv ${group} ${verb.toLowerCase()}`)
    }
    return
  }
  if (SLV_NODE_GROUPS.has(group) || isNodeVerb(group)) {
    found.push(`slv ${group}`)
  }
}

function analyzeRm(args: string[], found: string[]): void {
  let options = true
  for (const arg of args) {
    if (
      arg.includes(RUNTIME) || (arg.startsWith('{') && arg.includes(PATTERN))
    ) {
      found.push('rm with an argument known only at run time')
      return
    }
    if (options && arg === '--') {
      options = false
    } else if (options && arg.startsWith('--')) {
      const name = arg.split('=')[0]
      if (
        name.length > 2 &&
        ('--recursive'.startsWith(name) || '--force'.startsWith(name))
      ) {
        found.push('rm -r/-f')
        return
      }
    } else if (options && arg.startsWith('-') && /[rRf]/.test(arg)) {
      found.push('rm -r/-f')
      return
    }
  }
}

function analyzeShell(
  name: string,
  args: string[],
  input: SimpleCommand | null,
  depth: number,
  found: string[],
): void {
  if (
    args.length > 0 && args.every((a) => a === '--version' || a === '--help')
  ) {
    return
  }
  let i = 0
  let command = false
  let stdin = false
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (a.startsWith('--')) {
      if (a === '--rcfile' || a === '--init-file') i++
      continue
    }
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1) {
      if (a.startsWith('-') && a.slice(1).includes('c')) command = true
      if (a.startsWith('-') && a.slice(1).includes('s')) stdin = true
      if (/[oO]$/.test(a)) i++
      continue
    }
    break
  }
  const operand = args[i]
  if (command) {
    if (operand !== undefined) analyzeScript(operand, depth + 1, found)
    return
  }
  if (operand !== undefined && !stdin && !isInputFile(operand)) {
    // the commands in a script file are not read here
    found.push(`${name} running a script file`)
    return
  }
  analyzeInput(name, input, depth, found)
}

const isInputFile = (word: string): boolean =>
  word === '-' || word === '/dev/stdin' || word === '/dev/fd/0'

/** A shell that reads its commands from the input of the command line. */
function analyzeInput(
  name: string,
  input: SimpleCommand | null,
  depth: number,
  found: string[],
): void {
  const bodies = input === null ? [] : [...input.hereDocs, ...input.hereStrings]
  if (bodies.length === 0) {
    found.push(`${name} reading commands from its input`)
    return
  }
  for (const body of bodies) analyzeScript(body, depth + 1, found)
}

function analyzeSource(
  name: string,
  args: string[],
  input: SimpleCommand | null,
  depth: number,
  found: string[],
): void {
  const operand = args[0]
  if (operand === undefined) return
  if (operand.includes(RUNTIME)) {
    found.push(`${name} of a file named only when the shell runs`)
  } else if (isInputFile(operand)) {
    analyzeInput(name, input, depth, found)
  } else {
    // the commands in the file are not read here
    found.push(`${name} of a script file`)
  }
}

/** Text a shell builtin keeps and runs later: trap actions, alias values. */
function analyzeStoredCommands(
  name: string,
  args: string[],
  depth: number,
  found: string[],
): void {
  if (name === 'alias') {
    for (const arg of args) {
      const eq = arg.indexOf('=')
      if (eq > 0) analyzeScript(arg.slice(eq + 1), depth + 1, found)
    }
    return
  }
  const rest = args.filter((a) => !a.startsWith('-'))
  if (rest.length >= 2) analyzeScript(rest[0], depth + 1, found)
}

function analyzeFind(
  args: string[],
  depth: number,
  found: string[],
): void {
  for (let i = 0; i < args.length; i++) {
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) {
      const inner: string[] = []
      let j = i + 1
      while (j < args.length && args[j] !== ';' && args[j] !== '+') {
        inner.push(args[j])
        j++
      }
      analyzeWords(inner, null, depth + 1, found)
      i = j
    }
  }
}

/**
 * A validator program: only a version, a help text, `contact-info` or
 * `monitor`, with the options that name the ledger or the config, can run on
 * its own.
 */
function analyzeValidatorBinary(
  name: string,
  args: string[],
  found: string[],
): void {
  let i = 0
  let help = false
  while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
    const option = args[i].split('=')[0]
    if (VALIDATOR_READ_ONLY_FLAGS.has(option)) {
      help = true
      i++
    } else if (VALIDATOR_VALUE_OPTIONS.has(option)) {
      i += args[i].includes('=') ? 1 : 2
    } else {
      found.push(`${name} with an option the gate cannot read`)
      return
    }
  }
  if (help) return
  const command = args[i]
  if (command === undefined || hasUnknownPart(command)) {
    found.push(`${name} (not a read-only form)`)
    return
  }
  const lower = command.toLowerCase()
  if (!VALIDATOR_READ_ONLY_COMMANDS.has(lower)) {
    found.push(
      VALIDATOR_CHANGING_COMMANDS.has(lower)
        ? `${name} ${lower}`
        : `${name} (not a read-only form)`,
    )
    return
  }
  // after the subcommand only options and their values may follow
  let value = false
  for (const word of args.slice(i + 1)) {
    if (word.startsWith('-')) {
      value = !word.includes('=')
    } else if (value) {
      value = false
    } else {
      found.push(`${name} ${lower} with an operand`)
      return
    }
  }
}

/** systemctl: a verb that only reports, with options the gate can read. */
function analyzeSystemctl(args: string[], found: string[]): void {
  const read = readWrapper(SYSTEMCTL_OPTIONS, args)
  if (read.unreadable) {
    found.push('systemctl with an option the gate cannot read')
    return
  }
  const verb = read.rest[0]
  if (verb === undefined) return
  if (hasUnknownPart(verb)) {
    found.push('systemctl with a verb known only at run time')
  } else if (!SYSTEMCTL_READ_ONLY_VERBS.has(verb.toLowerCase())) {
    found.push(`systemctl ${verb.toLowerCase()}`)
  }
}

/** service: `service <name> status`, `--status-all` and `--version` only report. */
function analyzeService(args: string[], found: string[]): void {
  const read = readWrapper({
    flagShort: 'h',
    flagLong: ['--status-all', '--version', '--help'],
  }, args)
  if (read.unreadable) {
    found.push('service with an option the gate cannot read')
    return
  }
  if (read.rest.length === 0) return
  const verb = read.rest[1]
  if (verb === undefined) {
    found.push('service (not a read-only form)')
  } else if (hasUnknownPart(verb)) {
    found.push('service with a verb known only at run time')
  } else if (verb.toLowerCase() !== 'status') {
    found.push(`service ${verb.toLowerCase()}`)
  }
}

/** solana: the subcommands that ask the cluster; any other signs or changes. */
function analyzeSolana(args: string[], found: string[]): void {
  const read = readWrapper(SOLANA_OPTIONS, args)
  if (read.unreadable) {
    found.push('solana with an option the gate cannot read')
    return
  }
  const sub = read.rest[0]
  if (sub === undefined) return
  if (hasUnknownPart(sub)) {
    found.push('solana with a subcommand known only at run time')
    return
  }
  const lower = sub.toLowerCase()
  const second = read.rest[1]?.toLowerCase()
  if (lower === 'config' && second === 'get') return
  if (lower === 'feature' && second === 'status') return
  if (!SOLANA_READ_ONLY.has(lower)) found.push(`solana ${lower}`)
}

/** An interpreter is gated unless it is asked only for its version or help. */
function analyzeInterpreter(
  name: string,
  args: string[],
  found: string[],
): void {
  if (args.length > 0 && args.every((a) => INTERPRETER_VERSION_FLAGS.has(a))) {
    return
  }
  found.push(`${name} running code`)
}

function isInterpreter(name: string): boolean {
  return INTERPRETERS.has(name) ||
    INTERPRETERS.has(name.replace(/[0-9.]+$/, ''))
}

function analyzeDeno(args: string[], found: string[]): void {
  const first = args[0]?.toLowerCase()
  if (
    args.length > 0 &&
    (args.every((a) => INTERPRETER_VERSION_FLAGS.has(a)) ||
      (first !== undefined && DENO_READ_ONLY_COMMANDS.has(first)))
  ) {
    return
  }
  found.push('deno running code')
}

const AWK_FLAGS = new Set([
  '-n',
  '-b',
  '-c',
  '-N',
  '-P',
  '-r',
  '-s',
  '-S',
  '-t',
  '-g',
  '-O',
  '-C',
  '-M',
  '--traditional',
  '--posix',
  '--re-interval',
  '--characters-as-bytes',
  '--non-decimal-data',
  '--use-lc-numeric',
  '--optimize',
  '--lint',
])

/** awk and gawk: gated when the program runs a command or writes a file. */
function analyzeAwk(name: string, args: string[], found: string[]): void {
  let i = 0
  let sandbox = false
  while (i < args.length) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    if (a === '--version' || a === '-V' || a === '--help' || a === '-h') return
    if (a === '--sandbox' || a === '-S') {
      sandbox = true
      i++
    } else if (a === '-F' || a === '-v') {
      i += 2
    } else if (a.startsWith('-F') || a.startsWith('-v')) {
      i++
    } else if (AWK_FLAGS.has(a)) {
      i++
    } else {
      // -f, -e, -i, -l, -E and their long forms read code from elsewhere
      found.push(`${name} with an option the gate cannot read`)
      return
    }
  }
  const program = args[i]
  if (program === undefined || sandbox) return
  const risk = awkProgramRisk(program)
  if (risk !== null) found.push(`${name} ${risk}`)
}

/** An init script run by its path: only `status` reports. */
function analyzeInitScript(args: string[], found: string[]): void {
  if (args[0]?.toLowerCase() !== 'status') found.push('an init script')
}

/** crontab: only `crontab -l` lists; the other forms install, edit or remove. */
function analyzeCrontab(args: string[], found: string[]): void {
  let listed = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-l') listed = true
    else if (args[i] === '-u') i++
    else {
      found.push('crontab (it changes the commands the system runs)')
      return
    }
  }
  if (!listed) found.push('crontab (it changes the commands the system runs)')
}

/** sed is gated when its script has a command that runs a command or writes a file. */
function analyzeSed(args: string[], found: string[]): void {
  const scripts: string[] = []
  let sandbox = false
  let i = 0
  options: while (i < args.length) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    if (a === '--version' || a === '--help') return
    if (a === '--sandbox') {
      sandbox = true
      i++
    } else if (a === '--expression') {
      scripts.push(args[i + 1] ?? '')
      i += 2
    } else if (a.startsWith('--expression=')) {
      scripts.push(a.slice('--expression='.length))
      i++
    } else if (a === '--line-length') {
      i += 2
    } else if (
      [
        '--quiet',
        '--silent',
        '--regexp-extended',
        '--unbuffered',
        '--null-data',
        '--separate',
        '--binary',
        '--posix',
        '--debug',
        '--follow-symlinks',
        '--in-place',
        '--zero-terminated',
      ].includes(a) || a.startsWith('--in-place=') ||
      a.startsWith('--line-length=')
    ) {
      i++
    } else if (a.startsWith('--')) {
      found.push('sed with an option the gate cannot read')
      return
    } else {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]
        if ('nsErzubu'.includes(ch)) continue
        if (ch === 'i') break
        if (ch === 'e') {
          const attached = a.slice(k + 1)
          if (attached !== '') {
            scripts.push(attached)
            i++
          } else {
            scripts.push(args[i + 1] ?? '')
            i += 2
          }
          continue options
        }
        if (ch === 'l') {
          i += a.slice(k + 1) === '' ? 2 : 1
          continue options
        }
        found.push('sed with an option the gate cannot read')
        return
      }
      i++
    }
  }
  if (scripts.length === 0) {
    if (args[i] === undefined) return
    scripts.push(args[i])
  }
  if (sandbox) return
  for (const script of scripts) {
    const risk = sedScriptRisk(script)
    if (risk !== null) {
      found.push(`sed with ${risk}`)
      return
    }
  }
}

/** tmux and screen run commands in sessions that outlive the gate. */
function analyzeMultiplexer(
  name: string,
  args: string[],
  found: string[],
): void {
  if (name === 'screen') {
    if (args.length > 0 && args.every((a) => SCREEN_READ_ONLY_FLAGS.has(a))) {
      return
    }
    found.push('screen (it runs commands in a session)')
    return
  }
  const read = readWrapper({ argShort: 'LST', flagShort: '2luvV' }, args)
  const command = read.rest[0]?.toLowerCase()
  if (
    !read.unreadable &&
    (command === undefined
      ? args.length > 0 && args.every((a) => a === '-V')
      : TMUX_READ_ONLY_COMMANDS.has(command))
  ) {
    return
  }
  found.push('tmux (it runs commands in a session)')
}

/** at and batch run the commands they are given at a later time. */
function analyzeAt(
  name: string,
  args: string[],
  input: SimpleCommand | null,
  depth: number,
  found: string[],
): void {
  if (args.some((a) => a === '-l' || a === '-c' || a === '-V')) return
  if (args.some((a) => a === '-f' || a.startsWith('-f'))) {
    found.push(`${name} running a script file`)
    return
  }
  analyzeInput(name, input, depth, found)
}

/** Programs that run what they are given are left alone only for their version. */
function analyzeRunAnything(
  name: string,
  args: string[],
  found: string[],
): void {
  if (
    args.length > 0 &&
    args.every((a) => INTERPRETER_VERSION_FLAGS.has(a) || a === '--citation')
  ) {
    return
  }
  found.push(`${name} running commands`)
}

/**
 * The replacement string xargs puts a line of its input into: `-I str`,
 * `-Istr`, `-i[str]` and `--replace[=str]`.
 */
function xargsReplaceString(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-I') return args[i + 1] ?? '{}'
    if (a.startsWith('-I') && a.length > 2) return a.slice(2)
    if (a.startsWith('-i')) return a.length > 2 ? a.slice(2) : '{}'
    if (a === '--replace') return '{}'
    if (a.startsWith('--replace=')) return a.slice('--replace='.length)
  }
  return null
}

/**
 * The command xargs runs, as the shell sees it once the input is in: the
 * replacement string stands for text known at run time, and so does one more
 * argument, which xargs adds at the end.
 */
function xargsInner(rest: string[], args: string[]): string[] {
  const replace = xargsReplaceString(args)
  const mapped = replace === null || replace === ''
    ? rest
    : rest.map((w) => w.split(replace).join(RUNTIME))
  return [...mapped, RUNTIME]
}

/** The index of the command word of a simple command, or -1 when it has none. */
function commandStart(words: string[]): number {
  let i = 0
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i])) i++
    if (i >= words.length) return -1
    const w = words[i]
    if (w === 'time') {
      i++
      while (i < words.length && words[i].startsWith('-')) i++
    } else if (w === 'function') {
      i += 2
    } else if (w === 'coproc') {
      i += words[i + 1] !== undefined && words[i + 2] === '{' ? 2 : 1
    } else if (LEADING_WORDS.has(w)) {
      i++
    } else if (NON_COMMAND_WORDS.has(w)) {
      return -1
    } else {
      return i
    }
  }
}

function analyzeWords(
  words: string[],
  input: SimpleCommand | null,
  depth: number,
  found: string[],
): void {
  if (depth > MAX_NESTING) {
    found.push('a command line nested too deeply to read')
    return
  }
  const start = commandStart(words)
  if (start < 0) return
  const name = commandName(words[start])
  if (name === null) {
    found.push('a command named only when the shell runs')
    return
  }
  const args = words.slice(start + 1)
  if (
    (EVALUATING_BUILTINS.has(name) ||
      (name === 'printf' && args.includes('-v'))) &&
    args.some((a) => /\$\(|`/.test(a))
  ) {
    found.push(`${name} given a command substitution to evaluate`)
  }
  if (/\/(init|rc)\.d\//.test(words[start])) {
    analyzeInitScript(args, found)
  } else if (GATED_COMMANDS.has(name)) {
    found.push(name)
  } else if (VALIDATOR_BINARIES.has(name)) {
    analyzeValidatorBinary(name, args, found)
  } else if (name === 'systemctl') {
    analyzeSystemctl(args, found)
  } else if (name === 'service') {
    analyzeService(args, found)
  } else if (name === 'solana') {
    analyzeSolana(args, found)
  } else if (PROCESS_CONTROL.has(name)) {
    found.push(name)
  } else if (name === 'deno') {
    analyzeDeno(args, found)
  } else if (isInterpreter(name)) {
    analyzeInterpreter(name, args, found)
  } else if (AWK_NAMES.has(name)) {
    analyzeAwk(name, args, found)
  } else if (name === 'sed') {
    analyzeSed(args, found)
  } else if (name === 'crontab') {
    analyzeCrontab(args, found)
  } else if (name === 'tmux' || name === 'screen') {
    analyzeMultiplexer(name, args, found)
  } else if (name === 'at' || name === 'batch') {
    analyzeAt(name, args, input, depth, found)
  } else if (RUN_ANYTHING.has(name)) {
    analyzeRunAnything(name, args, found)
  } else if (name === 'rm') {
    analyzeRm(args, found)
  } else if (name === 'slv') {
    analyzeSlv(args, found)
  } else if (SHELLS.has(name)) {
    analyzeShell(name, args, input, depth, found)
  } else if (name === 'eval') {
    if (args.some((a) => a.includes(RUNTIME))) {
      found.push('eval of text known only at run time')
    } else {
      analyzeScript(args.join(' '), depth + 1, found)
    }
  } else if (name === 'source' || name === '.') {
    analyzeSource(name, args, input, depth, found)
  } else if (name === 'trap' || name === 'alias') {
    analyzeStoredCommands(name, args, depth, found)
  } else if (name === 'find') {
    analyzeFind(args, depth, found)
  } else if (Object.hasOwn(WRAPPERS, name)) {
    const spec = WRAPPERS[name]
    const read = readWrapper(spec, args)
    if (read.unreadable) {
      found.push(`${name} with an option the gate cannot read`)
    } else if (!read.lookup) {
      if (read.script !== undefined) {
        analyzeScript(read.script, depth + 1, found)
      }
      if (spec.restIsData) return
      if (read.shell || spec.restIsScript) {
        if (read.rest.length > 0) {
          analyzeScript(read.rest.join(' '), depth + 1, found)
        }
      } else if (read.rest.length > 0) {
        const inner = name === 'xargs' ? xargsInner(read.rest, args) : read.rest
        analyzeWords(inner, input, depth + 1, found)
      }
    }
  }
}

/**
 * A path in the words or the redirections that names key material. A word
 * that is relative to a directory an earlier `cd` of the line changed to is
 * read under that directory as well.
 */
function scanKeyMaterial(
  command: SimpleCommand,
  directory: string | null,
  found: string[],
): void {
  for (const word of [...command.words, ...command.redirects]) {
    let reason = keyMaterialInWord(word)
    if (reason === null && directory !== null && !/^[/~\u0000]/.test(word)) {
      reason = keyMaterialInWord(`${directory}/${word}`)
    }
    if (reason !== null) found.push(`a path naming ${reason}`)
  }
}

/**
 * The directory the commands after this one run in, as written: `cd` and
 * `pushd` set it, `popd` and a `cd` to the directory before forget it.
 */
function directoryAfter(
  command: SimpleCommand,
  directory: string | null,
): string | null {
  const start = commandStart(command.words)
  if (start < 0) return directory
  const name = commandName(command.words[start])
  if (name === 'popd') return null
  if (name !== 'cd' && name !== 'pushd') return directory
  const target = command.words.slice(start + 1).find((w) =>
    !w.startsWith('-') || w === '-'
  )
  if (target === undefined) return '~'
  if (target === '-') return RUNTIME
  if (/^[/~\u0000]/.test(target)) return target
  return directory === null ? null : `${directory}/${target}`
}

/** The base name of a token when it can stand for a program, in lower case. */
function programName(token: string): string | null {
  const slash = token.lastIndexOf('/')
  const name = token.slice(slash + 1).toLowerCase()
  if (name === '' || slash === -1) return name === '' ? null : name
  const dir = token.slice(0, slash)
  return dir === '' || dir === '.' || /(^|\/)(s?bin|libexec)$/.test(dir)
    ? name
    : null
}

/**
 * Names in a stream of tokens: a program that is gated whatever its
 * arguments, `slv` followed by a verb that changes a node, and a program that
 * is gated for the verb it is given.
 */
function scanTokenStream(tokens: string[], found: string[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const name = programName(tokens[i])
    if (name === null) continue
    if (GATED_COMMANDS.has(name)) {
      found.push(name)
    } else if (name === 'slv') {
      analyzeSlv(tokens.slice(i + 1), found)
    } else if (name === 'rm') {
      analyzeRm(tokens.slice(i + 1), found)
    } else if (name === 'systemctl' || name === 'service') {
      const verb = tokens.slice(i + 1).find((t) =>
        STATE_VERBS.has(t.toLowerCase())
      )
      if (verb !== undefined) found.push(`${name} ${verb.toLowerCase()}`)
    } else if (name === 'solana') {
      const sub = tokens.slice(i + 1).find((t) =>
        SOLANA_CHANGING.has(t.toLowerCase())
      )
      if (sub !== undefined) found.push(`solana ${sub.toLowerCase()}`)
    } else if (VALIDATOR_BINARIES.has(name)) {
      const sub = tokens.slice(i + 1).find((t) =>
        VALIDATOR_CHANGING_COMMANDS.has(t.toLowerCase())
      )
      if (sub !== undefined) found.push(`${name} ${sub.toLowerCase()}`)
    } else if (isInterpreter(name) || name === 'deno') {
      const code = tokens.slice(i + 1).some((t) =>
        CODE_FLAGS.has(t) || SCRIPT_NAME.test(t)
      )
      if (code) found.push(`${name} running code`)
    } else if (SHELLS.has(name)) {
      // `-c` is left to the reading of the script; a script file is not read
      if (tokens.slice(i + 1).some((t) => SCRIPT_NAME.test(t))) {
        found.push(`${name} running a script file`)
      }
    }
  }
}

/**
 * The backstop for programs the gate does not know to run their arguments:
 * the words of a command are split into tokens at whitespace and shell
 * metacharacters, not at `/`, `.` or `-`, and the tokens are read for names.
 * A second pass reads the words with their quotes and backslashes removed, as
 * a shell would read text it runs again. `which`, `type`, `hash` and
 * `command -v` only look names up and are left out.
 */
function scanTokens(command: SimpleCommand, found: string[]): void {
  const start = commandStart(command.words)
  if (start >= 0) {
    const name = commandName(command.words[start])
    if (name !== null) {
      if (LOOKUP_COMMANDS.has(name)) return
      if (
        name === 'command' &&
        readWrapper(WRAPPERS.command, command.words.slice(start + 1)).lookup
      ) return
    }
  }
  for (const strip of [false, true]) {
    const tokens: string[] = []
    for (const word of command.words) {
      const text = strip ? word.replace(/["'\\]/g, '') : word
      for (const token of text.split(TOKEN_SEPARATORS)) {
        if (token !== '') tokens.push(token)
      }
    }
    scanTokenStream(tokens, found)
  }
}

function analyzeScript(src: string, depth: number, found: string[]): void {
  if (depth > MAX_NESTING) {
    found.push('a command line nested too deeply to read')
    return
  }
  const st: ParseState = {
    src,
    pos: 0,
    commands: [],
    unparsable: false,
    notes: { substitution: false, promptExpansion: false },
  }
  parseList(st, null, 0)
  if (st.unparsable) found.push('a command line the gate cannot parse')
  if (st.notes.substitution) {
    found.push('a command substitution or a backquote')
  }
  if (st.notes.promptExpansion) found.push('a ${...@P} expansion')
  let directory: string | null = null
  for (const command of st.commands) {
    analyzeWords(command.words, command, depth, found)
    scanKeyMaterial(command, directory, found)
    scanTokens(command, found)
    directory = directoryAfter(command, directory)
  }
}

/** Does this command line run a command of a gated class? */
export function classifyCommand(command: string): CommandClassification {
  const found: string[] = []
  try {
    analyzeScript(command, 0, found)
  } catch {
    // a failure of the reader never lets a line through
    found.push('a command line the gate cannot read')
  }
  const reasons = [...new Set(found)]
  return { gated: reasons.length > 0, reasons }
}

export type CommandGateDecision = 'run' | 'confirm' | 'refuse'

/**
 * A gated class always needs a person to confirm at a terminal. Other
 * commands run on their own only when auto-execute is on. Where a person is
 * needed and no terminal is attached, the command is refused.
 */
export function decideCommandGate(
  input: { gated: boolean; autoExecute: boolean; hasTerminal: boolean },
): CommandGateDecision {
  if (input.gated || !input.autoExecute) {
    return input.hasTerminal ? 'confirm' : 'refuse'
  }
  return 'run'
}

/** What run_command returns for a command it refuses without a terminal. */
export function describeRefusal(
  command: string,
  classification: CommandClassification,
): string {
  const why = classification.gated
    ? `it may change nodes or keys, touch credentials or run another command (${
      classification.reasons.join(', ')
    }), and that needs a person to confirm it in a terminal`
    : `commands here need a person to confirm them in a terminal while auto-execute is off`
  const how = classification.gated
    ? ''
    : ` To let a session without a terminal run commands that do not change nodes or keys, the operator sets \`auto_execute: true\` in ~/.slv/agent/config.yml. ${AUTO_EXECUTE_NOTE}`
  return `Command not run: ${why}, and no terminal is attached to this session.\n\n` +
    `Command: ${command}\n\n` +
    `Do not retry it or rewrite it into another form. Tell the user the exact command and ask them to run it themselves in a terminal.${how}`
}
