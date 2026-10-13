// Programs that read the files of a whole directory tree. The key-material
// classes (keyMaterial.ts) match the text of a path, so a recursive search of a
// directory that holds a class reads the files in it without naming one. A
// recursive reader is held back when an operand is, or may be, such a
// directory: a home directory or one of its ancestors, anything under a .slv or
// .ssh directory, /proc, a relative path, a path the shell expands, or no
// operand at all (the working directory).

import { ownHomes, PATTERN, RUNTIME } from '@/ai/console/keyMaterial.ts'

/** The programs `recursiveReadReason` reads. */
export const RECURSIVE_READERS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rgrep',
  'rg',
  'diff',
])

type OptionSpec = {
  /** short options without a value */
  flagShort: string
  /** short options whose value is the rest of the word or the next word */
  valueShort: string
  /** long options without a value */
  flagLong: readonly string[]
  /** long options whose value follows after `=` or as the next word */
  valueLong: readonly string[]
  /** long options whose value, if any, follows after `=` */
  optionalLong: readonly string[]
  /** `-5` stands for `-C 5` */
  digits: boolean
  /** the start of a long option stands for it when nothing else starts so */
  abbreviations: boolean
  /** `--no-NAME` stands for the option NAME, without a value */
  negations: boolean
}

type ReadOption = {
  /** The options the word can stand for; more than one when it is ambiguous. */
  names: string[]
  value: string | null
}

type ReadArguments = {
  options: ReadOption[]
  operands: string[]
  /** An option the table does not list was given. */
  unreadable: boolean
}

function readArguments(args: string[], spec: OptionSpec): ReadArguments {
  const options: ReadOption[] = []
  const operands: string[] = []
  let unreadable = false
  let ended = false
  const longNames = [
    ...spec.flagLong,
    ...spec.valueLong,
    ...spec.optionalLong,
  ]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (ended) {
      operands.push(arg)
    } else if (arg === '--') {
      ended = true
    } else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const given = arg.slice(2, equals === -1 ? undefined : equals)
      const attached = equals === -1 ? null : arg.slice(equals + 1)
      let names = longNames.filter((name) => name === given)
      if (names.length === 0 && spec.negations && given.startsWith('no-')) {
        const negated = given.slice(3)
        if (longNames.includes(negated)) {
          options.push({ names: [given], value: null })
          continue
        }
      }
      if (names.length === 0 && spec.abbreviations && given !== '') {
        names = longNames.filter((name) => name.startsWith(given))
      }
      if (names.length === 0) {
        unreadable = true
        continue
      }
      let value = attached
      if (value === null && names.some((n) => spec.valueLong.includes(n))) {
        value = args[++i] ?? null
      }
      options.push({ names, value })
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const ch = arg[k]
        if (spec.digits && ch >= '0' && ch <= '9') continue
        if (spec.valueShort.includes(ch)) {
          const rest = arg.slice(k + 1)
          options.push({
            names: [ch],
            value: rest !== '' ? rest : args[++i] ?? null,
          })
          break
        }
        if (spec.flagShort.includes(ch)) {
          options.push({ names: [ch], value: null })
          continue
        }
        unreadable = true
        break
      }
    } else {
      operands.push(arg)
    }
  }
  return { options, operands, unreadable }
}

const GREP_SPEC: OptionSpec = {
  flagShort: 'EFGPiwxzsvVbnHhoqaIrRLlcTZUuy',
  valueShort: 'efmABCDd',
  flagLong: [
    'extended-regexp',
    'fixed-strings',
    'basic-regexp',
    'perl-regexp',
    'ignore-case',
    'no-ignore-case',
    'word-regexp',
    'line-regexp',
    'null-data',
    'no-messages',
    'invert-match',
    'version',
    'help',
    'byte-offset',
    'line-number',
    'line-buffered',
    'with-filename',
    'no-filename',
    'only-matching',
    'quiet',
    'silent',
    'text',
    'recursive',
    'dereference-recursive',
    'files-without-match',
    'files-with-matches',
    'count',
    'initial-tab',
    'null',
    'no-group-separator',
    'binary',
    'unix-byte-offsets',
  ],
  valueLong: [
    'regexp',
    'file',
    'max-count',
    'label',
    'binary-files',
    'directories',
    'devices',
    'include',
    'exclude',
    'exclude-from',
    'exclude-dir',
    'before-context',
    'after-context',
    'context',
    'group-separator',
  ],
  optionalLong: ['color', 'colour'],
  digits: true,
  abbreviations: true,
  negations: false,
}

