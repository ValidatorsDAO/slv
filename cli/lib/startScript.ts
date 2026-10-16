import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import type { InventoryType } from '@cmn/types/config.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import {
  type ExtraVars,
  type RunAnsibleOptions,
  runAnsilbe,
} from '/lib/runAnsible.ts'
import {
  refuseBelowFloorPins,
  refuseVersionBelowFloor,
} from '/lib/versionFloor.ts'

// The agave start script depends on the agave-validator binary on the host (its
// XDP flags follow the installed version). A command that installs, builds or
// replaces that binary therefore ends by running the play that `update:script`
// runs, for the same hosts.

type NodeRole = 'validator' | 'rpc'

const NODE_NETWORKS: Record<NodeRole, readonly string[]> = {
  validator: ['mainnet', 'testnet'],
  rpc: ['mainnet', 'testnet', 'devnet'],
}

type NetworkResult =
  | { ok: true; network: string }
  | { ok: false; error: string }

/** The network, accepted only as one of the exact lowercase names for that kind of node. */
const parseNodeNetwork = (
  role: NodeRole,
  value: string | undefined,
): NetworkResult => {
  const accepted = NODE_NETWORKS[role]
  if (value !== undefined && accepted.includes(value)) {
    return { ok: true, network: value }
  }
  const shown = value === undefined ? 'no network' : `network "${value}"`
  return {
    ok: false,
    error: `Cannot use ${shown} for ${role} nodes. Use one of: ${
      accepted.join(', ')
    }.`,
  }
}

const nodeInventoryType = (role: NodeRole, network: string): InventoryType =>
  `${network}_${role === 'validator' ? 'validators' : 'rpcs'}` as InventoryType

const nodePlaybookDir = (role: NodeRole, network: string): string =>
  `${network}-${role === 'validator' ? 'validator' : 'rpc'}`

/** The play `update:script` runs for a network and role, relative to the template's ansible directory. */
const startScriptPlay = (role: NodeRole, network: string): string =>
  `${nodePlaybookDir(role, network)}/update_startup_config.yml`

type AnsibleRun = (
  playbook: string,
  inventoryType: InventoryType,
  limit?: string,
  extraVars?: ExtraVars,
  options?: RunAnsibleOptions,
) => Promise<boolean>

