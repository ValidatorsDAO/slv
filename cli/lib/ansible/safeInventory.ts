import { join } from '@std/path'
import { parse, stringify } from '@std/yaml'
import { SolanaNodeTypes } from '@cmn/constants/config.ts'
import { BASE58_PUBKEY } from '/lib/secret/base58.ts'
import { IdentityRefError, parseIdentityRef } from '/lib/secret/identityRef.ts'
import {
  parseSshTarget,
  plainValue,
  type SshTarget,
  TargetError,
} from '/lib/ssh/sshTarget.ts'

// The inventory that an identity run of ansible reads. It is generated from the
// hosts of the run, with the allowlisted variables only, each checked, in a
// directory of its own: nothing else of the inventory file, of the working
// directory, of the home directory, of ANSIBLE_* or of the OP_* variables of
// 1Password in the environment reaches the run.

type SafeGroup = 'testnet_validators' | 'mainnet_validators'

/** What ansible needs to reach a host. */
const CONNECTION_VARS = [
  'ansible_host',
  'ansible_port',
  'ansible_user',
  'ansible_ssh_private_key_file',
] as const

/** The inventory variables that the identity playbooks read; a test scans the playbooks for them. */
const PLAYBOOK_VARS = [
  'ansible_host',
  'identity_account',
  'identity_ref',
  'no_voting',
  'port_rpc',
  'validator_type',
  'vote_account',
] as const

const ALLOWED_VARS: readonly string[] = [
  ...new Set([...CONNECTION_VARS, ...PLAYBOOK_VARS]),
]

class InventoryRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryRefusal'
  }
}

type SafeHost = {
  name: string
  /** The checked connection facts, for the ssh configuration and the prompt. */
  target: SshTarget
  voteAccount: string | null
  portRpc: number | null
}

type SafeInventoryInput = {
  group: SafeGroup
  /** The text of the inventory file. */
  inventoryText: string
  /** The inventory names of the hosts of the run. */
  hosts: readonly string[]
  homeDir: string
  identityAgent: string | null
  /** The environment of this process. */
  parentEnv: Record<string, string>
}

type SafeInventory = {
  runDir: string
  inventoryPath: string
  configPath: string
  noncePath: string
  /** What run.nonce holds. */
  nonce: string
  hosts: SafeHost[]
  /** The environment for ansible-playbook. */
  env: Record<string, string>
  /** The directory ansible-playbook runs in. */
  cwd: string
  /** Removes the directory. */
  remove: () => Promise<void>
}

type SafeInventoryDeps = {
  makeDir: () => Promise<string>
  /** Writes a file that does not exist yet, readable by the owner only. */
  writeFile: (path: string, text: string) => Promise<void>
  removeDir: (dir: string) => Promise<void>
  random: (length: number) => Uint8Array
}

const defaultSafeInventoryDeps = (): SafeInventoryDeps => ({
  makeDir: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'slv-run-' })
    await Deno.chmod(dir, 0o700)
    return dir
  },
  writeFile: (path, text) =>
    Deno.writeTextFile(path, text, { mode: 0o600, createNew: true }),
  removeDir: (dir) => Deno.remove(dir, { recursive: true }),
  random: (length) => crypto.getRandomValues(new Uint8Array(length)),
})

const RUN_DIR = /^\/[A-Za-z0-9._/-]+$/

/** A value that passes the rule for the values of an inventory, or a refusal. */
const plainOrRefuse = (value: unknown, what: string): string => {
  try {
    return plainValue(value, what)
  } catch (error) {
    if (error instanceof TargetError) throw new InventoryRefusal(error.message)
    throw error
  }
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The entries of the hosts of the group in the text of an inventory. */
const hostEntries = (
  input: SafeInventoryInput,
): Record<string, unknown> => {
  let document: unknown
  try {
    document = parse(input.inventoryText)
  } catch (_error) {
    throw new InventoryRefusal('the inventory is not valid YAML')
  }
  const group = isMapping(document) ? document[input.group] : undefined
  const hosts = isMapping(group) ? group.hosts : undefined
  return isMapping(hosts) ? hosts : {}
}

/** The checked facts of one host of the run, and its variables for the generated inventory. */
const checkHost = (
  input: SafeInventoryInput,
  entries: Record<string, unknown>,
  name: string,
): { host: SafeHost; vars: Record<string, string | number | boolean> } => {
  let target: SshTarget
  try {
    target = parseSshTarget(input.inventoryText, input.group, name, {
      homeDir: input.homeDir,
      identityAgent: input.identityAgent,
    })
  } catch (error) {
    if (error instanceof TargetError) throw new InventoryRefusal(error.message)
    throw error
  }
  // parseSshTarget has found this entry, so it is a mapping.
  const entry = entries[name] as Record<string, unknown>

  // These public policy fields must reach the playbook's activation refusal.
  // Dropping or coercing them could turn a sync-only host into a legacy voter.
  if (entry.no_voting !== undefined && typeof entry.no_voting !== 'boolean') {
    throw new InventoryRefusal(`no_voting of ${name} has to be a boolean`)
  }
  if (entry.identity_ref !== undefined) {
    if (typeof entry.identity_ref !== 'string') {
      throw new InventoryRefusal(`identity_ref of ${name} has to be text`)
    }
    const reference = plainOrRefuse(
      entry.identity_ref,
      `identity_ref of ${name}`,
    )
    if (reference !== '') {
      try {
        parseIdentityRef(reference, { homeDir: input.homeDir })
      } catch (error) {
        if (!(error instanceof IdentityRefError)) throw error
        throw new InventoryRefusal(
          `identity_ref of ${name} is not a valid reference`,
        )
      }
    }
  }

  if (!(SolanaNodeTypes as readonly string[]).includes(target.validatorType)) {
    throw new InventoryRefusal(
      `validator_type of ${name} has to be one of ${
        SolanaNodeTypes.join(', ')
      }`,
    )
  }
  let voteAccount: string | null = null
  if (entry.vote_account !== undefined && entry.vote_account !== '') {
    const vote = plainOrRefuse(entry.vote_account, `vote_account of ${name}`)
    if (!BASE58_PUBKEY.test(vote)) {
      throw new InventoryRefusal(`vote_account of ${name} is not a public key`)
    }
    voteAccount = vote
  }
  let portRpc: number | null = null
  if (entry.port_rpc !== undefined) {
    const text = plainOrRefuse(entry.port_rpc, `port_rpc of ${name}`)
    const port = /^[0-9]{1,5}$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InventoryRefusal(`port_rpc of ${name} is not a port`)
    }
    portRpc = port
  }

  // Only the allowlisted variables, in the order they are listed above.
  const vars: Record<string, string | number | boolean> = {
    ansible_host: target.host,
    ...(entry.ansible_port === undefined ? {} : { ansible_port: target.port }),
    ansible_user: target.user,
    ansible_ssh_private_key_file: target.identityFile,
    identity_account: target.identityAccount,
    ...(entry.identity_ref === undefined
      ? {}
      : { identity_ref: entry.identity_ref as string }),
    ...(entry.no_voting === undefined
      ? {}
      : { no_voting: entry.no_voting as boolean }),
    ...(voteAccount === null ? {} : { vote_account: voteAccount }),
    validator_type: target.validatorType,
    ...(portRpc === null ? {} : { port_rpc: portRpc }),
  }
  return { host: { name, target, voteAccount, portRpc }, vars }
}

