import { parse } from '@std/yaml'
import { Confirm } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

// Who and what a CLI command may target: the host list an unlimited ansible
// run would reach, the single host `set:identity` may promote, and the
// networks `deploy` accepts.

const ALL_HOSTS_ENV = 'SLV_ALLOW_ALL_HOSTS'

/**
 * Playbooks (by file name) that only read state. These may run against every
 * host of an inventory group without asking. A playbook belongs here only
 * after reading it and finding no task that changes the host.
 */
const READ_ONLY_PLAYBOOKS: ReadonlySet<string> = new Set([
  'doublezero_status.yml',
])

type InventoryHost = {
  name: string
  ansibleHost: string
  identityAccount: string
  voteAccount: string
  ansibleConnection: string
}

type ConfirmOptions = { message: string; default: false }
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const promptConfirm: ConfirmFn = (options) => Confirm.prompt(options)

// --- inventory -------------------------------------------------------------

const asText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value)

const parseInventoryHosts = (
  yamlText: string,
  inventoryType: InventoryType,
): InventoryHost[] => {
  const data = parse(yamlText) as Record<string, unknown> | null
  const group = data?.[inventoryType] as
    | { hosts?: Record<string, Record<string, unknown> | null> }
    | undefined
  return Object.entries(group?.hosts ?? {}).map(([name, entry]) => ({
    name,
    ansibleHost: asText(entry?.ansible_host),
    identityAccount: asText(entry?.identity_account),
    voteAccount: asText(entry?.vote_account),
    ansibleConnection: asText(entry?.ansible_connection),
  }))
}

const readInventoryHosts = async (
  inventoryType: InventoryType,
): Promise<InventoryHost[]> =>
  parseInventoryHosts(
    await Deno.readTextFile(getInventoryPath(inventoryType)),
    inventoryType,
  )

// --- unlimited ansible runs ------------------------------------------------

const playbookBasename = (playbook: string): string =>
  playbook.split(/[\\/]/).pop() ?? playbook

/**
 * True when `--limit` would reach every host of the group: nothing given, a
 * blank value, `all`, `*`, or the group name itself.
 */
const isAllHostsLimit = (
  limit: string | undefined,
  inventoryType: InventoryType,
): boolean => {
  if (limit === undefined) return true
  const value = limit.trim()
  return value === '' || value.toLowerCase() === 'all' || value === '*' ||
    value === inventoryType
}

type AllHostsInput = {
  playbook: string
  inventoryType: InventoryType
  limit: string | undefined
  isTty: boolean
  allowAllHosts: boolean
  confirmed: boolean
}

type AllHostsDecision =
  | {
    action: 'run'
    reason: 'limited' | 'read-only' | 'confirmed' | 'env-override'
  }
  | { action: 'confirm' }
  | { action: 'refuse'; reason: 'non-interactive' }

const decideAllHostsAction = (input: AllHostsInput): AllHostsDecision => {
  if (!isAllHostsLimit(input.limit, input.inventoryType)) {
    return { action: 'run', reason: 'limited' }
  }
  if (READ_ONLY_PLAYBOOKS.has(playbookBasename(input.playbook))) {
    return { action: 'run', reason: 'read-only' }
  }
  if (input.confirmed) return { action: 'run', reason: 'confirmed' }
  if (input.isTty) return { action: 'confirm' }
  if (input.allowAllHosts) return { action: 'run', reason: 'env-override' }
  return { action: 'refuse', reason: 'non-interactive' }
}

