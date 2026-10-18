import { colors } from '@cliffy/colors'
import { parse } from '@std/yaml'
import type { CmnType, InventoryType } from '@cmn/types/config.ts'
import { getInventoryPath, VERSIONS_PATH } from '@cmn/constants/path.ts'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import {
  CLUSTER_RPC_URLS,
  readAlpenglowState,
  RPC_TIMEOUT_MS,
} from '/lib/alpenglowState.ts'
import { resolveHostAddresses } from '/lib/identityPrecheck.ts'
import {
  checkReadiness,
  formatCheckLine,
  type Level,
  parseValidatorHosts,
  type ReadinessDeps,
  type ReadinessHost,
} from '/lib/alpenglowReadiness.ts'

type CheckAlpenglowOptions = {
  network?: string
  /** Inventory host names, comma separated; every validator of the inventory when absent. */
  pubkey?: string
}

type CheckAlpenglowDeps = ReadinessDeps & {
  /** The text of the inventory file of `group`, or null when there is none. */
  readInventory: (group: InventoryType) => Promise<string | null>
  /** The parsed ~/.slv/versions.yml, or null when there is none. */
  readVersions: () => Promise<unknown | null>
  defaults: () => CmnType
  /** One line of the report; `level` colours the ones that carry a check. */
  print: (line: string, level?: Level) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

const LEVEL_COLOUR: Record<Level, (text: string) => string> = {
  OK: colors.green,
  WARN: colors.yellow,
  FAIL: colors.red,
}

const defaultCheckDeps = (): CheckAlpenglowDeps => ({
  fetch: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readState: (network) => readAlpenglowState(network),
  resolveHost: resolveHostAddresses,
  readInventory: (group) => readIfPresent(getInventoryPath(group)),
  readVersions: async () => {
    const text = await readIfPresent(VERSIONS_PATH)
    return text === null ? null : parse(text)
  },
  defaults: defaultVersionsObject,
  print: (line, level) => console.log(level ? LEVEL_COLOUR[level](line) : line),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * `slv v check:alpenglow`: for each validator of the inventory, one line per
 * check (cluster state, client, the version the node advertises in gossip, BLS
 * key, VAT, identity balance, authorized voter) with OK, WARN or FAIL and the
 * fix. It reads the inventory, ~/.slv/versions.yml and the public RPC of the
 * network and nothing else. Sets exit code 1 when a check FAILs, or when it
 * cannot be run. Returns true when no check failed.
 */
const runCheckAlpenglow = async (
  options: CheckAlpenglowOptions,
  overrides: Partial<CheckAlpenglowDeps> = {},
): Promise<boolean> => {
  const deps: CheckAlpenglowDeps = { ...defaultCheckDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.error(`❌ ${message}`)
    deps.setExitCode(1)
    return false
  }

  const network = options.network ?? 'mainnet'
  if (network !== 'mainnet' && network !== 'testnet') {
    return refuse(
      `check:alpenglow supports -n mainnet or -n testnet, got "${network}".`,
    )
  }
  const group: InventoryType = network === 'mainnet'
    ? 'mainnet_validators'
    : 'testnet_validators'

  let all: ReadinessHost[]
  try {
    const text = await deps.readInventory(group)
    if (text === null) {
      return refuse(
        `no inventory for ${network} validators (${
          getInventoryPath(group)
        }). Create it with slv v init.`,
      )
    }
    all = parseValidatorHosts(text, group)
  } catch (error) {
    return refuse(`cannot read the ${group} inventory: ${describe(error)}`)
  }
  if (all.length === 0) {
    return refuse(`the ${group} inventory has no validators.`)
  }

  const requested = (options.pubkey ?? '').split(',').map((name) => name.trim())
    .filter((name) => name !== '')
  const wholeInventory = requested.length === 0 ||
    (requested.length === 1 && requested[0].toLowerCase() === 'all')
  const known = new Set(all.map((host) => host.name))
  const unknown = wholeInventory
    ? []
    : requested.filter((name) => !known.has(name))
  if (unknown.length > 0) {
    return refuse(
      `no host named ${unknown.join(', ')} in the ${group} inventory (it has ${
        [...known].join(', ')
      }).`,
    )
  }
  const hosts = wholeInventory
    ? all
    : [...new Set(requested)].map((name) =>
      all.find((host) => host.name === name) as ReadinessHost
    )

  let versions: unknown | null
  try {
    versions = await deps.readVersions()
  } catch (error) {
    return refuse(`cannot read ~/.slv/versions.yml: ${describe(error)}`)
  }

  deps.print(
    `Alpenglow readiness on ${network}. Reads ${
      getInventoryPath(group)
    }, ${VERSIONS_PATH} and ${
      CLUSTER_RPC_URLS[network]
    }. No host is contacted and no transaction is made.`,
  )
  const report = await checkReadiness({
    network,
    hosts,
    versions,
    defaults: deps.defaults(),
  }, deps)

  deps.print('')
  deps.print(formatCheckLine(report.cluster), report.cluster.level)
  for (const { host, lines } of report.hosts) {
    deps.print('')
    deps.print(
      `${host.name} (validator_type ${
        host.validatorType || 'not set'
      }, identity ${host.identityAccount || 'not set'}, vote account ${
        host.voteAccount || 'not set'
      })`,
    )
    for (const line of lines) {
      deps.print(`  ${formatCheckLine(line)}`, line.level)
    }
  }
  const { OK, WARN, FAIL } = report.counts
  deps.print('')
  deps.print(
    `${FAIL} FAIL, ${WARN} WARN, ${OK} OK.${
      FAIL > 0 ? ' Not ready: fix every FAIL.' : ''
    }`,
    FAIL > 0 ? 'FAIL' : WARN > 0 ? 'WARN' : 'OK',
  )
  if (FAIL > 0) {
    deps.setExitCode(1)
    return false
  }
  return true
}

export { runCheckAlpenglow }
export type { CheckAlpenglowDeps, CheckAlpenglowOptions }
