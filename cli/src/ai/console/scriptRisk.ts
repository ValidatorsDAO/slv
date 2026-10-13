// Readers for the two small languages that a command line can carry in one
// word: an awk program and a sed script. Each says why the text runs a command
// or writes a file, or null when it does neither. A text the reader cannot
// follow counts as one that does.

/** The text of an awk program without its comments and string literals. */
function awkCode(program: string): string {
  let out = ''
  for (let i = 0; i < program.length; i++) {
    const c = program[i]
    if (c === '"') {
      i++
      while (i < program.length && program[i] !== '"' && program[i] !== '\n') {
        if (program[i] === '\\') i++
        i++
      }
      out += '""'
    } else if (c === '#') {
      while (i < program.length && program[i] !== '\n') i++
      out += '\n'
    } else {
      out += c
    }
  }
  return out
}

/** Why an awk program runs a command or writes a file, or null. */
export function awkProgramRisk(program: string): string | null {
  const code = awkCode(program)
  if (/\bsystem\s*\(/.test(code)) return 'calling system()'
  if (/\|&?\s*getline\b/.test(code)) return 'reading a command with getline'
  if (/@(include|load|namespace)\b/.test(code)) return 'loading code'
  for (const print of code.matchAll(/\bprintf?\b/g)) {
    let depth = 0
    for (let i = print.index + print[0].length; i < code.length; i++) {
      const c = code[i]
      if (c === '(' || c === '[') depth++
      else if (c === ')' || c === ']') depth--
      else if (depth <= 0 && (c === ';' || c === '}' || c === '\n')) break
      else if (depth <= 0 && (c === '>' || c === '|')) {
        return 'redirecting or piping the output of print'
      }
    }
  }
  return null
}

/** The index after the `]` that closes a bracket expression, or -1. */
function sedBracketEnd(script: string, from: number): number {
  let i = from
  if (script[i] === '^') i++
  if (script[i] === ']') i++
  while (i < script.length) {
    const c = script[i]
    if (c === '[' && ':.='.includes(script[i + 1] ?? '')) {
      const close = script.indexOf(`${script[i + 1]}]`, i + 2)
      if (close === -1) return -1
      i = close + 2
    } else if (c === ']') {
      return i + 1
    } else {
      i++
    }
  }
  return -1
}

/**
 * The index after the `delim` that closes a part of a sed command, or -1. A
 * bracket expression in a regular expression may hold the delimiter, and a
 * newline ends the command unless a backslash is in front of it.
 */
function sedPartEnd(
  script: string,
  from: number,
  delim: string,
  regex: boolean,
): number {
  for (let i = from; i < script.length; i++) {
    const c = script[i]
    if (c === '\\') {
      i++
    } else if (c === delim) {
      return i + 1
    } else if (c === '\n') {
      return -1
    } else if (c === '[' && regex) {
      const end = sedBracketEnd(script, i + 1)
      if (end !== -1) i = end - 1
    }
  }
  return -1
}

/** The index of the end of the line, a backslash before a newline continues it. */
function sedLineEnd(script: string, from: number): number {
  let i = from
  while (i < script.length && script[i] !== '\n') {
    if (script[i] === '\\') i++
    i++
  }
  return i
}

/**
 * Why a sed script runs a command or writes a file, or null: the `e` command,
 * the `e` and `w` flags of `s`, and the `w` and `W` commands. A script the
 * reader cannot follow counts as one that does.
 */
export function sedScriptRisk(script: string): string | null {
  const unreadable = 'a script the gate cannot read'
  const n = script.length
  let i = 0
  const digits = (): void => {
    while (i < n && script[i] >= '0' && script[i] <= '9') i++
  }
  // one address: a line number, `$`, `first~step` or a regular expression
  const address = (): boolean => {
    const c = script[i]
    if (c === '$') {
      i++
      return true
    }
    if (c >= '0' && c <= '9') {
      digits()
      if (script[i] === '~') {
        i++
        digits()
      }
      return true
    }
    if (c === '/' || c === '\\') {
      const delim = c === '\\' ? script[i + 1] : '/'
      if (delim === undefined || delim === '\n') return false
      const end = sedPartEnd(script, i + (c === '\\' ? 2 : 1), delim, true)
      if (end === -1) return false
      i = end
      while (script[i] === 'I' || script[i] === 'M') i++
      return true
    }
    return false
  }
  for (;;) {
    while (i < n && /[\s;{}]/.test(script[i])) i++
    if (i >= n) return null
    if (address()) {
      if (script[i] === ',') {
        i++
        if (script[i] === '+' || script[i] === '~') {
          i++
          digits()
        } else if (!address()) return unreadable
      }
    }
    while (i < n && (script[i] === ' ' || script[i] === '!')) i++
    const command = script[i++]
    switch (command) {
      case 's': {
        const delim = script[i]
        if (delim === undefined || delim === '\n' || delim === '\\') {
          return unreadable
        }
        let end = sedPartEnd(script, i + 1, delim, true)
        if (end !== -1) end = sedPartEnd(script, end, delim, false)
        if (end === -1) return unreadable
        i = end
        while (i < n && /[A-Za-z0-9]/.test(script[i])) {
          if (script[i] === 'e' || script[i] === 'w') {
            return 'a flag of s that runs a command or writes a file'
          }
          i++
        }
        break
      }
      case 'y': {
        const delim = script[i]
        if (delim === undefined || delim === '\n' || delim === '\\') {
          return unreadable
        }
        let end = sedPartEnd(script, i + 1, delim, false)
        if (end !== -1) end = sedPartEnd(script, end, delim, false)
        if (end === -1) return unreadable
        i = end
        break
      }
      case 'e':
        return 'the e command'
      case 'w':
      case 'W':
        return 'the w command'
      case 'a':
      case 'i':
      case 'c':
      case 'r':
      case 'R':
      case '#':
        i = sedLineEnd(script, i)
        break
      case ':':
      case 'b':
      case 't':
      case 'T':
        while (i < n && script[i] !== ';' && script[i] !== '\n') i++
        break
      case 'q':
      case 'Q':
      case 'l':
      case 'L':
        while (script[i] === ' ') i++
        digits()
        break
      case 'v':
        while (i < n && script[i] !== ';' && script[i] !== '\n') i++
        break
      case 'd':
      case 'D':
      case 'g':
      case 'G':
      case 'h':
      case 'H':
      case 'n':
      case 'N':
      case 'p':
      case 'P':
      case 'x':
      case 'z':
      case '=':
      case 'F':
      case '{':
      case '}':
        break
      default:
        return unreadable
    }
  }
}
