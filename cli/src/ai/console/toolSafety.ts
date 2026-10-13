// What the AI console tools hand to a command, show to the model, or touch on
// disk: the environment of a command, the shape of secret keys in output, the
// paths the file tools do not handle, and who confirms a write.

import { basename, dirname, normalize, resolve } from '@std/path'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import { refusedPathReason } from '@/ai/console/keyMaterial.ts'
import { ERPC_LOGIN } from '/lib/keyLocations.ts'
import { resolveMemoryMdPath } from '@/ai/agentConfig/paths.ts'

// ---------------------------------------------------------------------------
// The environment and the shell a command runs in
// ---------------------------------------------------------------------------

const COMMAND_ENV_ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TZ',
])
const COMMAND_ENV_DENIED = [
  /^OP_/i,
  /^SSH_AUTH_SOCK$/i,
  /_TOKEN$/i,
  /_KEY$/i,
  /SECRET/i,
  /PASSWORD/i,
  /^AWS_/i,
  /^GH_/i,
  /^GITHUB_/i,
]

/**
 * The environment of the shell that runs a command: the names on the
 * allow-list from `parent`, then the variables this tool sets itself.
 * SSH_AUTH_SOCK is passed on only when a person confirmed this command at the
 * terminal.
 */
export function buildCommandEnv(
  parent: Record<string, string>,
  lang: string,
  options: { humanConfirmed?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    const allowed = COMMAND_ENV_ALLOWED.has(name) || name.startsWith('LC_')
    if (allowed && !COMMAND_ENV_DENIED.some((re) => re.test(name))) {
      env[name] = value
    }
  }
  if (options.humanConfirmed && parent.SSH_AUTH_SOCK !== undefined) {
    env.SSH_AUTH_SOCK = parent.SSH_AUTH_SOCK
  }
  env.ANSIBLE_SSH_ARGS =
    '-o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no'
  env.ANSIBLE_STDOUT_CALLBACK = 'default'
  env.ANSIBLE_DISPLAY_ARGS_TO_STDOUT = 'False'
  env.PYTHONUNBUFFERED = '1'
  env.TRADE_APP_LANG = lang
  env.OP_BIOMETRIC_UNLOCK_ENABLED = 'false'
  return env
}

/** The program and arguments that run `command` in a shell of its own. */
export function buildShellInvocation(
  command: string,
  setsidPath: string | null,
): { command: string; args: string[] } {
  return setsidPath === null
    ? { command: 'bash', args: ['-c', command] }
    : { command: setsidPath, args: ['bash', '-c', command] }
}

export function findExecutable(name: string, searchPath: string | undefined) {
  for (const dir of (searchPath ?? '').split(':')) {
    if (dir === '') continue
    try {
      const info = Deno.statSync(`${dir}/${name}`)
      if (info.isFile && info.mode !== null && (info.mode & 0o111) !== 0) {
        return `${dir}/${name}`
      }
    } catch { /* not in this directory */ }
  }
  return null
}

// ---------------------------------------------------------------------------
// Secret keys in tool output
// ---------------------------------------------------------------------------

export const REDACTED_SECRET_KEY = '[redacted secret key]'

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_CHAR = '[1-9A-HJ-NP-Za-km-z]'
// 87 or 88 base58 characters, not part of a longer run
const BASE58_CANDIDATE = new RegExp(
  `(?<!${BASE58_CHAR})${BASE58_CHAR}{87,88}(?!${BASE58_CHAR})`,
  'g',
)
// an integer that stands alone: not part of a word, a decimal or a signed number
const INTEGER = /(?<![\w.-])\d+(?![\w.])/g
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g

// DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it
// deno-fmt-ignore
const ED25519_PKCS8_HEADER = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

/** The bytes a base58 string stands for; each leading 1 is a zero byte. */
function decodeBase58(text: string): Uint8Array {
  const bytes: number[] = [] // least significant first
  for (const char of text) {
    let carry = BASE58_ALPHABET.indexOf(char)
    if (carry < 0) throw new Error('not base58')
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i]
  }
  return out
}

function decodeBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

/**
 * Is this the layout of a Solana keypair: 64 bytes whose last 32 are the
 * Ed25519 public key of the first 32? The public key is derived with
 * WebCrypto, from a PKCS#8 private key built around the seed.
 */