/** The text of the generated inventory. */
const buildInventoryText = (
  group: SafeGroup,
  hosts: Record<string, Record<string, string | number | boolean>>,
): string => stringify({ [group]: { hosts } })

/** The text of ansible.cfg. */
const buildAnsibleConfig = (inventoryPath: string): string =>
  [
    '[defaults]',
    `inventory = ${inventoryPath}`,
    'host_key_checking = True',
    'retry_files_enabled = False',
    'interpreter_python = auto_silent',
    'stdout_callback = default',
    '',
    '[inventory]',
    'enable_plugins = yaml',
    '',
    '[ssh_connection]',
    'pipelining = True',
    '',
  ].join('\n')

/**
 * The environment of the run: that of this process without any ANSIBLE_* or
 * OP_* variable (a session or a token of 1Password is nothing a playbook needs
 * and everything a planted plugin would use), and ANSIBLE_CONFIG. The ssh agent
 * socket stays: a key held by an agent is how the run reaches the node.
 */
const buildAnsibleEnv = (
  parentEnv: Record<string, string>,
  configPath: string,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!/^(?:ansible|op)_/i.test(name)) env[name] = value
  }
  env.ANSIBLE_CONFIG = configPath
  return env
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Checks the hosts of a run and makes its directory: inventory.yml, ansible.cfg
 * and run.nonce, readable by the owner only. A host that does not pass is
 * refused before anything is made.
 */
const prepareSafeInventory = async (
  input: SafeInventoryInput,
  deps: SafeInventoryDeps = defaultSafeInventoryDeps(),
): Promise<SafeInventory> => {
  if (input.hosts.length === 0) {
    throw new InventoryRefusal('no host is named for the run')
  }
  if (new Set(input.hosts).size !== input.hosts.length) {
    throw new InventoryRefusal('a host is named twice for the run')
  }
  // The name goes into the generated inventory and into the messages of the plays.
  for (const name of input.hosts) plainOrRefuse(name, 'a host name of the run')
  const entries = hostEntries(input)
  const checked = input.hosts.map((name) => checkHost(input, entries, name))

  const runDir = await deps.makeDir()
  try {
    if (!RUN_DIR.test(runDir)) {
      throw new InventoryRefusal(
        `the directory ${runDir} cannot hold the files of a run: it has to be an absolute path of letters, digits, . _ - and /`,
      )
    }
    const inventoryPath = join(runDir, 'inventory.yml')
    const configPath = join(runDir, 'ansible.cfg')
    const noncePath = join(runDir, 'run.nonce')
    const nonce = hex(deps.random(16))

    await deps.writeFile(
      inventoryPath,
      buildInventoryText(
        input.group,
        Object.fromEntries(checked.map(({ host, vars }) => [host.name, vars])),
      ),
    )
    await deps.writeFile(configPath, buildAnsibleConfig(inventoryPath))
    await deps.writeFile(noncePath, nonce)

    return {
      runDir,
      inventoryPath,
      configPath,
      noncePath,
      nonce,
      hosts: checked.map(({ host }) => host),
      env: buildAnsibleEnv(input.parentEnv, configPath),
      cwd: runDir,
      remove: () => deps.removeDir(runDir),
    }
  } catch (error) {
    await deps.removeDir(runDir).catch(() => undefined)
    throw error
  }
}

export {
  ALLOWED_VARS,
  buildAnsibleConfig,
  buildAnsibleEnv,
  buildInventoryText,
  CONNECTION_VARS,
  defaultSafeInventoryDeps,
  InventoryRefusal,
  PLAYBOOK_VARS,
  prepareSafeInventory,
}
export type {
  SafeGroup,
  SafeHost,
  SafeInventory,
  SafeInventoryDeps,
  SafeInventoryInput,
}
