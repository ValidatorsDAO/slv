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
//
// A value is read as an operator may write it: 4.2 (a YAML number) is 4.2.0,
// 4.2.1.1 is 4.2.1, and a tag this does not know, such as 3.1.10-bam, is read by
// its X.Y.Z. A value with no X.Y at all (latest, main, a commit hash) cannot be
// compared: a pin like that is refused in a mainnet section and warned about in
// the others, and a version typed on the command line is warned about.

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

const compareParsed = (left: ParsedVersion, right: ParsedVersion): number => {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** -1, 0 or 1; null when either version is not one of the forms above. */
const compareClientVersions = (a: string, b: string): number | null => {
  const left = parseClientVersion(a)
  const right = parseClientVersion(b)
  return left && right ? compareParsed(left, right) : null
}

// What an operator may write for a version: X.Y with an optional .Z (4.2 is
// 4.2.0), any further numeric components (ignored), a pre-release this knows,
// and then whatever else (ignored). A pre-release stays, so 4.3.0-beta.3-bam is
// still older than 4.3.0.
const LOOSE_VERSION =
  /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)*(?:-(alpha|beta|rc)\.?(\d+)?)?/

/** The release a pin or a typed version stands for, or null when it has no X.Y. */
const readClientVersion = (value: string): ParsedVersion | null => {
  const match = LOOSE_VERSION.exec(value.trim())
  if (!match) return null
  const [, major, minor, patch, pre, preNumber] = match
  return [
    Number(major),
    Number(minor),
    Number(patch ?? 0),
    pre ? PRERELEASE_RANK[pre as keyof typeof PRERELEASE_RANK] : RELEASE_RANK,
    pre && preNumber ? Number(preNumber) : 0,
  ]
}

/** True when `version` is older than `floor`. A version with no X.Y is not below it. */
const isBelowFloor = (version: string, floor: string): boolean => {
  const read = readClientVersion(version)
  const bar = readClientVersion(floor)
  return read !== null && bar !== null && compareParsed(read, bar) < 0
}

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

/** An agave, jito or allnodes value of versions.yml, and the default to set instead. */
type ClientPin = Omit<BelowFloorPin, 'builtFor'>

type PinnedSection = {
  section: string
  network: NetworkType
  pinned: Record<string, unknown>
  defaults: Record<string, unknown>
}

/** The sections of `sections` that versions.yml sets, with the defaults of each. */
const pinnedSectionsOf = (
  versions: unknown,
  defaults: CmnType,
  sections: readonly string[],
): PinnedSection[] => {
  const pinnedSections = (versions ?? {}) as Record<string, unknown>
  const defaultSections = defaults as unknown as Record<
    string,
    Record<string, unknown>
  >
  return sections.flatMap((section) => {
    const network = SECTION_NETWORKS[section]
    const pinned = pinnedSections[section]
    if (!network || typeof pinned !== 'object' || !pinned) return []
    return [{
      section,
      network,
      pinned: pinned as Record<string, unknown>,
      defaults: defaultSections[section] ?? {},
    }]
  })
}

/**
 * The agave, jito and allnodes values a section sets. A key that is there with
 * nothing in it (`version_agave:`) is a pin that cannot be read; a key that is
 * not there is no pin.
 */
