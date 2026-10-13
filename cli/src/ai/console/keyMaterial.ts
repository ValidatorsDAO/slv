// The places that hold key material, wallets and credentials, for the AI
// console. The file tools (toolSafety.ts) apply them to a resolved path; the
// command gate (commandGate.ts) applies them to the words of a command line;
// the recursive readers (recursiveRead.ts) ask which directories hold them.
// All three read the same classes from here, together with the note that says
// what stays readable outside them.
//
// The classes are built from the one list of key and wallet locations that the
// backup reads too (lib/keyLocations.ts). The few places the backup has no
// reason to know, the memory of the machine and the environment of a process,
// are listed below.

import {
  isHomeRelative,
  KEY_LOCATIONS,
  type KeyLocation,
} from '/lib/keyLocations.ts'

/**
 * What `auto_execute: true` changes, in the words of the agent config schema,
 * the onboarding text and the run_command and read_file tool descriptions.
 */
export const AUTO_EXECUTE_NOTE =
  'With auto_execute on, the console runs read-only commands without asking, and every other command needs a person to confirm it in a terminal. A read-only command can still read files outside the refused classes (keys, wallets and credentials), and output redaction hides only three key shapes: a PEM private key, a run of 64 integers (a JSON array, or the numbers in a row or one to a line) and a base58 Solana keypair.'

// Placeholders the command reader leaves in a word for text it cannot know:
// RUNTIME for an expansion, PATTERN for a glob character.
export const RUNTIME = '\u0000'
export const PATTERN = '\u0001'
const PLACEHOLDERS = `${RUNTIME}${PATTERN}`
const PLACEHOLDER_CHARS = new RegExp(`[${PLACEHOLDERS}]`, 'g')

// A path component starts at the start of a word, after a separator or after
// a placeholder.
const START = `(?<![^/\\s'"=:${PLACEHOLDERS}])`
// One path component.
const NAME = `[^/\\s'"]`
// The end of a path component: nothing that would continue its name.
const NAME_END = `(?![A-Za-z0-9_.-])`

// What the console refuses besides the locations of the backup: the memory of
// the machine and the environment of a process. `%pid` stands for a process
// (`self`, `thread-self` or a number) and `%tid` for a thread.
const MACHINE_LOCATIONS: readonly KeyLocation[] = [
  {
    paths: ['/proc/%pid/environ', '/proc/%pid/task/%tid/environ'],
    kind: 'file',
    group: 'key',
    reason: 'the environment of a process',
    consoleOnly: true,
  },
  {
    paths: ['/proc/kcore'],
    kind: 'file',
    group: 'key',
    reason: 'the memory of the kernel (/proc/kcore)',
    consoleOnly: true,
  },
  {
    paths: ['/proc/%pid/mem', '/proc/%pid/task/%tid/mem'],
    kind: 'file',
    group: 'key',
    reason: 'the memory of a process',
    consoleOnly: true,
  },
  {
    paths: ['/dev/mem', '/dev/kmem', '/dev/port'],
    kind: 'file',
    group: 'key',
    reason:
      'the memory or the I/O ports of the machine (/dev/mem, /dev/kmem, /dev/port)',
    consoleOnly: true,
  },
]

// ---------------------------------------------------------------------------
// The classes
// ---------------------------------------------------------------------------

/** One path pattern of a location, in lower case. */
interface Place {
  reason: string
  /** The components. `**` stands for directories. */
  parts: string[]
  /** Relative to a home directory (otherwise absolute). */
  home: boolean
  /** The directory and everything below it. */
  directory: boolean
  /** Everything below the directory, not the directory itself. */
  below: boolean
  /** A file name, in every directory. */
  anywhere: boolean
  /** Names that go on after the path are covered too. */
  copies: boolean
  open: string[]
  examples: string[]
  /** A glob word with no directory may name it in the working directory. */
  inCwd: boolean
}