type GuardDeps = {
  isTty: () => boolean
  getEnv: (name: string) => string | undefined
  readHosts: (inventoryType: InventoryType) => Promise<InventoryHost[]>
  confirm: ConfirmFn
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const readEnv = (name: string): string | undefined => {
  try {
    return Deno.env.get(name)
  } catch {
    return undefined
  }
}

const defaultGuardDeps = (): GuardDeps => ({
  isTty: () => Deno.stdin.isTerminal(),
  getEnv: readEnv,
  readHosts: readInventoryHosts,
  confirm: promptConfirm,
  info: (line) => console.log(colors.yellow(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

type GuardRequest = {
  playbook: string
  inventoryType: InventoryType
  limit?: string
  /** The caller already listed every target host and got an explicit yes. */
  allHostsConfirmed?: boolean
}

type GuardVerdict =
  | { proceed: true }
  | { proceed: false; reason: 'non-interactive' | 'declined' | 'unresolved' }

/**
 * Decides whether an ansible run may start. A run limited to named hosts, a
 * read-only playbook and a pre-confirmed caller go straight through; any other
 * run that would reach every host of the group needs a yes (default no) on a
 * terminal, or SLV_ALLOW_ALL_HOSTS=1 without one.
 */
const enforceAllHostsGuard = async (
  request: GuardRequest,
  overrides: Partial<GuardDeps> = {},
): Promise<GuardVerdict> => {
  const deps: GuardDeps = { ...defaultGuardDeps(), ...overrides }
  const decision = decideAllHostsAction({
    playbook: request.playbook,
    inventoryType: request.inventoryType,
    limit: request.limit,
    isTty: deps.isTty(),
    allowAllHosts: deps.getEnv(ALL_HOSTS_ENV) === '1',
    confirmed: request.allHostsConfirmed === true,
  })
  if (decision.action === 'run' && decision.reason !== 'env-override') {
    return { proceed: true }
  }

  const playbookName = playbookBasename(request.playbook)
  const group = request.inventoryType

  if (decision.action === 'refuse') {
    deps.error(
      `❌ Refusing to run ${playbookName} on every host of ${group}: no host was named and stdin is not a terminal.`,
    )
    deps.error(
      `   Name the host with -p <host>, or set ${ALL_HOSTS_ENV}=1 to allow every host without a prompt.`,
    )
    deps.setExitCode(1)
    return { proceed: false, reason: 'non-interactive' }
  }

  let hosts: InventoryHost[] = []
  let problem = 'the group has no hosts'
  try {
    hosts = await deps.readHosts(group)
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
  }
  if (hosts.length === 0) {
    deps.error(
      `❌ Not running ${playbookName}: cannot list the hosts of ${group} (${problem}).`,
    )
    deps.setExitCode(1)
    return { proceed: false, reason: 'unresolved' }
  }

  deps.info(
    `⚠️  ${playbookName} will run on ALL ${hosts.length} host(s) of ${group}:`,
  )
  for (const host of hosts) {
    deps.info(`   - ${host.name} (${host.ansibleHost || 'no ansible_host'})`)
  }
  if (decision.action === 'run') {
    deps.info(`   ${ALL_HOSTS_ENV}=1 is set; continuing without a prompt.`)
    return { proceed: true }
  }

  const accepted = await deps.confirm({
    message: `Run ${playbookName} on all ${hosts.length} host(s) of ${group}?`,
    default: false,
  })
  if (!accepted) {
    deps.info('Cancelled...🌝')
    return { proceed: false, reason: 'declined' }
  }
  return { proceed: true }
}

// --- set:identity -----------------------------------------------------------

type SingleHostResult =
  | { ok: true; host: InventoryHost }
  | { ok: false; error: string }

/** The one inventory host a command may act on; rejects a missing value, a list and an unknown name. */
const resolveSingleHostTarget = (
  hosts: readonly InventoryHost[],
  requested: string | undefined,
  inventoryType: InventoryType,
): SingleHostResult => {
  const known = hosts.map((host) => host.name).join(', ') || '(none)'
  const name = (requested ?? '').trim()
  if (name === '') {
    return {
      ok: false,
      error:
        `-p/--pubkey is required: name exactly one host of ${inventoryType} (known: ${known}).`,
    }
  }
  if (name.includes(',')) {
    return {
      ok: false,
      error:
        `-p/--pubkey must name exactly one host, got a list: "${name}" (known: ${known}).`,
    }
  }
  const host = hosts.find((candidate) => candidate.name === name)
  if (!host) {
    return {
      ok: false,
      error: `no host named "${name}" in ${inventoryType} (known: ${known}).`,
    }
  }
  return { ok: true, host }
}

type PromotionConfirmation = 'none' | 'confirm' | 'refuse'

/** A mainnet promotion is confirmed by a person; without a terminal it does not run. */
const decidePromotionConfirmation = (
  network: 'mainnet' | 'testnet',
  isTty: boolean,
): PromotionConfirmation => {
  if (network !== 'mainnet') return 'none'
  return isTty ? 'confirm' : 'refuse'
}

// --- deploy -----------------------------------------------------------------

const DEPLOY_NETWORKS = {
  validator: ['testnet', 'mainnet'],
  rpc: ['mainnet', 'testnet', 'devnet'],
} as const

type DeployKind = keyof typeof DEPLOY_NETWORKS
type DeployNetworkResult<K extends DeployKind> =
  | { ok: true; network: (typeof DEPLOY_NETWORKS)[K][number] }
  | { ok: false; error: string }

/** The deploy network, accepted only as one of the exact lowercase names for that kind of node. */
const parseDeployNetwork = <K extends DeployKind>(
  kind: K,
  value: string | undefined,
): DeployNetworkResult<K> => {
  const accepted: readonly string[] = DEPLOY_NETWORKS[kind]
  if (value !== undefined && accepted.includes(value)) {
    return { ok: true, network: value as (typeof DEPLOY_NETWORKS)[K][number] }
  }
  const shown = value === undefined ? 'no network' : `network "${value}"`
  return {
    ok: false,
    error: `Cannot deploy ${kind} nodes to ${shown}. Use one of: ${
      accepted.join(', ')
    }.`,
  }
}

/** The "Do you want to continue?" step of every deploy; the default answer is no. */
const confirmDeploy = (confirm: ConfirmFn = promptConfirm): Promise<boolean> =>
  confirm({ message: 'Do you want to continue?', default: false })

export {
  ALL_HOSTS_ENV,
  confirmDeploy,
  decideAllHostsAction,
  decidePromotionConfirmation,
  defaultGuardDeps,
  enforceAllHostsGuard,
  isAllHostsLimit,
  parseDeployNetwork,
  parseInventoryHosts,
  playbookBasename,
  promptConfirm,
  READ_ONLY_PLAYBOOKS,
  readInventoryHosts,
  resolveSingleHostTarget,
}
export type {
  AllHostsDecision,
  AllHostsInput,
  ConfirmFn,
  ConfirmOptions,
  DeployKind,
  DeployNetworkResult,
  GuardDeps,
  GuardRequest,
  GuardVerdict,
  InventoryHost,
  PromotionConfirmation,
  SingleHostResult,
}
