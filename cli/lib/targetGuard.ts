import { parse } from '@std/yaml'
import { Confirm } from '@cliffy/prompt'
import { colors } from '@cliffy/colors'
import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'

// Who and what a CLI command may target: the hosts an ansible run with no
// plain host list would reach, the single host `set:identity` may promote, and
// the networks `deploy` accepts.

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

/** Ansible extra vars, sent as JSON so a boolean stays a boolean. */
type ExtraVars = Record<string, string | boolean>

type ConfirmOptions = { message: string; default: false }
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const readEnv = (name: string): string | undefined => {
  try {
    return Deno.env.get(name)
  } catch {
    return undefined
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// --- confirmations ----------------------------------------------------------

/** What a confirmation needs from its surroundings. Each member can be replaced in a test. */
type ConfirmEnv = {
  isTty: () => boolean
  getEnv: (name: string) => string | undefined
  /** The interactive prompt. Only called when stdin is a terminal. */
  prompt: ConfirmFn
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const defaultConfirmEnv = (): ConfirmEnv => ({
  isTty: () => Deno.stdin.isTerminal(),
  getEnv: readEnv,
  prompt: (options) => Confirm.prompt(options),
  info: (line) => console.log(colors.yellow(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

/**
 * Asks on a terminal. Without one nobody can answer, so the answer is no and
 * the exit code is 1, unless SLV_ALLOW_ALL_HOSTS=1 allows the run without a
 * prompt, in which case it is yes. It never waits for input that cannot come.
 */
const confirmOnTerminal = async (
  options: ConfirmOptions,
  overrides: Partial<ConfirmEnv> = {},
): Promise<boolean> => {
  const env: ConfirmEnv = { ...defaultConfirmEnv(), ...overrides }
  if (env.isTty()) return await env.prompt(options)
  if (env.getEnv(ALL_HOSTS_ENV) === '1') {
    env.info(
      `   stdin is not a terminal and ${ALL_HOSTS_ENV}=1 is set, so "${options.message}" is answered yes.`,
    )
    return true
  }
  env.error(
    `❌ stdin is not a terminal, so "${options.message}" is answered no. Set ${ALL_HOSTS_ENV}=1 to continue without a prompt.`,
  )
  env.setExitCode(1)
  return false
}

const promptConfirm: ConfirmFn = (options) => confirmOnTerminal(options)

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
 * True when `--limit` is one of the plain spellings of the whole group: nothing
 * given, a blank value, `all`, `*`, or the group name itself.
 */
const isWholeGroupLimit = (
  limit: string | undefined,
  inventoryType: InventoryType,
): boolean => {
  if (limit === undefined) return true
  const value = limit.trim()
  return value === '' || value.toLowerCase() === 'all' || value === '*' ||
    value === inventoryType
}

// Characters that turn an element of --limit into an ansible host pattern (a
// wildcard, a regex, a range, an exclusion, an intersection, a file reference)
// or into a separator, instead of a host name.
const NOT_A_PLAIN_NAME = /[*?[\]~:!&@\s]/

/** The names in `limit` when it is a comma-separated list of plain names, else null. */
const parsePlainHostNames = (limit: string | undefined): string[] | null => {
  if (limit === undefined) return null
  const names = limit.split(',').map((name) => name.trim())
  return names.some((name) => name === '' || NOT_A_PLAIN_NAME.test(name))
    ? null
    : names
}

/**
 * True only for a comma-separated list of plain host names that all exist in
 * the inventory group. Every other limit (a pattern, an exclusion, `all`, a
 * group name, a name the inventory does not have) can reach hosts the person
 * did not name.
 */
const isTargetedLimit = (
  limit: string | undefined,
  knownHosts: readonly string[],
): boolean => {
  const names = parsePlainHostNames(limit)
  if (names === null) return false
  const known = new Set(knownHosts)
  return names.every((name) => known.has(name))
}

type AllHostsInput = {
  playbook: string
  inventoryType: InventoryType
  limit: string | undefined
  /** Names of the hosts in the inventory group. */
  knownHosts: readonly string[]
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
  if (isTargetedLimit(input.limit, input.knownHosts)) {
    return { action: 'run', reason: 'limited' }
  }
  if (READ_ONLY_PLAYBOOKS.has(playbookBasename(input.playbook))) {
    return { action: 'run', reason: 'read-only' }
  }
  // A caller's confirmation covers the whole group it listed. It does not
  // cover a pattern or a name it never looked up.
  if (input.confirmed && isWholeGroupLimit(input.limit, input.inventoryType)) {
    return { action: 'run', reason: 'confirmed' }
  }
  if (input.isTty) return { action: 'confirm' }
  if (input.allowAllHosts) return { action: 'run', reason: 'env-override' }
  return { action: 'refuse', reason: 'non-interactive' }
}

type ResolveLimitRequest = {
  playbook: string
  inventoryType: InventoryType
  limit: string
  extraVars?: ExtraVars
}

type ListHostsRunner = (args: string[]) => Promise<{
  success: boolean
  code: number
  stdout: string
  stderr: string
}>

const runListHosts: ListHostsRunner = async (args) => {
  const result = await new Deno.Command('ansible-playbook', {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const decoder = new TextDecoder()
  return {
    success: result.success,
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

/**
 * The host names in the output of `ansible-playbook --list-hosts`: the lines
 * below each `hosts (N):` heading, over all plays, without repeats.
 */
const parseListHostsOutput = (output: string): string[] => {
  const found: string[] = []
  const lines = output.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const heading = /^(\s*)hosts \(\d+\):\s*$/.exec(lines[index])
    if (!heading) continue
    const indent = heading[1].length
    while (index + 1 < lines.length) {
      const line = lines[index + 1]
      if (
        line.trim() === '' || line.length - line.trimStart().length <= indent
      ) {
        break
      }
      const name = line.trim()
      if (!found.includes(name)) found.push(name)
      index++
    }
  }
  return found
}

/**
 * The hosts a limit would reach, as ansible itself resolves it. Runs
 * `ansible-playbook --list-hosts`, which lists the hosts and runs no task.
 */
const listLimitedHosts = async (
  request: ResolveLimitRequest,
  run: ListHostsRunner = runListHosts,
): Promise<string[]> => {
  const args = [
    '-i',
    getInventoryPath(request.inventoryType),
    request.playbook,
    '--limit',
    request.limit,
    '--list-hosts',
  ]
  if (request.extraVars && Object.keys(request.extraVars).length > 0) {
    args.push('--extra-vars', JSON.stringify(request.extraVars))
  }
  const result = await run(args)
  if (!result.success) {
    const reason = result.stderr.split('\n').map((line) =>
      line.trim()
    ).find(Boolean) ??
      `exit code ${result.code}`
    throw new Error(`ansible-playbook --list-hosts failed: ${reason}`)
  }
  return parseListHostsOutput(result.stdout)
}

type GuardDeps = {
  isTty: () => boolean
  getEnv: (name: string) => string | undefined
  readHosts: (inventoryType: InventoryType) => Promise<InventoryHost[]>
  /** The hosts an ansible limit that is not a list of plain names would reach. */
  resolveLimit: (request: ResolveLimitRequest) => Promise<string[]>
  confirm: ConfirmFn
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const defaultGuardDeps = (): GuardDeps => ({
  isTty: () => Deno.stdin.isTerminal(),
  getEnv: readEnv,
  readHosts: readInventoryHosts,
  resolveLimit: (request) => listLimitedHosts(request),
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
  extraVars?: ExtraVars
  /** The caller already listed every host of the group and got an explicit yes. */
  allHostsConfirmed?: boolean
}

type GuardVerdict =
  | { proceed: true }
  | { proceed: false; reason: 'non-interactive' | 'declined' | 'unresolved' }

/**
 * Decides whether an ansible run may start. A run limited to a list of plain
 * host names that all exist in the inventory, a read-only playbook and a
 * whole-group run the caller already confirmed go straight through. Any other
 * run (no limit, `all`, the group name, a pattern, an unknown name) needs a yes
 * (default no) on a terminal after the hosts it reaches are listed, or
 * SLV_ALLOW_ALL_HOSTS=1 without one, and does not run when those hosts cannot
 * be resolved.
 */
const enforceAllHostsGuard = async (
  request: GuardRequest,
  overrides: Partial<GuardDeps> = {},
): Promise<GuardVerdict> => {
  const deps: GuardDeps = { ...defaultGuardDeps(), ...overrides }
  let hosts: InventoryHost[] = []
  let problem = 'the group has no hosts'
  let readProblem: string | undefined
  try {
    hosts = await deps.readHosts(request.inventoryType)
  } catch (error) {
    problem = describeError(error)
    readProblem = problem
  }
  const decision = decideAllHostsAction({
    playbook: request.playbook,
    inventoryType: request.inventoryType,
    limit: request.limit,
    knownHosts: hosts.map((host) => host.name),
    isTty: deps.isTty(),
    allowAllHosts: deps.getEnv(ALL_HOSTS_ENV) === '1',
    confirmed: request.allHostsConfirmed === true,
  })
  if (decision.action === 'run' && decision.reason !== 'env-override') {
    return { proceed: true }
  }

  const playbookName = playbookBasename(request.playbook)
  const group = request.inventoryType
  const wholeGroup = isWholeGroupLimit(request.limit, group)
  const limit = request.limit ?? ''
  const scope = wholeGroup
    ? `every host of ${group}`
    : `the hosts of ${group} matched by --limit ${JSON.stringify(limit)}`

  const named = parsePlainHostNames(request.limit) ?? []
  const missing = named.filter((name) => !hosts.some((h) => h.name === name))

  if (decision.action === 'refuse') {
    const why = wholeGroup
      ? 'no host was named'
      : readProblem !== undefined
      ? `the inventory of ${group} cannot be read (${readProblem})`
      : missing.length > 0
      ? `${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } not in ${group}`
      : 'that limit is not a list of inventory host names'
    deps.error(
      `❌ Refusing to run ${playbookName} on ${scope}: ${why} and stdin is not a terminal.`,
    )
    deps.error(
      `   Name the host with -p <host> (or a comma-separated list of them), or set ${ALL_HOSTS_ENV}=1 to allow ${
        wholeGroup ? 'every host' : 'them'
      } without a prompt.`,
    )
    deps.setExitCode(1)
    return { proceed: false, reason: 'non-interactive' }
  }

  const addresses = new Map(hosts.map((host) => [host.name, host.ansibleHost]))
  let listing: string[] = []
  if (wholeGroup) {
    listing = hosts.map((host) =>
      `   - ${host.name} (${host.ansibleHost || 'no ansible_host'})`
    )
  } else {
    try {
      const matched = await deps.resolveLimit({
        playbook: request.playbook,
        inventoryType: group,
        limit,
        extraVars: request.extraVars,
      })
      listing = matched.map((name) =>
        addresses.has(name)
          ? `   - ${name} (${addresses.get(name) || 'no ansible_host'})`
          : `   - ${name}`
      )
      problem = 'no host matches that limit'
    } catch (error) {
      problem = describeError(error)
    }
  }
  if (listing.length === 0) {
    deps.error(
      `❌ Not running ${playbookName}: cannot list the hosts ${
        wholeGroup
          ? `of ${group}`
          : `of ${group} matched by --limit ${JSON.stringify(limit)}`
      } (${problem}).`,
    )
    deps.setExitCode(1)
    return { proceed: false, reason: 'unresolved' }
  }

  deps.info(
    wholeGroup
      ? `⚠️  ${playbookName} will run on ALL ${listing.length} host(s) of ${group}:`
      : `⚠️  ${playbookName} will run on the ${listing.length} host(s) of ${group} matched by --limit ${
        JSON.stringify(limit)
      }:`,
  )
  for (const line of listing) deps.info(line)
  if (missing.length > 0) {
    deps.info(`   not in ${group}: ${missing.join(', ')}`)
  }
  if (decision.action === 'run') {
    deps.info(`   ${ALL_HOSTS_ENV}=1 is set; continuing without a prompt.`)
    return { proceed: true }
  }

  const accepted = await deps.confirm({
    message: wholeGroup
      ? `Run ${playbookName} on all ${listing.length} host(s) of ${group}?`
      : `Run ${playbookName} on these ${listing.length} host(s) of ${group}?`,
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

/**
 * The "Do you want to continue?" step of every deploy; the default answer is
 * no, and without a terminal the answer is no (see confirmOnTerminal).
 */
const confirmDeploy = (overrides: Partial<ConfirmEnv> = {}): Promise<boolean> =>
  confirmOnTerminal(
    { message: 'Do you want to continue?', default: false },
    overrides,
  )

export {
  ALL_HOSTS_ENV,
  confirmDeploy,
  confirmOnTerminal,
  decideAllHostsAction,
  decidePromotionConfirmation,
  defaultConfirmEnv,
  defaultGuardDeps,
  enforceAllHostsGuard,
  isTargetedLimit,
  isWholeGroupLimit,
  listLimitedHosts,
  parseDeployNetwork,
  parseInventoryHosts,
  parseListHostsOutput,
  parsePlainHostNames,
  playbookBasename,
  promptConfirm,
  READ_ONLY_PLAYBOOKS,
  readInventoryHosts,
  resolveSingleHostTarget,
}
export type {
  AllHostsDecision,
  AllHostsInput,
  ConfirmEnv,
  ConfirmFn,
  ConfirmOptions,
  DeployKind,
  DeployNetworkResult,
  ExtraVars,
  GuardDeps,
  GuardRequest,
  GuardVerdict,
  InventoryHost,
  ListHostsRunner,
  PromotionConfirmation,
  ResolveLimitRequest,
  SingleHostResult,
}