async function isSolanaKeypair(bytes: Uint8Array): Promise<boolean> {
  if (bytes.length !== 64) return false
  const pkcs8 = new Uint8Array(ED25519_PKCS8_HEADER.length + 32)
  pkcs8.set(ED25519_PKCS8_HEADER)
  pkcs8.set(bytes.subarray(0, 32), ED25519_PKCS8_HEADER.length)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', key)
  const publicKey = decodeBase64Url(jwk.x as string)
  return publicKey.length === 32 &&
    publicKey.every((b, i) => b === bytes[32 + i])
}

/** A check that fails is treated as a keypair, so the string is hidden. */
async function hidesAsKeypair(candidate: string): Promise<boolean> {
  try {
    return await isSolanaKeypair(decodeBase58(candidate))
  } catch {
    return true
  }
}

/**
 * Replace every run of exactly 64 integers from 0 to 255 with the marker. The
 * integers are separated by commas and white space, newlines included, and the
 * run may stand in square brackets, which go with it.
 */
function redactByteRuns(text: string): string {
  const integers = [...text.matchAll(INTEGER)]
  let out = ''
  let copied = 0
  for (let i = 0; i < integers.length;) {
    let j = i
    while (
      j + 1 < integers.length &&
      /^[\s,]+$/.test(
        text.slice(
          integers[j].index + integers[j][0].length,
          integers[j + 1].index,
        ),
      )
    ) j++
    const run = integers.slice(i, j + 1)
    if (
      run.length === 64 &&
      run.every((n) => n[0].length <= 3 && Number(n[0]) <= 255)
    ) {
      const before = /\[\s*$/.exec(text.slice(copied, run[0].index))
      const after = /^\s*\]/.exec(text.slice(run[63].index + run[63][0].length))
      const start = run[0].index - (before?.[0].length ?? 0)
      const end = run[63].index + run[63][0].length + (after?.[0].length ?? 0)
      out += text.slice(copied, start) + REDACTED_SECRET_KEY
      copied = end
    }
    i = j + 1
  }
  return out + text.slice(copied)
}

/**
 * Replace the shapes a secret key takes in text with a marker: a PEM private
 * key and a run of 64 integers always; a base58 string of 87 or 88 characters
 * when it is a Solana keypair, so a transaction signature of the same length
 * is left alone.
 */
export async function redactSecretKeys(text: string): Promise<string> {
  const redacted = redactByteRuns(
    text.replace(PEM_PRIVATE_KEY, REDACTED_SECRET_KEY),
  )
  const candidates = new Set(redacted.match(BASE58_CANDIDATE) ?? [])
  if (candidates.size === 0) return redacted
  const hidden = new Set<string>()
  for (const candidate of candidates) {
    if (await hidesAsKeypair(candidate)) hidden.add(candidate)
  }
  return redacted.replace(
    BASE58_CANDIDATE,
    (match) => hidden.has(match) ? REDACTED_SECRET_KEY : match,
  )
}

// ---------------------------------------------------------------------------
// Paths the file tools do not handle
// ---------------------------------------------------------------------------

