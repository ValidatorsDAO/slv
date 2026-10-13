// ps can print the environment of processes: the `e` modifier of its BSD
// syntax, and an output format named environ. That is the environment of a
// process, which the key-material classes (keyMaterial.ts) keep from the
// console when it is read from /proc. The arguments of ps are read here the
// way ps reads them, and a command that prints an environment, or may, is
// held.
//
// ps reads its command line in up to two passes (procps-ng, ps/parser.c).
// The first pass takes a word that starts with a letter for BSD options
// (`aux`, `auxe`), a word that starts with a dash and a letter for UNIX
// options (`-ef`, `-eo pid,cmd`, where `-e` selects every process), and a word
// that starts with two dashes for a GNU long option. When anything in the
// first pass fails, such as a UNIX option that does not exist, a missing
// value, or two format options that conflict, ps reads every word again as
// BSD options with the dashes ignored. In that second pass a word that starts
// with a letter is an error, and `-e` is the BSD `e`: the environment. So
// `ps -xe`, `ps -ef -o pid,cmd` and `ps -e -g` print the environment, and
// `ps -ef` and `ps -eo pid,cmd` do not.

import { PATTERN, RUNTIME } from '@/ai/console/keyMaterial.ts'

const letter = (c: string | undefined): boolean =>
  c !== undefined && /^[A-Za-z]$/.test(c)
const digit = (c: string | undefined): boolean =>
  c !== undefined && /^[0-9]$/.test(c)

const unknown = (word: string): boolean =>
  word.includes(RUNTIME) || word.includes(PATTERN)

type Kind = 'gnu' | 'unix' | 'bsd' | 'pid' | 'end' | 'fail'

/** How ps takes a word of its command line. */
function kindOf(word: string): Kind {
  const first = word[0]
  if (letter(first)) return 'bsd'
  if (digit(first) || first === '+') return 'pid'
  if (first !== '-') return 'fail'
  const second = word[1]
  if (letter(second)) return 'unix'
  if (digit(second)) return 'pid'
  if (second !== '-') return 'fail'
  const third = word[2]
  if (third === undefined) return 'end'
  return letter(third) ? 'gnu' : 'fail'
}

// UNIX options that take a value: the rest of the word, or the next word
const UNIX_VALUE = 'CDGOUgopqstu'
// BSD options without a value
const BSD_FLAGS = 'HMSTXZacefghjlmnrsuvwx'
// BSD options that take a value: the rest of the word, or the next word
const BSD_VALUE = 'OUkopq'

// the GNU long options of ps that take a value, and those that do not
const GNU_VALUE = [
  'Group',
  'User',
  'cols',
  'columns',
  'date-format',
  'format',
  'group',
  'lines',
  'pid',
  'ppid',
  'quick-pid',
  'rows',
  'sid',
  'sort',
  'tty',
  'user',
  'width',
]
const GNU_FLAG = [
  'context',
  'cumulative',
  'deselect',
  'forest',
  'header',
  'headers',
  'heading',
  'headings',
  'help',
  'info',
  'no-header',
  'no-headers',
  'no-heading',
  'no-headings',
  'noheader',
  'noheaders',
  'noheading',
  'noheadings',
  'signames',
  'version',
]

/** The name of a GNU long option word, and whether the value is in the word. */
function gnuName(word: string): { name: string; attached: boolean } {
  const rest = word.slice(2)
  const at = rest.search(/[:=]/)
  return at === -1
    ? { name: rest, attached: false }
    : { name: rest.slice(0, at), attached: true }
}

/** The value of an option as ps takes it: the rest of the word or the next. */
function takeValue(
  rest: string,
  args: string[],
  at: number,
): { value: string | null; used: boolean } {
  if (rest !== '') return { value: rest, used: false }
  const next = args[at + 1]
  return next === undefined || next === ''
    ? { value: null, used: false }
    : { value: next, used: true }
}

const UNKNOWN_WORD = 'ps with an argument known only when the shell runs'
const BSD_E = 'which prints the environment'
const MAY_BE_BSD = 'which ps may read as BSD options with an e'

/**
 * The first pass over the words, as far as it shows an environment on its own:
 * a BSD option word with an `e`, and a word that is only known at run time.
 */
