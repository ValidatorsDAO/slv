// ---------------------------------------------------------------------------
// Commands that need a person at a terminal
//
// `classifyCommand` reads a shell command line and reports whether it runs a
// command of a gated class: ansible-playbook, the slv verbs that change nodes
// or keys, ssh/scp/rsync, solana-keygen, op, and rm with -r or -f. A gated
// command always needs a confirmation in a terminal. A line the reader cannot
// parse, or whose command is only known when the shell runs, counts as gated.
// ---------------------------------------------------------------------------

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
  hereDocs: string[]
  hereStrings: string[]
}

type ParseState = {
  src: string
  pos: number
  commands: SimpleCommand[]
  unparsable: boolean
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
      if (level === 0) return
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
  let cur: SimpleCommand = { words: [], hereDocs: [], hereStrings: [] }
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
    } else if (redirect === null) {
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
    if (cur.words.length > 0) st.commands.push(cur)
    cur = { words: [], hereDocs: [], hereStrings: [] }
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
  'sshpass',
  'mosh',
  'autossh',
  'solana-keygen',
  'agave-keygen',
  'op',
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
  },
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
    if (!a.startsWith('-') || a === '-') break
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
  let rest = args.slice(i)
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
    // a script file is not read here, unless only the shell knows its name
    if (operand.includes(RUNTIME)) {
      found.push(`${name} running a script named only when the shell runs`)
    }
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
  let i = 0
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i])) i++
    if (i >= words.length) return
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
      return
    } else {
      break
    }
  }
  const name = commandName(words[i])
  if (name === null) {
    found.push('a command named only when the shell runs')
    return
  }
  const args = words.slice(i + 1)
  if (GATED_COMMANDS.has(name)) {
    found.push(name)
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
        analyzeWords(read.rest, input, depth + 1, found)
      }
    }
  }
}

function analyzeScript(src: string, depth: number, found: string[]): void {
  if (depth > MAX_NESTING) {
    found.push('a command line nested too deeply to read')
    return
  }
  const st: ParseState = { src, pos: 0, commands: [], unparsable: false }
  parseList(st, null, 0)
  if (st.unparsable) found.push('a command line the gate cannot parse')
  for (const command of st.commands) {
    analyzeWords(command.words, command, depth, found)
  }
}

/** Does this command line run a command of a gated class? */
export function classifyCommand(command: string): CommandClassification {
  const found: string[] = []
  analyzeScript(command, 0, found)
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
    ? `it is in a class of commands that change nodes or keys or touch credentials (${
      classification.reasons.join(', ')
    }), and those need a person to confirm them in a terminal`
    : `commands here need a person to confirm them in a terminal while auto-execute is off`
  const how = classification.gated
    ? ''
    : ' To let a session without a terminal run commands that do not change nodes or keys, the operator sets `auto_execute: true` in ~/.slv/agent/config.yml.'
  return `Command not run: ${why}, and no terminal is attached to this session.\n\n` +
    `Command: ${command}\n\n` +
    `Do not retry it or rewrite it into another form. Tell the user the exact command and ask them to run it themselves in a terminal.${how}`
}