const isUnder = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`)

/** The path with its symlinks resolved as far as it exists. */
async function resolveExisting(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const real = await Deno.realPath(current)
      return missing.length === 0 ? real : resolve(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * What a file tool must not handle at `path`: the key and wallet locations
 * (lib/keyLocations.ts) and the memory and environment of the machine for every
 * tool; for a write, also the agent config, the template, known_hosts and bin
 * paths. The path is checked as written and with its symlinks resolved.
 */
async function protectedPathReason(
  path: string,
  writing: boolean,
): Promise<string | null> {
  const home = resolveHome().replace(/\/+$/, '')
  const homes = [home, await resolveExisting(home)]
  const absolute = normalize(resolve(path))
  const candidates = [absolute, await resolveExisting(absolute)]
  for (const p of candidates) {
    const refused = refusedPathReason(p, homes)
    if (refused !== null) return refused
  }
  if (!writing) return null
  for (const p of new Set(candidates.map((c) => c.toLowerCase()))) {
    for (const h of new Set(homes.map((c) => c.toLowerCase()))) {
      const slv = `${h}/.slv`
      if (p === `${slv}/agent/config.yml`) {
        return 'the agent config (~/.slv/agent/config.yml)'
      }
      if (isUnder(p, `${slv}/template`)) {
        return 'the files under ~/.slv/template'
      }
      if (isUnder(p, `${slv}/bin`)) return 'the files under ~/.slv/bin'
      if (p === `${slv}/known_hosts` || p.startsWith(`${slv}/known_hosts.`)) {
        return '~/.slv/known_hosts'
      }
    }
  }
  return null
}

/**
 * The error a file tool returns for a path it must not handle, or null.
 * Writes are also limited to ~/.slv, with symlinks resolved.
 */
export async function fileToolRefusal(
  tool: 'read_file' | 'list_files' | 'write_file',
  path: string,
): Promise<string | null> {
  const writing = tool === 'write_file'
  const home = resolveHome()
  const outsideSlv =
    `Error: write_file only allows writing to ~/.slv/ directory. Requested path: ${path}`
  const target = writing ? normalize(path) : path
  if (writing && !target.startsWith(`${home}/.slv/`)) return outsideSlv
  const reason = await protectedPathReason(target, writing)
  if (reason === ERPC_LOGIN) {
    if (writing) {
      return `Error: write_file does not write ~/.slv/api.yml. Use the slv commands (slv login, slv onboard, slv auth) to change it.`
    }
    return `Error: ${tool} does not ${
      tool === 'read_file' ? 'read' : 'list'
    } ~/.slv/api.yml. The AI console file tools do not handle ~/.slv/api.yml.`
  }
  if (reason !== null) {
    const verb = tool === 'read_file'
      ? 'read'
      : tool === 'list_files'
      ? 'list'
      : 'write'
    return `Error: ${tool} does not ${verb} ${reason}. Ask the user to handle it outside the AI console.`
  }
  if (writing) {
    // a symlink inside ~/.slv must not lead out of it
    const realTarget = (await resolveExisting(target)).toLowerCase()
    const realSlvDir = (await resolveExisting(`${home}/.slv`)).toLowerCase()
    if (!isUnder(realTarget, realSlvDir)) return outsideSlv
  }
  return null
}

// ---------------------------------------------------------------------------
// Who confirms a write
// ---------------------------------------------------------------------------

export type WriteFileDecision = 'run' | 'confirm' | 'refuse'

/**
 * A write to a path that the path rules let through. The agent's memory file
 * is written on its own. Every other file needs a person to confirm it at a
 * terminal, and is refused where no terminal is attached. auto_execute plays
 * no part.
 */
export function decideWriteFile(
  input: { memoryFile: boolean; hasTerminal: boolean },
): WriteFileDecision {
  if (input.memoryFile) return 'run'
  return input.hasTerminal ? 'confirm' : 'refuse'
}

/**
 * True for ~/.slv/agent/MEMORY.md itself: the path as written is that path,
 * and the file is not a link to another file.
 */
export async function isAgentMemoryFile(path: string): Promise<boolean> {
  const target = normalize(path)
  if (target !== resolveMemoryMdPath(resolveHome())) return false
  return await resolveExisting(target) ===
    resolve(await resolveExisting(dirname(target)), basename(target))
}

/** What the refusal of a write says where no terminal is attached. */
export function describeWriteRefusal(path: string): string {
  return `Error: write_file did not write ${
    showText(path)
  }. Writing this file needs a person to confirm it in a terminal, and no terminal is attached to this session. Only ~/.slv/agent/MEMORY.md is written without a person. Do not try again. Give the user the content and the path, and ask them to write the file themselves.`
}

const PREVIEW_LINES = 20
const PREVIEW_WIDTH = 200

/**
 * The text with the characters that move the cursor, restyle the screen or
 * reorder what is shown written out as \uXXXX.
 */
function showText(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const hidden = (code < 0x20 && code !== 0x09) ||
      (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    out += hidden ? `\\u${code.toString(16).padStart(4, '0')}` : ch
  }
  return out
}

/**
 * The lines a person sees before they confirm a write: the path, the size in
 * bytes and lines, and the first 20 lines. `existingBytes` is the size of the
 * file that the write replaces, or null when there is none.
 */
export function describeWrite(
  path: string,
  content: string,
  existingBytes: number | null,
): string[] {
  const bytes = new TextEncoder().encode(content).length
  const lines = content === ''
    ? []
    : content.replace(/\r?\n$/, '').split(/\r?\n/)
  const replaces = existingBytes === null
    ? 'a new file'
    : `replaces a file of ${existingBytes} bytes`
  const out = [
    `  Path: ${showText(path)}`,
    `  Size: ${bytes} bytes in ${lines.length} lines (${replaces})`,
  ]
  for (const line of lines.slice(0, PREVIEW_LINES)) {
    out.push(
      line.length > PREVIEW_WIDTH
        ? `  | ${showText(line.slice(0, PREVIEW_WIDTH))} ... ${
          line.length - PREVIEW_WIDTH
        } more characters`
        : `  | ${showText(line)}`,
    )
  }
  if (lines.length > PREVIEW_LINES) {
    out.push(`  | ... ${lines.length - PREVIEW_LINES} more lines are not shown`)
  }
  return out
}