const RG_SPEC: OptionSpec = {
  flagShort: '.FHILNPSUVabchilnopqsuvwxz0',
  valueShort: 'ABCEMTdefgjmrt',
  flagLong: [
    'auto-hybrid-regex',
    'binary',
    'block-buffered',
    'byte-offset',
    'case-sensitive',
    'column',
    'count',
    'count-matches',
    'crlf',
    'debug',
    'files',
    'files-with-matches',
    'files-without-match',
    'fixed-strings',
    'follow',
    'glob-case-insensitive',
    'heading',
    'help',
    'hidden',
    'ignore-case',
    'ignore-file-case-insensitive',
    'include-zero',
    'invert-match',
    'json',
    'line-buffered',
    'line-number',
    'line-regexp',
    'max-columns-preview',
    'mmap',
    'multiline',
    'multiline-dotall',
    'no-config',
    'no-filename',
    'no-ignore',
    'no-ignore-dot',
    'no-ignore-exclude',
    'no-ignore-files',
    'no-ignore-global',
    'no-ignore-messages',
    'no-ignore-parent',
    'no-ignore-vcs',
    'no-line-number',
    'no-messages',
    'no-pcre2-unicode',
    'no-require-git',
    'no-unicode',
    'null',
    'null-data',
    'one-file-system',
    'only-matching',
    'passthru',
    'pcre2',
    'pcre2-version',
    'pretty',
    'quiet',
    'search-zip',
    'smart-case',
    'sort-files',
    'stats',
    'stop-on-nonmatch',
    'text',
    'trace',
    'trim',
    'type-list',
    'unrestricted',
    'version',
    'vimgrep',
    'with-filename',
    'word-regexp',
  ],
  valueLong: [
    'after-context',
    'before-context',
    'color',
    'colors',
    'context',
    'context-separator',
    'dfa-size-limit',
    'encoding',
    'engine',
    'field-context-separator',
    'field-match-separator',
    'file',
    'generate',
    'glob',
    'hostname-bin',
    'hyperlink-format',
    'iglob',
    'ignore-file',
    'max-columns',
    'max-count',
    'max-depth',
    'max-filesize',
    'path-separator',
    'pre',
    'pre-glob',
    'regex-size-limit',
    'regexp',
    'replace',
    'sort',
    'sortr',
    'threads',
    'type',
    'type-add',
    'type-clear',
    'type-not',
  ],
  optionalLong: [],
  digits: false,
  abbreviations: false,
  negations: true,
}

const DIFF_SPEC: OptionSpec = {
  flagShort: 'qsceunyptTlrRNiEZbwBadvH',
  valueShort: 'CUWFxXSIDL',
  flagLong: [
    'normal',
    'brief',
    'report-identical-files',
    'ed',
    'rcs',
    'side-by-side',
    'left-column',
    'suppress-common-lines',
    'show-c-function',
    'expand-tabs',
    'initial-tab',
    'suppress-blank-empty',
    'paginate',
    'recursive',
    'no-dereference',
    'new-file',
    'unidirectional-new-file',
    'ignore-file-name-case',
    'no-ignore-file-name-case',
    'ignore-case',
    'ignore-tab-expansion',
    'ignore-trailing-space',
    'ignore-space-change',
    'ignore-all-space',
    'ignore-blank-lines',
    'text',
    'strip-trailing-cr',
    'minimal',
    'speed-large-files',
    'help',
    'version',
  ],
  valueLong: [
    'width',
    'show-function-line',
    'label',
    'tabsize',
    'exclude',
    'exclude-from',
    'starting-file',
    'from-file',
    'to-file',
    'ignore-matching-lines',
    'ifdef',
    'line-format',
    'old-line-format',
    'new-line-format',
    'unchanged-line-format',
    'old-group-format',
    'new-group-format',
    'unchanged-group-format',
    'changed-group-format',
    'horizon-lines',
    'palette',
  ],
  optionalLong: ['context', 'unified', 'color'],
  digits: true,
  abbreviations: true,
  negations: false,
}