function compilePlaces(locations: readonly KeyLocation[]): Place[] {
  const places: Place[] = []
  for (const location of locations) {
    for (const path of location.paths) {
      const parts = path.toLowerCase().split('/').filter((part) => part !== '')
      const below = parts[parts.length - 1] === '**'
      if (below) parts.pop()
      places.push({
        reason: location.reason,
        parts,
        home: isHomeRelative(path),
        directory: location.kind === 'directory',
        below,
        anywhere: location.anywhere === true,
        copies: location.copies === true,
        open: [...(location.open ?? [])],
        examples: (location.examples ?? []).map((name) => name.toLowerCase()),
        inCwd: location.anywhere === true || location.inCwd === true,
      })
    }
  }
  return places
}

const PLACES = compilePlaces([...KEY_LOCATIONS, ...MACHINE_LOCATIONS])

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const componentsOf = (path: string): string[] =>
  path.toLowerCase().split('/').filter((part) => part !== '')

/**
 * Is the name one of those that stay readable inside a location: a name
 * written out, or `*` followed by the end of a name?
 */
const isOpen = (name: string, open: readonly string[]): boolean => {
  const lower = name.toLowerCase()
  return open.some((spec) =>
    spec.startsWith('*') ? lower.endsWith(spec.slice(1)) : lower === spec
  )
}

// ---------------------------------------------------------------------------
// A word as written: a path is matched by its tail
// ---------------------------------------------------------------------------

/** One component of a place as the source of a regular expression over a word. */
function wordPart(part: string): string {
  if (part === '%pid') return `(?:self|thread-self|\\d+|[${PLACEHOLDERS}]+)`
  if (part === '%tid') return `(?:\\d+|[${PLACEHOLDERS}]+)`
  return part.split('*').map(escapeRegExp).join(`${NAME}*`)
}

/**
 * The regular expression that finds a place in the text of a word. A place
 * under a home directory starts at a path component; an absolute one starts at
 * its `/`, so that a path through /proc/PID/root counts. The component after
 * `.ssh/` is captured for the names that stay open.
 */
function wordPattern(place: Place): RegExp {
  const parts = place.parts
  let source = place.home ? START : '/'
  parts.forEach((part, i) => {
    const last = i === parts.length - 1
    if (part === '**') {
      source += `(?:${NAME}+/)*`
      return
    }
    const text = wordPart(part)
    source += last && !place.below && place.open.length > 0 ? `(${text})` : text
    if (!last || place.below) source += '/'
  })
  if (place.below) source += `(?:${NAME}+/)*(${NAME}+)`
  else if (place.directory || !(place.anywhere || place.copies)) {
    source += NAME_END
  }
  return new RegExp(source, 'gi')
}

const MATCHERS = PLACES.map((place) => ({ place, pattern: wordPattern(place) }))

interface Hit {
  index: number
  end: number
  reason: string
}

/**
 * Every place that the text of a word holds. `named` leaves out the places
 * that cover whatever a directory holds, which no name has to be written for.
 */
