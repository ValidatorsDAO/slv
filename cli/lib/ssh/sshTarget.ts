import { parse } from '@std/yaml'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'

// The facts about a host that the ssh executor uses, read from the inventory and
// checked one by one. A value that the inventory could use to run something on
// this machine (a template, a newline, a space, a `%`) is refused, and so is
// any setting that would change how ssh connects.

type SshTarget = {
  /** The name of the host in the inventory. */
  name: string
  host: string
  port: number
  user: 'solv'
  /** Absolute path of the private key (or of its public half, for a key held by an agent). */
  identityFile: string
  /** The socket of an ssh agent to take the key from, or null. */
  identityAgent: string | null
  /** How the pin of the host is keyed in ~/.slv/known_hosts: [host]:port. */
  alias: string
  identityAccount: string
  validatorType: string
}

class TargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetError'
  }
}

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/
const KEY_PATH = /^\/[A-Za-z0-9._/-]+$/

const isHost = (value: string): boolean => {
  const v4 = IPV4.exec(value)
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255)
  if (value.includes(':')) {
    return IPV6.test(value) && value.split(':').length >= 3
  }
  return HOSTNAME.test(value)
}

/** Settings of ansible that change how a connection is made; a host that has one is not used. */
const FORBIDDEN_KEY =
  /^(ansible_ssh_common_args|ansible_ssh_extra_args|ansible_ssh_executable|ansible_connection|ansible_become.*|ansible_.*_interpreter)$/

/** A value that is text of a safe kind: no template, newline, control character, space or `%`. */
const plain = (value: unknown, what: string): string => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TargetError(`${what} is missing or not text`)
  }
  const text = String(value)
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f\s%{}$`\\]/.test(text)) {
    throw new TargetError(`${what} has a character that is not allowed in it`)
  }
  return text
}

/**
 * The target for a host of an inventory file's text. `homeDir` expands a leading
 * `~/` of the key path, as ansible does.
 */
const parseSshTarget = (
  inventoryText: string,
  group: string,
  name: string,
  options: { homeDir: string; identityAgent: string | null },
): SshTarget => {
  let document: unknown
  try {
    document = parse(inventoryText)
  } catch (_error) {
    throw new TargetError('the inventory is not valid YAML')
  }
  const hosts =
    (document as Record<string, { hosts?: Record<string, unknown> }> | null)
      ?.[group]?.hosts
  const entry = hosts?.[name]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TargetError(`${name} is not a host of ${group} in the inventory`)
  }
  const fields = entry as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new TargetError(
        `${name} has ${key}, which is not used for a connection of slv`,
      )
    }
  }
  const hostText = plain(fields.ansible_host, `ansible_host of ${name}`)
  if (!isHost(hostText)) {
    throw new TargetError(
      `ansible_host of ${name} is not an address or a host name`,
    )
  }
  // ssh lower-cases a host name and the hex of an IPv6 address, in its configuration and in the alias of the pin, so the text that slv writes is lower case from the start.
  const host = hostText.toLowerCase()
  const portValue = fields.ansible_port ?? 22
  const port = typeof portValue === 'number'
    ? portValue
    : Number(plain(portValue, `ansible_port of ${name}`))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TargetError(`ansible_port of ${name} is not a port`)
  }
  const user = plain(fields.ansible_user, `ansible_user of ${name}`)
  if (user !== 'solv') {
    throw new TargetError(`ansible_user of ${name} has to be solv`)
  }
  let keyPath = plain(
    fields.ansible_ssh_private_key_file,
    `ansible_ssh_private_key_file of ${name}`,
  )
  if (keyPath.startsWith('~/')) {
    keyPath = `${options.homeDir}${keyPath.slice(1)}`
  }
  if (
    !KEY_PATH.test(keyPath) ||
    keyPath.split('/').some((s, i) =>
      i > 0 && (s === '' || s === '.' || s === '..')
    )
  ) {
    throw new TargetError(
      `ansible_ssh_private_key_file of ${name} has to be an absolute path of letters, digits, . _ - and /`,
    )
  }
  const identityAccount = plain(
    fields.identity_account,
    `identity_account of ${name}`,
  )
  if (!BASE58_PUBKEY.test(identityAccount)) {
    throw new TargetError(`identity_account of ${name} is not a public key`)
  }
  const validatorType = plain(
    fields.validator_type ?? '',
    `validator_type of ${name}`,
  )
  return {
    name,
    host,
    port,
    user: 'solv',
    identityFile: keyPath,
    identityAgent: options.identityAgent,
    alias: `[${host}]:${port}`,
    identityAccount,
    validatorType,
  }
}

export { parseSshTarget, plain as plainValue, TargetError }
export type { SshTarget }
