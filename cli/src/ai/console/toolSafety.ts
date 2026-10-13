// What the AI console tools hand to a command, show to the model, or touch on
// disk: the environment of a command, the shape of secret keys in output, and
// the paths the file tools do not handle.

import { basename, dirname, normalize, resolve } from '@std/path'
import { resolveHome } from '/lib/getApiKeyFromYml.ts'
import {
  IDENTITY_FILE_NAME,
  KEYPAIR_FILE_NAME,
  PROCESS_ENVIRON,
} from '@/ai/console/keyMaterial.ts'

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
// a JSON array of exactly 64 integers; each is checked to be 0-255 below
const BYTE_ARRAY_SECRET_KEY = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/g
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
 * Replace the shapes a secret key takes in text with a marker: a PEM private
 * key and a JSON array of 64 integers always; a base58 string of 87 or 88
 * characters when it is a Solana keypair, so a transaction signature of the
 * same length is left alone.
 */
export async function redactSecretKeys(text: string): Promise<string> {
  const redacted = text
    .replace(PEM_PRIVATE_KEY, REDACTED_SECRET_KEY)
    .replace(
      BYTE_ARRAY_SECRET_KEY,
      (match) =>
        (match.match(/\d+/g) ?? []).every((n) => Number(n) <= 255)
          ? REDACTED_SECRET_KEY
          : match,
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

/**
 * True for ~/.slv/api.yml, its lock and its temporary files. The AI console
 * file tools do not handle ~/.slv/api.yml. The path is made absolute and
 * normalized, and followed through symlinks when it exists.
 */
async function isApiYmlPath(path: string): Promise<boolean> {
  const real = async (p: string) => {
    try {
      return await Deno.realPath(p)
    } catch {
      return normalize(resolve(p))
    }
  }
  const target = await real(path)
  const name = basename(target)
  if (!name.startsWith('api.yml') && !name.startsWith('.api.yml.')) {
    return false
  }
  const slvDir = `${resolveHome()}/.slv`
  return dirname(target) === normalize(slvDir) ||
    dirname(target) === await real(slvDir)
}

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
 * What a file tool must not handle at `path`: key material and credentials
 * for every tool; for a write, also the agent config, the template,
 * known_hosts and bin paths.
 * The path is checked as written and with its symlinks resolved.
 */
async function protectedPathReason(
  path: string,
  writing: boolean,
): Promise<string | null> {
  const home = resolveHome().replace(/\/+$/, '')
  const homes = new Set([
    home.toLowerCase(),
    (await resolveExisting(home)).toLowerCase(),
  ])
  const absolute = normalize(resolve(path))
  const candidates = new Set([
    absolute.toLowerCase(),
    (await resolveExisting(absolute)).toLowerCase(),
  ])
  for (const p of candidates) {
    const name = basename(p)
    if (KEYPAIR_FILE_NAME.test(name)) return 'a keypair file'
    if (IDENTITY_FILE_NAME.test(name)) return 'an identity key file'
    if (PROCESS_ENVIRON.test(p)) return 'the environment of a process'
    for (const h of homes) {
      const slv = `${h}/.slv`
      if (isUnder(p, `${slv}/keys`)) return 'the files under ~/.slv/keys'
      if (p === `${slv}/gateway/gateway.json`) {
        return 'the gateway credentials (~/.slv/gateway/gateway.json)'
      }
      if (p === `${slv}/backup.env`) {
        return 'the backup credentials (~/.slv/backup.env)'
      }
      if (p === `${slv}/restic-password`) {
        return 'the backup password (~/.slv/restic-password)'
      }
      if (
        isUnder(p, `${h}/.ssh`) && name.startsWith('id_') &&
        !name.endsWith('.pub')
      ) return 'an SSH private key'
      if (writing) {
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
  if (await isApiYmlPath(target)) {
    if (writing) {
      return `Error: write_file does not write ~/.slv/api.yml. Use the slv commands (slv login, slv onboard, slv auth) to change it.`
    }
    return `Error: ${tool} does not ${
      tool === 'read_file' ? 'read' : 'list'
    } ~/.slv/api.yml. The AI console file tools do not handle ~/.slv/api.yml.`
  }
  const reason = await protectedPathReason(target, writing)
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