type StartScriptDeps = {
  run: AnsibleRun
  /** True when the client pins of this network and role are below what Alpenglow runs on; it has said so. */
  refuseBelowFloor: (network: string, role: NodeRole) => Promise<boolean>
  /** True when a client version named on the command line is below what Alpenglow runs on; it has said so. */
  refuseVersionBelowFloor: (
    network: string,
    role: NodeRole,
    version: string,
    flag: string,
  ) => Promise<boolean>
  templateRoot: () => string
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const defaultStartScriptDeps = (): StartScriptDeps => ({
  run: runAnsilbe,
  refuseBelowFloor: (network, role) => refuseBelowFloorPins(network, role),
  refuseVersionBelowFloor: (network, role, version, flag) =>
    refuseVersionBelowFloor(network, role, version, flag),
  templateRoot: getTemplatePath,
  info: (line) => console.log(colors.cyan(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

const quoteArgument = (value: string): string =>
  /^[A-Za-z0-9_.,@%+=:/-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`

type AgaveBinaryChange = {
  role: NodeRole
  network: string | undefined
  /** The play that installs, builds or patches the binary, relative to the template's ansible directory. */
  play: (network: string) => string
  /** The hosts, as the command's -p value: the same hosts get the start script. */
  limit?: string
  extraVars?: ExtraVars
  /** A version the operator named with a flag: it is checked instead of the pins. */
  explicitVersion?: { version: string; flag: string }
}

/**
 * Runs a play that installs, builds or replaces the agave-validator binary and,
 * when it succeeded, the play that renders the start script for the same limit.
 * Returns true when both succeeded. A failed render sets exit code 1 and says
 * that the node must not be restarted until `update:script` succeeds. Nothing
 * runs for a network the role does not have, nor while a pin of the network's
 * versions.yml section is below what Alpenglow runs on. A version named on the
 * command line is checked on its own, and the pins are not looked at then.
 */
const installAgaveBinary = async (
  change: AgaveBinaryChange,
  overrides: Partial<StartScriptDeps> = {},
): Promise<boolean> => {
  const deps: StartScriptDeps = { ...defaultStartScriptDeps(), ...overrides }
  const parsed = parseNodeNetwork(change.role, change.network)
  if (!parsed.ok) {
    deps.error(`❌ ${parsed.error}`)
    deps.setExitCode(1)
    return false
  }
  const network = parsed.network
  // A client below what Alpenglow runs on is not installed: the version the
  // operator named, or else the pins of the network's section.
  const explicit = change.explicitVersion
  const refused = explicit
    ? await deps.refuseVersionBelowFloor(
      network,
      change.role,
      explicit.version,
      explicit.flag,
    )
    : await deps.refuseBelowFloor(network, change.role)
  if (refused) return false
  const inventoryType = nodeInventoryType(change.role, network)
  const ansible = `${deps.templateRoot()}/ansible`

  const installed = await deps.run(
    `${ansible}/${change.play(network)}`,
    inventoryType,
    change.limit,
    change.extraVars,
  )
  if (!installed) return false

  const render = startScriptPlay(change.role, network)
  deps.info(
    `🔧 Updating the start script for the installed binary (${render})...`,
  )
  // The hosts were approved for the play above; this is the same set.
  const rendered = await deps.run(
    `${ansible}/${render}`,
    inventoryType,
    change.limit,
    undefined,
    { allHostsConfirmed: true },
  )
  if (!rendered) {
    const command = `slv ${
      change.role === 'validator' ? 'v' : 'rpc'
    } update:script -n ${network}${
      change.limit ? ` -p ${quoteArgument(change.limit)}` : ''
    }`
    deps.error(
      '❌ The binary was installed but the start script was not updated.',
    )
    deps.error(
      `   Do not restart the node until \`${command}\` succeeds.`,
    )
    deps.setExitCode(1)
    return false
  }
  deps.info('✅ Start script updated for the installed binary.')
  return true
}

type BinaryCommandTexts = {
  buildPubkey: string
  buildNetwork: string
  buildNetworkDefault: string
}

const BINARY_COMMAND_TEXTS: Record<NodeRole, BinaryCommandTexts> = {
  validator: {
    buildPubkey: 'Public Key of Validator.',
    buildNetwork: 'Solana Network',
    buildNetworkDefault: 'testnet',
  },
  rpc: {
    buildPubkey: 'Name of RPC',
    buildNetwork: 'Network to deploy validators',
    buildNetworkDefault: 'mainnet',
  },
}

/**
 * Registers `build:solana`, `build:solana-cli` and `install:solana`. Each one
 * installs the binary and then updates the start script on the same hosts.
 */
const registerSolanaBinaryCommands = (
  parentCmd: Command,
  role: NodeRole,
  deps: Partial<StartScriptDeps> = {},
) => {
  const texts = BINARY_COMMAND_TEXTS[role]
  const build = (options: { pubkey?: string; network?: string }) =>
    installAgaveBinary({
      role,
      network: options.network,
      play: (network) => `${nodePlaybookDir(role, network)}/install_solana.yml`,
      limit: options.pubkey,
    }, deps)

  parentCmd.command('build:solana')
    .description(
      '🛠️ Build Solana CLI from Source, then update the start script',
    )
    .option('-p, --pubkey <pubkey>', texts.buildPubkey)
    .option('-n, --network <network>', texts.buildNetwork, {
      default: texts.buildNetworkDefault,
    })
    .action(async (options) => {
      await build(options)
    })

  parentCmd.command('build:solana-cli')
    .description('🔁 Alias for build:solana')
    .option('-p, --pubkey <pubkey>', texts.buildPubkey)
    .option('-n, --network <network>', texts.buildNetwork, {
      default: texts.buildNetworkDefault,
    })
    .action(async (options) => {
      await build(options)
    })

  parentCmd.command('install:solana')
    .description('➡️ Install Solana CLI Binary, then update the start script')
    .option('-v, --version <version>', 'Solana CLI version to install')
    .option('-p, --pubkey <pubkey>', 'Name of RPC')
    .option('-n, --network <network>', 'Network to deploy validators', {
      default: 'mainnet',
    })
    .action(async (options) => {
      await installAgaveBinary({
        role,
        network: options.network,
        play: () => 'cmn/install_solana.yml',
        limit: options.pubkey,
        extraVars: options.version ? { version: options.version } : undefined,
        explicitVersion: options.version
          ? { version: options.version, flag: 'install:solana -v' }
          : undefined,
      }, deps)
    })
}

export {
  defaultStartScriptDeps,
  installAgaveBinary,
  parseNodeNetwork,
  registerSolanaBinaryCommands,
  startScriptPlay,
}
export type { AgaveBinaryChange, AnsibleRun, NodeRole, StartScriptDeps }
