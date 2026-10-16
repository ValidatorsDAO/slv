import { parse } from '@std/yaml'
import { colors } from '@cliffy/colors'
import type { InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath } from '@cmn/constants/path.ts'
import { isWholeGroupLimit, parsePlainHostNames } from '/lib/targetGuard.ts'

// Alpenglow starts on mainnet with epoch 1064. Firedancer and Frankendancer are
// not supported during the migration, so a mainnet voting validator has to run an
// Agave-based client. A mainnet RPC node with a Frankendancer config is only
// warned about.

const ALPENGLOW_NOTE =
  'Alpenglow starts on mainnet at epoch 1064, and Firedancer and Frankendancer are not supported during the migration.'

const WAY_OUT =
  'Use agave, jito or allnodes-jito instead, and move a node that already runs Firedancer or Frankendancer to one of them with `slv v switch` before epoch 1064.'

/** A validator_type that runs fdctl: Frankendancer (firedancer-agave, firedancer-jito) or Firedancer. */
const isFdctlValidatorType = (validatorType: unknown): boolean => {
  if (typeof validatorType !== 'string') return false
  const type = validatorType.trim().toLowerCase()
  return type === 'frankendancer' || type.startsWith('firedancer')
}

/** Why a mainnet voting validator cannot be of this type, or null when it can. */
const mainnetValidatorTypeRefusal = (validatorType: string): string | null =>
  isFdctlValidatorType(validatorType)
    ? `A mainnet voting validator cannot be ${validatorType}. ${ALPENGLOW_NOTE} ${WAY_OUT}`
    : null

/** Warning for a mainnet RPC node of a Frankendancer type, or null for any other type. */
const mainnetRpcFdctlWarning = (validatorType: string): string | null =>
  isFdctlValidatorType(validatorType)
    ? `${validatorType} is Frankendancer, a hybrid of Firedancer and Agave. Alpenglow starts on mainnet at epoch 1064, and Frankendancer is not supported for the migration, so this RPC node is not supported either. Use agave or jito for a mainnet RPC.`
    : null

type FdctlHost = { name: string; validatorType: string }