function scan(text: string, named = false): Hit[] {
  const hits: Hit[] = []
  for (const { place, pattern } of MATCHERS) {
    if (named && place.below) continue
    for (const match of text.matchAll(pattern)) {
      if (place.open.length > 0 && isOpen(match[1] ?? '', place.open)) continue
      hits.push({
        index: match.index,
        end: match.index + match[0].length,
        reason: place.reason,
      })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Homes
// ---------------------------------------------------------------------------

// The home directories the patterns below are written for. A path under any
// other home is read as if it were under the first one.
const HOMES = ['/home/solv', '/root']
const HOME_PARTS = HOMES.map(componentsOf)

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

/**
 * What follows a home directory in the components of an absolute path, for each
 * home it starts with: root's, a user's under /home or /Users, the homes of
 * this process and `homes`.
 */
function underHomes(
  parts: readonly string[],
  homes: readonly string[],
): string[][] {
  const rests: string[][] = []
  for (const home of [...homes, ...ownHomes()]) {
    const own = componentsOf(home)
    if (own.length > 0 && own.every((part, i) => parts[i] === part)) {
      rests.push(parts.slice(own.length))
    }
  }
  if (parts[0] === 'root') rests.push(parts.slice(1))
  if ((parts[0] === 'home' || parts[0] === 'users') && parts.length > 1) {
    rests.push(parts.slice(2))
  }
  return rests
}

// ---------------------------------------------------------------------------
// A path as the file tools see it: whole and resolved
// ---------------------------------------------------------------------------

const exactCache = new Map<string, RegExp>()

/** One component of a place as a regular expression over a path component. */
function exactPart(part: string, copies: boolean): RegExp {
  const key = `${part}|${copies}`
  let pattern = exactCache.get(key)
  if (pattern === undefined) {
    let source: string
    if (part === '%pid') source = '(?:self|thread-self|\\d+)'
    else if (part === '%tid') source = '\\d+'
    else source = part.split('*').map(escapeRegExp).join('[^/]*')
    pattern = new RegExp(`^${source}${copies ? '[^/]*' : ''}$`, 'i')
    exactCache.set(key, pattern)
  }
  return pattern
}

/** Do the components after a home directory (or after `/`) name the place? */
function namesPlace(rest: readonly string[], place: Place): boolean {
  const parts = place.parts
  const n = parts.length
  if (place.directory || place.below) {
    if (rest.length < n + (place.below ? 1 : 0)) return false
    if (!parts.every((part, i) => exactPart(part, false).test(rest[i]))) {
      return false
    }
    return !(place.below && isOpen(rest[rest.length - 1], place.open))
  }
  const go = (i: number, j: number): boolean => {
    if (j === n) return i === rest.length
    if (parts[j] === '**') {
      return go(i, j + 1) || (i < rest.length && go(i + 1, j))
    }
    if (i >= rest.length) return false
    return exactPart(parts[j], place.copies && j === n - 1).test(rest[i]) &&
      go(i + 1, j + 1)
  }
  return go(0, 0) &&
    !(place.open.length > 0 && isOpen(rest[rest.length - 1], place.open))
}

/**
 * Why a file tool must not handle this absolute path, or null: it is one of
 * the key and wallet locations under a home directory (the homes of this
 * process, `homes`, root's, and any user's under /home and /Users) or one of
 * the system locations.
 */
export function refusedPathReason(
  path: string,
  homes: readonly string[] = [],
): string | null {
  if (!path.startsWith('/')) return null
  const parts = componentsOf(path)
  const rests = underHomes(parts, homes)
  for (const place of PLACES) {
    if (place.anywhere) {
      if (
        parts.length > 0 &&
        exactPart(place.parts[0], true).test(parts[parts.length - 1])
      ) {
        return place.reason
      }
    } else if (place.home) {
      if (rests.some((rest) => namesPlace(rest, place))) return place.reason
    } else if (namesPlace(parts, place)) {
      return place.reason
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// A directory a recursive search would go through
// ---------------------------------------------------------------------------

/** Can a directory with these components hold the place, or lie inside it? */
function holdsPlace(dir: readonly string[], place: Place): boolean {
  const parts = place.parts
  for (let j = 0; j < parts.length; j++) {
    if (dir.length === j) return true
    if (parts[j] === '**') return true
    if (!exactPart(parts[j], false).test(dir[j])) return false
  }
  return dir.length === parts.length || place.directory || place.below
}

/**
 * Why a directory (its lower-case components, without `.` and `..`) holds a
 * key or wallet location, or lies inside one, or null.
 */
export function directoryHoldsReason(dir: readonly string[]): string | null {
  const rests = underHomes(dir, [])
  for (const place of PLACES) {
    if (place.anywhere) continue
    const holds = place.home
      ? rests.some((rest) => holdsPlace(rest, place))
      : holdsPlace(dir, place)
    if (holds) return `holds ${place.reason}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Braces, dots and patterns
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// A word with glob characters: can it stand for a place?
// ---------------------------------------------------------------------------

type Token = { any: true; glob: boolean } | { cls: RegExp } | { ch: string }

/** Characters a file name is made of, for the bracket expressions that name some. */
const NAME_CHARACTERS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-~@#%+=,:;!',
]

/** The characters of a component of a pattern word. */
function wordTokens(component: string): Token[] {
  const tokens: Token[] = []
  for (let i = 0; i < component.length; i++) {
    const ch = component[i]
    if (ch === PATTERN || ch === RUNTIME) {
      tokens.push({ any: true, glob: ch === PATTERN })
    } else if (ch === '[') {
      const close = component.indexOf(']', i + 2)
      if (close === -1) {
        tokens.push({ ch })
      } else {
        tokens.push({ cls: patternToRegExp(component.slice(i, close + 1)) })
        i = close
      }
    } else {
      tokens.push({ ch })
    }
  }
  return tokens
}

/**
 * Can two components, a pattern word's and a place's, name the same file? With
 * `dots`, a glob character or a bracket expression at the start of a component
 * does not match a name that starts with a dot, as in the shell; an expansion
 * can.
 */
function componentsIntersect(
  word: string,
  part: string,
  dots = false,
): boolean {
  if (part === '%tid') return standsForNumber(word)
  if (part === '%pid') {
    return standsForNumber(word) || componentsIntersect(word, 'self') ||
      componentsIntersect(word, 'thread-self')
  }
  const u = wordTokens(word.toLowerCase())
  const l: Array<{ any: true } | { ch: string }> = [...part.toLowerCase()].map((
    ch,
  ) => ch === '*' ? { any: true } : { ch })
  const memo = new Map<number, boolean>()
  // may the character be the one a token of the word stands for?
  const takes = (token: Token, ch: string, started: boolean): boolean => {
    const noDot = dots && !started && ch === '.'
    if ('ch' in token) return token.ch === ch
    if ('cls' in token) return token.cls.test(ch) && !noDot
    return !token.glob || !noDot
  }
  // may a bracket expression stand for some character, here?
  const anyOf = (token: { cls: RegExp }, started: boolean): boolean =>
    !dots || started || NAME_CHARACTERS.some((c) => token.cls.test(c))
  const go = (i: number, j: number, started: boolean): boolean => {
    const key = (i * 4096 + j) * 2 + (started ? 1 : 0)
    const known = memo.get(key)
    if (known !== undefined) return known
    const a = u[i]
    const b = l[j]
    let result = false
    if (a === undefined && b === undefined) {
      result = true
    } else if (a !== undefined && 'any' in a) {
      result = go(i + 1, j, started) ||
        (b !== undefined && ('any' in b || takes(a, b.ch, started)) &&
          go(i, j + 1, true))
    } else if (b !== undefined && 'any' in b) {
      result = go(i, j + 1, started) ||
        (a !== undefined &&
          ('ch' in a || anyOf(a, started)) && go(i + 1, j, true))
    } else if (a !== undefined && b !== undefined) {
      result = takes(a, b.ch, started) && go(i + 1, j + 1, true)
    }
    memo.set(key, result)
    return result
  }
  return go(0, 0, false)
}

/**
 * Can the components of a word stand for the components of a place, from the
 * start? With `prefix` the word may go on below the place.
 */
function alignParts(
  word: readonly string[],
  parts: readonly string[],
  prefix: boolean,
  dots = false,
  from = 0,
): boolean {
  const go = (i: number, j: number): boolean => {
    if (j === parts.length) return prefix || i === word.length
    if (parts[j] === '**') {
      return go(i, j + 1) || (i < word.length && go(i + 1, j))
    }
    return i < word.length && componentsIntersect(word[i], parts[j], dots) &&
      go(i + 1, j + 1)
  }
  return go(from, 0)
}

/** What a copy of a file adds to its name. */
const COPY_SUFFIXES = ['', '.bak', '.old', '.orig', '.lock', '.tmp', '~']

/** The component lists a glob word is read against for one place. */
function placeAlternatives(place: Place): string[][] {
  const parts = place.parts
  const names = place.examples.length > 0
    ? place.examples
    : [parts[parts.length - 1]]
  const lists =
    (place.copies
      ? names.flatMap((name) => COPY_SUFFIXES.map((suffix) => name + suffix))
      : names).map((name) => [...parts.slice(0, -1), name])
  return place.below ? lists.map((list) => [...list, '*']) : lists
}

/** The first components of the places under a home directory. */
const HOME_FIRST = new Set(
  PLACES.filter((place) => place.home && !place.anywhere).map((place) =>
    place.parts[0]
  ).filter((part) => !part.includes('*') && part !== '**'),
)

const LEADING_HOME = new RegExp(`^(?:~|${RUNTIME})[^/${PLACEHOLDERS}]*(?=/|$)`)

/**
 * Can a file name with glob characters stand for a key file in the current
 * directory? At least two characters besides `.json` must be written out, so
 * that `*.json` and `*` name nothing.
 */
function nameInDirectoryReason(name: string): string | null {
  const written = name.replace(/\.json$/i, '').replace(/\[[^\]]*\]/g, '')
    .replace(PLACEHOLDER_CHARS, '')
  if (written.length < 2) return null
  const pattern = patternToRegExp(name)
  for (const place of PLACES) {
    if (!place.inCwd) continue
    if (place.examples.some((example) => pattern.test(example))) {
      return place.reason
    }
  }
  return null
}

/**
 * Can a word with glob characters stand for a key or wallet location? A tilde
 * or an expansion in front of the first slash stands for the home directory,
 * and so does the start of a relative word that begins like a place under a
 * home. A word that ends in a name that stays open does not.
 */
function patternReason(text: string): string | null {
  let t = text.replace(LEADING_HOME, HOMES[0])
  if (
    !t.startsWith('/') && t.includes('/') &&
    HOME_FIRST.has(t.split('/')[0].toLowerCase())
  ) t = `${HOMES[0]}/${t}`
  if (!t.includes('/')) return nameInDirectoryReason(t)
  const climbs = t.startsWith('../')
  const rooted = t.startsWith('/') || climbs
  const comps = componentsOf(t).filter((part, i, all) =>
    !(climbs && part === '..' && all.slice(0, i).every((p) => p === '..'))
  )
  const last = comps[comps.length - 1] ?? ''
  const absolute = rooted
    ? componentsOf(
      underFirstHome(t.startsWith('/') ? t : `/${comps.join('/')}`),
    )
    : null
  for (const place of PLACES) {
    if (place.open.length > 0 && isOpen(last, place.open)) continue
    const prefix = place.directory || place.below
    for (const alternative of placeAlternatives(place)) {
      if (place.home) {
        if (absolute === null) continue
        for (const home of HOME_PARTS) {
          if (
            alignParts(absolute, [...home, ...alternative], prefix, place.below)
          ) return place.reason
        }
      } else {
        // a word ends in the place; a directory may have more below it
        const fixed = !prefix && !alternative.includes('**')
        const first = fixed ? comps.length - alternative.length : 0
        const end = fixed ? first : comps.length - 1
        for (let start = Math.max(first, 0); start <= end; start++) {
          if (!alignParts(comps, alternative, prefix, place.below, start)) {
            continue
          }
          // a relative word counts when it writes out a component itself
          if (rooted || alternative.some((p, i) => comps[start + i] === p)) {
            return place.reason
          }
        }
      }
    }
  }
  return null
}

/**
 * Directories an expansion may stand for in front of the rest of a word: the
 * directories above a place, written as a home directory's or an absolute one.
 */
const STAND_INS: string[] = [
  ...new Set(PLACES.flatMap((place) => {
    if (place.anywhere) return []
    const parts = place.parts.map((part) =>
      part === '**' || part === '%tid'
        ? part === '**' ? 'x' : '1'
        : part === '%pid'
        ? 'self'
        : part.replaceAll('*', 'x')
    )
    const upto = place.below ? parts.length : parts.length - 1
    const dirs: string[] = []
    for (let k = 1; k <= upto; k++) {
      const dir = parts.slice(0, k).join('/')
      dirs.push(place.home ? `${HOMES[0]}/${dir}` : `/${dir}`)
    }
    return dirs
  })),
]

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
      for (const hit of scan(candidate, true)) {
        if (hit.end > at + standIn.length) return hit.reason
      }
    }
    at = text.indexOf(RUNTIME, at + 1)
  }
  return null
}

function classReason(text: string): string | null {
  const hits = scan(text)
  if (hits.length > 0) return hits[0].reason
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
 * counts when it can expand to key material or a wallet.
 */
export function keyMaterialInWord(word: string): string | null {
  for (const alternative of expandBraces(word)) {
    const reason = classReason(alternative) ??
      classReason(collapsePaths(alternative))
    if (reason !== null) return reason
  }
  return null
}
