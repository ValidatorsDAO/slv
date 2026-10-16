import { parse } from '@std/yaml'
import { colors } from '@cliffy/colors'
import type { CmnType, NetworkType } from '@cmn/types/config.ts'
import { VERSIONS_PATH } from '@cmn/constants/path.ts'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'

// Alpenglow starts on mainnet with epoch 1064, and testnet and devnet already
// run it. An agave, jito or allnodes release older than the floor of its network
// cannot follow it, and neither can a Yellowstone plugin built for one.
// `slv upgrade` keeps the versions an operator pinned in ~/.slv/versions.yml, so
// a pin from before this update can sit below the floor: the commands that
// install a client stop on such a pin, and `slv upgrade` says which pins to
// change. A command given a version of its own (install:solana -v,
// patch:sha256 --solana-version) is checked on that version instead.

/** The oldest agave, jito or allnodes release Alpenglow runs on, per network. */
const ALPENGLOW_FLOORS: Record<NetworkType, string> = {
  mainnet: '4.3.0',
  testnet: '4.4.0-beta.0',
  devnet: '4.4.0-beta.0',
}

type NodeRole = 'validator' | 'rpc'

/** The versions.yml section of each network and role, and the network of each section. */
const SECTION_NETWORKS: Record<string, NetworkType> = {
  mainnet_validators: 'mainnet',
  testnet_validators: 'testnet',
  mainnet_rpcs: 'mainnet',
  testnet_rpcs: 'testnet',
  devnet_rpcs: 'devnet',
}

const PINNED_CLIENT_KEYS = [
  'version_agave',
  'version_jito',
  'version_allnodes_jito',
] as const

const sectionOf = (
  network: string | undefined,
  role: NodeRole,
): string | undefined => {
  const section = `${network}_${role === 'validator' ? 'validators' : 'rpcs'}`
  return section in SECTION_NETWORKS ? section : undefined
}

// --- version comparison -----------------------------------------------------

const PRERELEASE_RANK = { alpha: 0, beta: 1, rc: 2 } as const
const RELEASE_RANK = 3

// 4.3.2, 4.3.0-jito.1, 4.3.2-allnodes, 4.4.0-beta.1, 4.4.0-beta.1-jito, 3.1.1-rc:
// the base release, an optional pre-release (a missing number is 0), and the
// jito or allnodes build tag, which does not change the release the build is
// made on.
const CLIENT_VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.?(\d+)?)?(?:-(?:jito|allnodes)(?:\.\d+)?)?$/

type ParsedVersion = readonly [number, number, number, number, number]

const parseClientVersion = (version: string): ParsedVersion | null => {
  const match = CLIENT_VERSION.exec(version.trim())
  if (!match) return null
  const [, major, minor, patch, pre, preNumber] = match
  return [
    Number(major),
    Number(minor),
    Number(patch),
    pre ? PRERELEASE_RANK[pre as keyof typeof PRERELEASE_RANK] : RELEASE_RANK,
    pre && preNumber ? Number(preNumber) : 0,
  ]
}