const clientPinsOf = (entry: PinnedSection): ClientPin[] =>
  PINNED_CLIENT_KEYS.flatMap((key) => {
    const suggested = entry.defaults[key]
    const value = entry.pinned[key]
    if (typeof suggested !== 'string') return []
    if (
      value !== null && typeof value !== 'string' && typeof value !== 'number'
    ) {
      return []
    }
    return [{
      section: entry.section,
      key,
      network: entry.network,
      pinned: value === null ? '' : String(value),
      floor: ALPENGLOW_FLOORS[entry.network],
      suggested,
    }]
  })

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
  for (const entry of pinnedSectionsOf(versions, defaults, sections)) {
    for (const pin of clientPinsOf(entry)) {
      if (isBelowFloor(pin.pinned, pin.floor)) pins.push(pin)
    }
    const floor = ALPENGLOW_FLOORS[entry.network]
    const geyserDefault = entry.defaults.geyser_version
    const geyserPin = entry.pinned.geyser_version
    if (typeof geyserDefault === 'string' && typeof geyserPin === 'string') {
      const builtFor = yellowstoneBuiltFor(geyserPin)
      if (builtFor !== null && isBelowFloor(builtFor, floor)) {
        pins.push({
          section: entry.section,
          key: 'geyser_version',
          network: entry.network,
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

/**
 * The agave, jito and allnodes pins of `sections` that are no version number
 * (they have no X.Y: latest, main, a commit hash, or nothing at all), so the
 * floor cannot be checked on them.
 */
const findUnreadablePins = (
  versions: unknown,
  defaults: CmnType = defaultVersionsObject(),
  sections: readonly string[] = Object.keys(SECTION_NETWORKS),
): ClientPin[] =>
  pinnedSectionsOf(versions, defaults, sections)
    .flatMap(clientPinsOf)
    .filter((pin) => readClientVersion(pin.pinned) === null)

const whyFloor = (network: NetworkType, floor: string): string =>
  network === 'mainnet'
    ? `Alpenglow starts on mainnet at epoch 1064 and needs ${floor} or later`
    : `${network} already runs Alpenglow and needs ${floor} or later`

const shown = (value: string): string => value === '' ? '(empty)' : value

/** One line for a pin that is no version number, in a section that only warns. */
const unreadablePinNotice = (pin: ClientPin): string =>
  `${pin.section}.${pin.key} is ${
    shown(pin.pinned)
  } in ~/.slv/versions.yml, which is not a version (X.Y.Z), so it is not checked against ${pin.floor}, the oldest release Alpenglow runs on ${pin.network}. Set it to ${pin.suggested}.`

/** One line for `slv upgrade`: a pin that mainnet commands refuse because it is no version. */
const unreadableMainnetPinNotice = (pin: ClientPin): string =>
  `${pin.section}.${pin.key} is ${
    shown(pin.pinned)
  } in ~/.slv/versions.yml, which is not a version (X.Y.Z), so the mainnet commands refuse it: it cannot be checked against ${pin.floor}, the oldest release Alpenglow runs on mainnet. Set it to ${pin.suggested}.`

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
 * is below the floor, or, in a mainnet section, is no version number at all.
 * Prints each key to change and the value to set, sets exit code 1 and returns
 * true when it refused. In the other sections a value that is no version number
 * is only warned about. Nothing is refused without a versions.yml: the defaults
 * are written then, and they are not below the floor.
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
  const defaults = deps.defaults()
  const pins = findBelowFloorPins(versions, defaults, [section])
  const unreadable = findUnreadablePins(versions, defaults, [section])
  const mainnet = SECTION_NETWORKS[section] === 'mainnet'
  if (!mainnet) {
    for (const pin of unreadable) deps.info(`⚠️ ${unreadablePinNotice(pin)}`)
  }
  const unreadableRefused = mainnet ? unreadable : []
  const keys = [...pins, ...unreadableRefused]
  if (keys.length === 0) return false
  if (pins.length > 0) {
    deps.error(
      `❌ ~/.slv/versions.yml pins ${
        pins.length === 1 ? 'a version' : 'versions'
      } older than Alpenglow runs on: ${
        whyFloor(pins[0].network, pins[0].floor)
      }.`,
    )
  }
  if (unreadableRefused.length > 0) {
    const one = unreadableRefused.length === 1
    deps.error(
      `❌ ~/.slv/versions.yml pins ${one ? 'a value' : 'values'} that ${
        one ? 'is' : 'are'
      } not a version (X.Y.Z): ${
        whyFloor('mainnet', ALPENGLOW_FLOORS.mainnet)
      }, and mainnet takes no value that cannot be checked against that.`,
    )
  }
  deps.error(
    `   Change ${
      keys.length === 1 ? 'this key' : 'these keys'
    } in ~/.slv/versions.yml, then run the command again:`,
  )
  for (const pin of keys) {
    deps.error(
      `   ${pin.section}.${pin.key}: ${shown(pin.pinned)} -> ${pin.suggested}`,
    )
  }
  deps.error('   Nothing was changed.')
  deps.setExitCode(1)
  return true
}

/**
 * Stops a command given a client version of its own (install:solana -v,
 * patch:sha256 --solana-version) when that version is below the floor of its
 * network. The pins are not read: this command does not use them. A version
 * with no X.Y (a commit hash, say) cannot be compared: it is warned about and
 * not refused.
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
  const deps = { ...defaultFloorDeps(), ...overrides }
  if (readClientVersion(version) === null) {
    const defaults = deps.defaults() as unknown as Record<
      string,
      Record<string, unknown>
    >
    const stops = floorNetwork === 'mainnet'
      ? ` The playbook stops a mainnet run with a version it cannot read: use ${floor} or later, such as ${
        defaults[section]?.version_agave
      } for agave or ${defaults[section]?.version_jito} for jito.`
      : ''
    deps.info(
      `⚠️ ${flag} ${version} is not a version (X.Y.Z), so it is not checked against ${floor}, the oldest release Alpenglow runs on ${floorNetwork}.${stops}`,
    )
    return Promise.resolve(false)
  }
  if (!isBelowFloor(version, floor)) return Promise.resolve(false)
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
 * of them are below the floor, and which pins of a mainnet section are no
 * version at all (the mainnet commands refuse those). It returns the pins below
 * the floor. It never fails the command it runs in.
 */
const noticeBelowFloorPins = async (
  overrides: Partial<FloorDeps> = {},
): Promise<BelowFloorPin[]> => {
  const deps = { ...defaultFloorDeps(), ...overrides }
  try {
    const versions = await deps.readVersions()
    if (versions === null) return []
    const defaults = deps.defaults()
    const pins = findBelowFloorPins(versions, defaults)
    for (const pin of pins) deps.info(`⚠️ ${belowFloorNotice(pin)}`)
    for (const pin of findUnreadablePins(versions, defaults)) {
      if (pin.network === 'mainnet') {
        deps.info(`⚠️ ${unreadableMainnetPinNotice(pin)}`)
      }
    }
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
  findUnreadablePins,
  isBelowFloor,
  noticeBelowFloorPins,
  readClientVersion,
  refuseBelowFloorPins,
  refuseVersionBelowFloor,
  yellowstoneBuiltFor,
}
export type { BelowFloorPin, ClientPin, FloorDeps, NodeRole }