/** A word as it is shown to a person: the reader's placeholders written out. */
function shown(word: string): string {
  const text = word.split(PATTERN).join('*').split(RUNTIME).join('$...')
  return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

const HOLDS = 'key material or credentials'
const MAY_HOLD = `may hold ${HOLDS}`

/**
 * Why a directory operand is, or may be, a directory that holds a refused
 * class, or null for a literal absolute path elsewhere.
 */
function directoryReason(operand: string): string | null {
  if (operand.includes(RUNTIME) || operand.includes(PATTERN)) {
    return `is known only when the shell runs and ${MAY_HOLD}`
  }
  let path = operand
  if (path.startsWith('~')) {
    const tilde = /^~([^/]*)([\s\S]*)$/.exec(path)
    if (tilde === null || tilde[1] === '+' || tilde[1] === '-') {
      return `is relative to a directory the gate does not know and ${MAY_HOLD}`
    }
    // a home directory, as /home/NAME
    path = `/home/~${tilde[1]}${tilde[2]}`
  }
  if (!path.startsWith('/')) {
    return `is relative to a directory the gate does not know and ${MAY_HOLD}`
  }
  const written = path.toLowerCase().split('/').filter((part) => part !== '')
  if (written.some((part) => part === '.slv' || part === '.ssh')) {
    return 'is, or is inside, a .slv or .ssh directory, which holds keys and credentials'
  }
  const parts: string[] = []
  for (const part of written) {
    if (part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  if (parts.length === 0) {
    return 'is the root directory and holds every home directory'
  }
  const [first, second] = parts
  if (parts.length === 1 && (first === 'home' || first === 'users')) {
    return 'holds the home directories'
  }
  if (parts.length === 1 && first === 'root') {
    return 'is a home directory and holds its .slv and .ssh'
  }
  if (parts.length === 2 && (first === 'home' || first === 'users')) {
    return 'is a home directory and holds its .slv and .ssh'
  }
  if (
    first === 'proc' &&
    (parts.length === 1 || /^(self|thread-self|\d+)$/.test(second))
  ) {
    return 'holds the environment of a process, which may hold credentials'
  }
  for (const home of ownHomes()) {
    const own = home.toLowerCase().split('/').filter((part) => part !== '')
    if (parts.length <= own.length && parts.every((p, i) => p === own[i])) {
      return 'is or holds your home directory'
    }
  }
  return null
}

/** Why the operands of a recursive search may hold a refused class, or null. */
function operandsReason(name: string, operands: string[]): string | null {
  if (operands.length === 0) {
    return `a recursive ${name} of the working directory, which ${MAY_HOLD}`
  }
  for (const operand of operands) {
    const why = directoryReason(operand)
    if (why !== null) {
      return `a recursive ${name} of ${shown(operand)}, which ${why}`
    }
  }
  return null
}

function grepReason(name: string, args: string[]): string | null {
  const read = readArguments(args, GREP_SPEC)
  if (read.unreadable) {
    return `${name} with an option the gate cannot read, which may search a directory that holds ${HOLDS}`
  }
  let recursive = name === 'rgrep'
  let patternGiven = false
  for (const option of read.options) {
    const is = (...names: string[]) =>
      option.names.some((n) => names.includes(n))
    if (is('r', 'R', 'recursive', 'dereference-recursive')) recursive = true
    if (is('e', 'f', 'regexp', 'file')) patternGiven = true
    if (
      is('d', 'directories') && option.value !== null && option.value !== '' &&
      'recurse'.startsWith(option.value)
    ) recursive = true
  }
  if (!recursive) return null
  return operandsReason(
    name,
    patternGiven ? read.operands : read.operands.slice(1),
  )
}

// the modes of rg that list names or print text, and search nothing
const RG_NO_SEARCH = [
  'files',
  'type-list',
  'help',
  'h',
  'version',
  'V',
  'pcre2-version',
  'generate',
]

function rgReason(args: string[]): string | null {
  const read = readArguments(args, RG_SPEC)
  if (read.unreadable) {
    return `rg with an option the gate cannot read, which may search a directory that holds ${HOLDS}`
  }
  let patternGiven = false
  for (const option of read.options) {
    if (option.names.some((n) => RG_NO_SEARCH.includes(n))) return null
    if (option.names.some((n) => ['e', 'f', 'regexp', 'file'].includes(n))) {
      patternGiven = true
    }
  }
  return operandsReason(
    'rg',
    patternGiven ? read.operands : read.operands.slice(1),
  )
}

function diffReason(args: string[]): string | null {
  const read = readArguments(args, DIFF_SPEC)
  if (read.unreadable) {
    return `diff with an option the gate cannot read, which may compare a directory that holds ${HOLDS}`
  }
  const recursive = read.options.some((option) =>
    option.names.some((n) => ['r', 'R', 'recursive'].includes(n))
  )
  return recursive ? operandsReason('diff', read.operands) : null
}

/**
 * Why a recursive reader, given these arguments, may read key material or
 * credentials without naming a file of a class, or null.
 */
export function recursiveReadReason(
  name: string,
  args: string[],
): string | null {
  if (name === 'rg') return rgReason(args)
  if (name === 'diff') return diffReason(args)
  if (RECURSIVE_READERS.has(name)) return grepReason(name, args)
  return null
}