type FdctlGuardDeps = {
  /** The text of the inventory file of `group`, or null when there is none. */
  readInventory: (group: InventoryType) => Promise<string | null>
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const readInventoryText = async (
  group: InventoryType,
): Promise<string | null> => {
  try {
    return await Deno.readTextFile(getInventoryPath(group))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

const defaultFdctlGuardDeps = (): FdctlGuardDeps => ({
  readInventory: readInventoryText,
  info: (line) => console.log(colors.yellow(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

/**
 * Prints the refusal and sets exit code 1 when a mainnet voting validator is
 * asked to be of this type. Returns true when it refused.
 */
const refuseMainnetValidatorType = (
  validatorType: string,
  overrides: Partial<FdctlGuardDeps> = {},
): boolean => {
  const refusal = mainnetValidatorTypeRefusal(validatorType)
  if (refusal === null) return false
  const deps = { ...defaultFdctlGuardDeps(), ...overrides }
  deps.error(`❌ ${refusal}`)
  deps.setExitCode(1)
  return true
}

type RawHost = { validator_type?: unknown } | null

/** The hosts of `group` in the inventory text, as they are written. */
const rawHostsOf = (
  inventoryText: string,
  group: InventoryType,
): [string, RawHost][] => {
  const data = parse(inventoryText) as
    | Record<string, { hosts?: Record<string, RawHost> } | null>
    | null
  return Object.entries(data?.[group]?.hosts ?? {})
}

/** The hosts of `group` in the inventory text whose validator_type runs fdctl. */
const fdctlHostsOf = (
  inventoryText: string,
  group: InventoryType,
): FdctlHost[] =>
  rawHostsOf(inventoryText, group).flatMap(([name, entry]) =>
    isFdctlValidatorType(entry?.validator_type)
      ? [{ name, validatorType: String(entry?.validator_type) }]
      : []
  )

/** Every host of `group` in the inventory text, with its validator_type ('' when it has none). */
const validatorHostsOf = (
  inventoryText: string,
  group: InventoryType,
): FdctlHost[] =>
  rawHostsOf(inventoryText, group).map(([name, entry]) => ({
    name,
    validatorType: entry?.validator_type === undefined ||
        entry.validator_type === null
      ? ''
      : String(entry.validator_type),
  }))

/** True for a --limit that is neither the whole group nor a list of plain host names. */
const isPatternLimit = (
  limit: string | undefined,
  group: InventoryType,
): boolean =>
  !isWholeGroupLimit(limit, group) && parsePlainHostNames(limit) === null

/**
 * The hosts `extract` finds in `group` that a run with this --limit reaches. A
 * pattern (an exclusion, a wildcard) can reach any host, so every host of the
 * group counts.
 */
const hostsInTarget = async (
  group: InventoryType,
  limit: string | undefined,
  deps: FdctlGuardDeps,
  extract: (text: string, group: InventoryType) => FdctlHost[],
): Promise<FdctlHost[]> => {
  const text = await deps.readInventory(group)
  if (text === null) return []
  const hosts = extract(text, group)
  const names = parsePlainHostNames(limit)
  return isWholeGroupLimit(limit, group) || names === null
    ? hosts
    : hosts.filter((host) => names.includes(host.name))
}

/** The fdctl hosts of `group` that a run with this --limit reaches. */
const fdctlHostsInTarget = (
  group: InventoryType,
  limit: string | undefined,
  deps: FdctlGuardDeps,
): Promise<FdctlHost[]> => hostsInTarget(group, limit, deps, fdctlHostsOf)

const describeHosts = (hosts: readonly FdctlHost[]): string =>
  hosts.map((host) =>
    `${host.name} (${host.validatorType || 'no validator_type'})`
  )
    .join(', ')

/**
 * Stops `slv v deploy -n mainnet` before anything else when a host it reaches
 * is a Firedancer or Frankendancer validator. Prints why, sets exit code 1 and
 * returns true when it refused. `action` names what was asked for.
 */
const refuseFdctlMainnetValidatorDeploy = async (
  limit?: string,
  overrides: Partial<FdctlGuardDeps> = {},
  action = 'deploy',
): Promise<boolean> => {
  const deps = { ...defaultFdctlGuardDeps(), ...overrides }
  const hosts = await fdctlHostsInTarget('mainnet_validators', limit, deps)
  if (hosts.length === 0) return false
  deps.error(`❌ Refusing to ${action} on mainnet: ${describeHosts(hosts)}.`)
  deps.error(`   ${ALPENGLOW_NOTE}`)
  deps.error(`   ${WAY_OUT}`)
  if (isPatternLimit(limit, 'mainnet_validators')) {
    deps.error(
      '   --limit is a pattern, so every host of mainnet_validators was checked. Name the hosts with -p to deploy only them.',
    )
  }
  deps.error('   Nothing was changed.')
  deps.setExitCode(1)
  return true
}

/**
 * Stops `slv v setup:firedancer` and `slv v update:firedancer` on mainnet
 * whatever the validator_type of the hosts is: the command itself installs
 * Firedancer on the hosts it reaches, and on an agave, jito or allnodes-jito
 * node that puts it next to the validator. Only `-n mainnet` is checked, any
 * other network goes on. The hosts the run reaches are named when the inventory
 * can be read; the refusal does not depend on it.
 */
const refuseFdctlMainnetCommand = async (
  network: string | undefined,
  action: string,
  limit?: string,
  overrides: Partial<FdctlGuardDeps> = {},
): Promise<boolean> => {
  if (network !== 'mainnet') return false
  const deps = { ...defaultFdctlGuardDeps(), ...overrides }
  let reached: FdctlHost[] = []
  try {
    reached = await hostsInTarget(
      'mainnet_validators',
      limit,
      deps,
      validatorHostsOf,
    )
  } catch {
    // An inventory that cannot be read does not make the command safe.
  }
  deps.error(
    `❌ Refusing to ${action} on mainnet${
      reached.length > 0 ? `: ${describeHosts(reached)}` : ''
    }.`,
  )
  deps.error(`   ${ALPENGLOW_NOTE}`)
  deps.error(
    '   The command installs Firedancer on every host it reaches, whatever the validator_type of the host says, so an agave, jito or allnodes-jito host is refused too.',
  )
  deps.error(`   ${WAY_OUT}`)
  deps.error('   Nothing was changed.')
  deps.setExitCode(1)
  return true
}

/**
 * Warns before `slv rpc deploy -n mainnet` about a Frankendancer RPC node it
 * reaches. It does not refuse. Returns the hosts it warned about.
 */
const warnFdctlMainnetRpcDeploy = async (
  limit?: string,
  overrides: Partial<FdctlGuardDeps> = {},
): Promise<FdctlHost[]> => {
  const deps = { ...defaultFdctlGuardDeps(), ...overrides }
  const hosts = await fdctlHostsInTarget('mainnet_rpcs', limit, deps)
  for (const host of hosts) {
    const warning = mainnetRpcFdctlWarning(host.validatorType)
    if (warning) deps.info(`⚠️ ${host.name}: ${warning}`)
  }
  return hosts
}

/**
 * The warning of the RPC init and deploy for `slv rpc setup:firedancer` and
 * `slv rpc update:firedancer`: only `-n mainnet` is looked at, and it never
 * refuses.
 */
const warnFdctlMainnetRpcCommand = (
  network: string | undefined,
  limit?: string,
  overrides: Partial<FdctlGuardDeps> = {},
): Promise<FdctlHost[]> =>
  network === 'mainnet'
    ? warnFdctlMainnetRpcDeploy(limit, overrides)
    : Promise.resolve([])

export {
  isFdctlValidatorType,
  mainnetRpcFdctlWarning,
  mainnetValidatorTypeRefusal,
  refuseFdctlMainnetCommand,
  refuseFdctlMainnetValidatorDeploy,
  refuseMainnetValidatorType,
  warnFdctlMainnetRpcCommand,
  warnFdctlMainnetRpcDeploy,
}
export type { FdctlGuardDeps, FdctlHost }