function firstPass(args: string[]): string | null {
  // a word that the shell expands can be several words, and any of them
  if (args.some(unknown)) return UNKNOWN_WORD
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    switch (kindOf(word)) {
      case 'gnu': {
        const { name, attached } = gnuName(word)
        if (!attached && GNU_VALUE.includes(name) && args[i + 1] !== '') i++
        break
      }
      case 'unix': {
        for (let k = 1; k < word.length; k++) {
          const ch = word[k]
          if (ch === 'E') return `ps ${word}, ${BSD_E}`
          if (UNIX_VALUE.includes(ch)) {
            if (takeValue(word.slice(k + 1), args, i).used) i++
            break
          }
        }
        break
      }
      case 'bsd': {
        for (let k = 0; k < word.length; k++) {
          const ch = word[k]
          if (ch === 'e' || ch === 'E') return `ps ${word}, ${BSD_E}`
          if (digit(ch)) break
          if (BSD_VALUE.includes(ch) || ch === 't') {
            if (takeValue(word.slice(k + 1), args, i).used) i++
            break
          }
        }
        break
      }
    }
  }
  return null
}

/**
 * The second pass: every word read as BSD options. It fails on a word that
 * starts with a letter, and on a letter that is not a BSD option. `seesE`
 * says that an `e` was read as an option.
 */
function secondPass(args: string[]): { ok: boolean; seesE: boolean } {
  let ok = true
  let seesE = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    switch (kindOf(word)) {
      case 'gnu': {
        const { name, attached } = gnuName(word)
        if (!attached && GNU_VALUE.includes(name) && args[i + 1] !== '') i++
        break
      }
      case 'unix': {
        for (let k = 1; k < word.length; k++) {
          const ch = word[k]
          if (digit(ch)) break
          if (ch === 'e' || ch === 'E') seesE = true
          else if (BSD_FLAGS.includes(ch)) continue
          else if (BSD_VALUE.includes(ch) || ch === 't') {
            const taken = takeValue(word.slice(k + 1), args, i)
            if (taken.value === null && ch !== 't') ok = false
            if (taken.used) i++
            break
          } else {
            ok = false
            break
          }
        }
        break
      }
      case 'pid':
        break
      default:
        // a word that starts with a letter, `--`, or a word ps cannot take
        ok = false
    }
  }
  return { ok, seesE }
}

/**
 * Do the words form a command line that the first pass of ps takes without
 * an error, whatever the host has? Only then is an `e` the UNIX `-e`.
 */
function firstPassSucceeds(args: string[]): boolean {
  // -f, -F and -l each pick a format, and so does --context; a format of
  // one's own (-o, --format) does not go with any of them
  let formatFlag = false
  let contextFormat = false
  let userFormat = false
  let threads = 0
  let forest = false
  let sorted = false
  const list = /^[^ ,\t]+([ ,\t][^ ,\t]+)*$/
  const pids = /^[1-9][0-9]{0,8}([ ,\t][1-9][0-9]{0,8})*$/
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    const kind = kindOf(word)
    if (kind === 'gnu') {
      const { name, attached } = gnuName(word)
      if (name === 'forest') forest = true
      else if (name === 'format') userFormat = true
      else if (name === 'context') contextFormat = true
      else if (name === 'sort') sorted = true
      else if (!GNU_FLAG.includes(name) && !GNU_VALUE.includes(name)) {
        return false
      }
      if (!attached && GNU_VALUE.includes(name)) {
        if (args[i + 1] === undefined || args[i + 1] === '') return false
        i++
      }
    } else if (kind === 'unix') {
      for (let k = 1; k < word.length; k++) {
        const ch = word[k]
        if (ch === 'o' || ch === 'p' || ch === 'C') {
          const taken = takeValue(word.slice(k + 1), args, i)
          if (taken.value === null) return false
          if (ch === 'p' && !pids.test(taken.value)) return false
          if (ch === 'C' && !list.test(taken.value)) return false
          if (ch === 'o') userFormat = true
          if (taken.used) i++
          break
        }
        if ('fFl'.includes(ch)) formatFlag = true
        else if (ch === 'H') forest = true
        else if (ch === 'L' || ch === 'T') threads++
        else if (!'Aadew'.includes(ch)) return false
      }
    } else {
      return false
    }
  }
  if ((formatFlag || contextFormat) && userFormat) return false
  if (formatFlag && contextFormat) return false
  if (threads > 1) return false
  if (threads > 0 && (forest || sorted)) return false
  return true
}

/**
 * Why a ps command line prints the environment of processes, or may do so,
 * or null: an output format that names environ, a BSD option word with an
 * `e`, a command line that ps may read again as BSD options with an `e`, or a
 * word that is only known when the shell runs.
 */
export function psEnvironmentReason(args: string[]): string | null {
  const named = args.find((arg) => arg.toLowerCase().includes('environ'))
  if (named !== undefined) {
    return `ps with an output format named environ (${named})`
  }
  const first = firstPass(args)
  if (first !== null) return first
  const second = secondPass(args)
  if (second.ok && second.seesE && !firstPassSucceeds(args)) {
    return `ps ${args.join(' ')}, ${MAY_BE_BSD}`
  }
  return null
}