/** -1, 0 or 1; null when either version is not one of the forms above. */
const compareClientVersions = (a: string, b: string): number | null => {
  const left = parseClientVersion(a)
  const right = parseClientVersion(b)
  if (!left || !right) return null
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** True when `version` is older than `floor`. A version this cannot read is not below it. */
const isBelowFloor = (version: string, floor: string): boolean =>
  (compareClientVersions(version, floor) ?? 0) < 0

// --- pins ---------------------------------------------------------------------

type BelowFloorPin = {
  section: string
  key: string
  network: NetworkType
  pinned: string
  floor: string
  /** The default for this key, which is at or above the floor. */
  suggested: string
  /** For a Yellowstone tag: the solana release it is built for. */
  builtFor?: string
}

/**
 * The solana release a Yellowstone tag is built for, read the way the floor
 * reads a client version: v17.0.0-rc5+solana.4.4.0.beta.0 is 4.4.0-beta.0. Null
 * when the tag does not say (a richat tag, for one).
 */
const yellowstoneBuiltFor = (tag: string): string | null => {
  const built = /\+solana\.([^+\s]+)/.exec(tag)?.[1]
  return built ? built.replace(/^(\d+\.\d+\.\d+)\./, '$1-') : null
}

/**
 * The agave, jito and allnodes pins of `sections` (all of them by default) that
 * are below the floor of their network, and the Yellowstone geyser_version of
 * an RPC section built for a release below it, each with the default to set
 * instead.
 */
const findBelowFloorPins = (
  versions: unknown,
  defaults: CmnType = defaultVersionsObject(),
  sections: readonly string[] = Object.keys(SECTION_NETWORKS),
): BelowFloorPin[] => {
  const pins: BelowFloorPin[] = []
  const pinnedSections = (versions ?? {}) as Record<string, unknown>
  const defaultSections = defaults as unknown as Record<
    string,
    Record<string, unknown>
  >
  for (const section of sections) {
    const network = SECTION_NETWORKS[section]
    const pinnedSection = pinnedSections[section]
    if (!network || typeof pinnedSection !== 'object' || !pinnedSection) {
      continue
    }
    const floor = ALPENGLOW_FLOORS[network]
    for (const key of PINNED_CLIENT_KEYS) {
      const suggested = defaultSections[section]?.[key]
      const value = (pinnedSection as Record<string, unknown>)[key]
      if (typeof suggested !== 'string') continue
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const pinned = String(value)
      if (isBelowFloor(pinned, floor)) {
        pins.push({ section, key, network, pinned, floor, suggested })
      }
    }
    const geyserDefault = defaultSections[section]?.geyser_version
    const geyserPin = (pinnedSection as Record<string, unknown>).geyser_version
    if (typeof geyserDefault === 'string' && typeof geyserPin === 'string') {
      const builtFor = yellowstoneBuiltFor(geyserPin)
      if (builtFor !== null && isBelowFloor(builtFor, floor)) {
        pins.push({
          section,
          key: 'geyser_version',
          network,
          pinned: geyserPin,
          floor,
          suggested: geyserDefault,
          builtFor,
        })
      }
    }
  }
  return pins
}

const whyFloor = (network: NetworkType, floor: string): string =>
  network === 'mainnet'
    ? `Alpenglow starts on mainnet at epoch 1064 and needs ${floor} or later`
    : `${network} already runs Alpenglow and needs ${floor} or later`

/** One line for `slv upgrade`: the pin, the floor and the value to set. */
const belowFloorNotice = (pin: BelowFloorPin): string =>
  `${pin.section}.${pin.key} is ${pin.pinned} in ~/.slv/versions.yml${
    pin.builtFor ? `, built for solana ${pin.builtFor}` : ''
  }, below ${pin.floor}, the oldest release Alpenglow runs on ${pin.network}. Set it to ${pin.suggested}.`

// --- commands -----------------------------------------------------------------

type FloorDeps = {
  /** The parsed ~/.slv/versions.yml, or null when there is none. */
  readVersions: () => Promise<unknown | null>
  defaults: () => CmnType
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

const readVersionsFile = async (): Promise<unknown | null> => {
  try {
    return parse(await Deno.readTextFile(VERSIONS_PATH))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

const defaultFloorDeps = (): FloorDeps => ({
  readVersions: readVersionsFile,
  defaults: defaultVersionsObject,
  info: (line) => console.log(colors.yellow(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
})

/**
 * Stops a command that installs a client when a pin of its versions.yml section
 * is below the floor. Prints each key to change and the value to set, sets exit
 * code 1 and returns true when it refused. Nothing is refused without a
 * versions.yml: the defaults are written then, and they are not below the floor.
 */
const refuseBelowFloorPins = async (
  network: string | undefined,
  role: NodeRole,
  overrides: Partial<FloorDeps> = {},
): Promise<boolean> => {
  const section = sectionOf(network, role)
  if (!section) return false
  const deps = { ...defaultFloorDeps(), ...overrides }
  const versions = await deps.readVersions()
  if (versions === null) return false
  const pins = findBelowFloorPins(versions, deps.defaults(), [section])
  if (pins.length === 0) return false
  deps.error(
    `❌ ~/.slv/versions.yml pins ${
      pins.length === 1 ? 'a version' : 'versions'
    } older than Alpenglow runs on: ${
      whyFloor(pins[0].network, pins[0].floor)
    }.`,
  )
  deps.error(
    `   Change ${
      pins.length === 1 ? 'this key' : 'these keys'
    } in ~/.slv/versions.yml, then run the command again:`,
  )
  for (const pin of pins) {
    deps.error(
      `   ${pin.section}.${pin.key}: ${pin.pinned} -> ${pin.suggested}`,
    )
  }
  deps.error('   Nothing was changed.')
  deps.setExitCode(1)
  return true
}

/**
 * Stops a command given a client version of its own (install:solana -v,
 * patch:sha256 --solana-version) when that version is below the floor of its
 * network. The pins are not read: this command does not use them. A version it
 * cannot read is not refused.
 */
const refuseVersionBelowFloor = (
  network: string | undefined,
  role: NodeRole,
  version: string,
  flag: string,
  overrides: Partial<FloorDeps> = {},
): Promise<boolean> => {
  const section = sectionOf(network, role)
  if (!section) return Promise.resolve(false)
  const floorNetwork = SECTION_NETWORKS[section]
  const floor = ALPENGLOW_FLOORS[floorNetwork]
  if (!isBelowFloor(version, floor)) return Promise.resolve(false)
  const deps = { ...defaultFloorDeps(), ...overrides }
  const defaults = deps.defaults() as unknown as Record<
    string,
    Record<string, unknown>
  >
  deps.error(
    `❌ ${flag} ${version} is older than Alpenglow runs on: ${
      whyFloor(floorNetwork, floor)
    }.`,
  )
  deps.error(
    `   Use ${floor} or later, such as ${
      defaults[section]?.version_agave
    } for agave or ${defaults[section]?.version_jito} for jito.`,
  )
  deps.error('   Nothing was changed.')
  deps.setExitCode(1)
  return Promise.resolve(true)
}

/**
 * `slv upgrade` keeps the pins in versions.yml; this says, one line per pin, which
 * of them are below the floor. It never fails the command it runs in.
 */
const noticeBelowFloorPins = async (
  overrides: Partial<FloorDeps> = {},
): Promise<BelowFloorPin[]> => {
  const deps = { ...defaultFloorDeps(), ...overrides }
  try {
    const versions = await deps.readVersions()
    if (versions === null) return []
    const pins = findBelowFloorPins(versions, deps.defaults())
    for (const pin of pins) deps.info(`⚠️ ${belowFloorNotice(pin)}`)
    return pins
  } catch {
    return []
  }
}

export {
  ALPENGLOW_FLOORS,
  belowFloorNotice,
  compareClientVersions,
  findBelowFloorPins,
  isBelowFloor,
  noticeBelowFloorPins,
  refuseBelowFloorPins,
  refuseVersionBelowFloor,
  yellowstoneBuiltFor,
}
export type { BelowFloorPin, FloorDeps, NodeRole }
