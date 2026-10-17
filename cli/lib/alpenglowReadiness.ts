import { parse } from '@std/yaml'
import type { CmnType, InventoryType } from '@cmn/types/config.ts'
import {
  type AlpenglowReading,
  CLUSTER_RPC_URLS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} from '/lib/alpenglowState.ts'
import { isFdctlValidatorType } from '/lib/fdctlMainnetGuard.ts'
import { parseGossipIp } from '/lib/identityPrecheck.ts'
import {
  ALPENGLOW_FLOORS,
  isBelowFloor,
  readClientVersion,
} from '/lib/versionFloor.ts'

// `slv v check:alpenglow`: is each validator of the inventory ready for Alpenglow?
// It reads the inventory, ~/.slv/versions.yml and the public RPC of the network,
// and nothing else: no host is contacted (so the version that runs on a host is
// not read, only the one pinned for it) and no transaction is made. The RPC
// methods it uses are READ_ONLY_METHODS. Where each rule comes from:
//
//   cluster   getAgGenesisCert and the feature account, read as
//             cmn/tasks/alpenglow_state.yml reads them (alpenglowState.ts).
//   client    solana.com/upgrades/alpenglow: run Agave, Jito-Solana or Harmonic
//             Salsa on a release built on Agave 4.3.0; Firedancer and
//             Frankendancer are not supported during the migration. The floor of
//             each network is ALPENGLOW_FLOORS in versionFloor.ts.
//   running   getClusterNodes lists the nodes in gossip with the version each
//             advertises. The node of a host is the one whose gossip address is
//             the address of the host; an identity that is in gossip at another
//             address is a standby that runs its unstaked identity. Firedancer
//             and Frankendancer number their releases on their own scheme
//             (26.10.2), so theirs are not compared with the floor.
//   bls       docs.anza.xyz/operations/guides/vote-accounts: a voting validator
//             must set the BLS public key of its authorized voter on the vote
//             account (solana vote-authorize-voter-checked, solana CLI 4.1.0 or
//             later). solana.com/upgrades/alpenglow: a vote account without one
//             is left out of the set of validators the VAT admits, and its
//             validator stops taking part in consensus.
//   vat       solana.com/upgrades/alpenglow: the VAT is a flat 0.8 SOL per epoch,
//             charged at the start of epoch N for epoch N + 1, the first one at
//             the start of mainnet epoch 1064; it comes out of the vote account
//             only, and a vote account that cannot pay it is not admitted for the
//             next epoch. docs.anza.xyz/operations/guides/vote-accounts: the
//             vote account holds it in addition to its rent-exempt minimum.
//             docs.anza.xyz/consensus/alpenglow: at most 2,000 validators are
//             admitted, the higher stake first.
//   identity  solana.com/upgrades/alpenglow: under TowerBFT voting costs about
//             1 SOL per epoch in vote transaction fees, paid from the identity
//             account; under Alpenglow votes are not transactions and those fees
//             go away.
//   voter     docs.anza.xyz/operations/guides/vote-accounts: for almost all
//             validators the authorized voter is the validator identity. slv adds
//             only the identity keypair to the validator
//             (`agave-validator authorized-voter add`), and Votor votes only when
//             the BLS key derived from the authorized voter keypairs of the
//             validator is the one registered on the vote account (agave
//             votor/src/voting_utils.rs).

type ReadinessNetwork = 'mainnet' | 'testnet'
type Level = 'OK' | 'WARN' | 'FAIL'
type CheckName =
  | 'cluster'
  | 'client'
  | 'running'
  | 'bls'
  | 'vat'
  | 'identity'
  | 'voter'

type CheckLine = {
  check: CheckName
  level: Level
  message: string
  /** What to run or change, for a WARN or FAIL that has a remedy. */
  fix?: string
}

/** The only JSON-RPC methods the check calls. */
const READ_ONLY_METHODS = [
  'getAgGenesisCert',
  'getAccountInfo',
  'getEpochInfo',
  'getMinimumBalanceForRentExemption',
  'getBalance',
  'getClusterNodes',
] as const

const LAMPORTS_PER_SOL = 1_000_000_000
/** The Validator Admission Ticket, per epoch. */
const VAT_LAMPORTS = 800_000_000
/** The vote account is WARNed about when its surplus covers fewer VATs than this. */
const VAT_WARN_EPOCHS = 3
/** What voting costs per epoch under TowerBFT, paid from the identity ("about 1 SOL"). */
const TOWERBFT_VOTE_FEES_PER_EPOCH_LAMPORTS = 1_000_000_000
/** The identity is WARNed about when it holds fewer epochs of TowerBFT vote fees than this. */
const IDENTITY_WARN_EPOCHS = 3
const MAINNET_ACTIVATION_EPOCH = 1064
const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111'

const sol = (lamports: number): string =>
  String(Number((lamports / LAMPORTS_PER_SOL).toFixed(4)))

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// --- the inventory ------------------------------------------------------------

type ReadinessHost = {
  name: string
  /** ansible_host: the address of the host, or a name that resolves to it. */
  ansibleHost: string
  identityAccount: string
  voteAccount: string
  validatorType: string
}

const asText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim()

/** The hosts of `group` in the text of an inventory file. */
const parseValidatorHosts = (
  yamlText: string,
  group: InventoryType,
): ReadinessHost[] => {
  const data = parse(yamlText)
  const hosts = isMapping(data) && isMapping(data[group])
    ? (data[group] as Record<string, unknown>).hosts
    : undefined
  if (!isMapping(hosts)) return []
  return Object.entries(hosts).map(([name, entry]) => {
    const host = isMapping(entry) ? entry : {}
    return {
      name,
      ansibleHost: asText(host.ansible_host),
      identityAccount: asText(host.identity_account),
      voteAccount: asText(host.vote_account),
      validatorType: asText(host.validator_type),
    }
  })
}

// --- reading the RPC ----------------------------------------------------------

type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

type ReadinessDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  /** Which consensus the cluster runs, read as alpenglow_state.yml reads it. */
  readState: (network: ReadinessNetwork) => Promise<AlpenglowReading>
  /** The IP addresses an ansible_host stands for. */
  resolveHost: (host: string) => Promise<string[]>
}

/** One JSON-RPC read, tried again while the RPC does not answer with a result. */
const rpcRead = async (
  deps: ReadinessDeps,
  url: string,
  method: (typeof READ_ONLY_METHODS)[number],
  params: unknown[],
): Promise<Read<unknown>> => {
  let reason = 'no answer'
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(DEFAULT_RETRY_DELAY_MS)
    try {
      const response = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!response.ok) {
        reason = `HTTP ${response.status}`
        continue
      }
      const body: unknown = await response.json()
      if (!isMapping(body)) {
        reason = 'no JSON answer'
        continue
      }
      if ('error' in body) {
        const error = body.error
        reason = `JSON-RPC error${
          isMapping(error) && typeof error.message === 'string'
            ? `: ${error.message}`
            : ''
        }`
        continue
      }
      if (!('result' in body)) {
        reason = 'no result'
        continue
      }
      return { ok: true, value: body.result }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, reason: `${method}: ${reason}` }
}

const unexpected = (method: string): Read<never> => ({
  ok: false,
  reason: `${method}: unexpected answer`,
})

const readEpoch = async (
  deps: ReadinessDeps,
  url: string,
): Promise<Read<number>> => {
  const answer = await rpcRead(deps, url, 'getEpochInfo', [{
    commitment: 'confirmed',
  }])
  if (!answer.ok) return answer
  const epoch = isMapping(answer.value) ? answer.value.epoch : undefined
  return Number.isInteger(epoch)
    ? { ok: true, value: epoch as number }
    : unexpected('getEpochInfo')
}

const readBalance = async (
  deps: ReadinessDeps,
  url: string,
  pubkey: string,
): Promise<Read<number>> => {
  const answer = await rpcRead(deps, url, 'getBalance', [pubkey, {
    commitment: 'confirmed',
  }])
  if (!answer.ok) return answer
  const value = isMapping(answer.value) ? answer.value.value : undefined
  return typeof value === 'number' && value >= 0
    ? { ok: true, value }
    : unexpected('getBalance')
}

const readRentExempt = async (
  deps: ReadinessDeps,
  url: string,
  space: number,
): Promise<Read<number>> => {
  const answer = await rpcRead(deps, url, 'getMinimumBalanceForRentExemption', [
    space,
  ])
  if (!answer.ok) return answer
  return typeof answer.value === 'number' && answer.value >= 0
    ? { ok: true, value: answer.value }
    : unexpected('getMinimumBalanceForRentExemption')
}

type AuthorizedVoter = { epoch: number; voter: string }

type VoteAccount = {
  lamports: number
  space: number
  nodePubkey: string
  /** The BLS public key registered on the vote account, or null when there is none. */
  blsPubkey: string | null
  authorizedVoters: AuthorizedVoter[]
}

/** The vote account behind a getAccountInfo answer in jsonParsed encoding. */
const parseVoteAccount = (account: unknown): Read<VoteAccount> => {
  const bad = (reason: string): Read<VoteAccount> => ({
    ok: false,
    reason: `getAccountInfo: ${reason}`,
  })
  if (!isMapping(account)) return bad('unexpected answer')
  if (account.owner !== VOTE_PROGRAM_ID) {
    return bad(`the account is not owned by the vote program`)
  }
  const data = account.data
  const parsed = isMapping(data) ? data.parsed : undefined
  const info = isMapping(parsed) ? parsed.info : undefined
  if (
    !isMapping(data) || data.program !== 'vote' || !isMapping(parsed) ||
    parsed.type !== 'vote' || !isMapping(info)
  ) return bad('the RPC did not parse a vote account')
  const space = typeof account.space === 'number'
    ? account.space
    : isMapping(data) && typeof data.space === 'number'
    ? data.space
    : undefined
  if (typeof account.lamports !== 'number' || space === undefined) {
    return bad('no balance or size in the answer')
  }
  if (
    typeof info.nodePubkey !== 'string' || !Array.isArray(info.authorizedVoters)
  ) {
    return bad('no node identity or authorized voters in the answer')
  }
  const authorizedVoters: AuthorizedVoter[] = []
  for (const entry of info.authorizedVoters) {
    if (
      !isMapping(entry) || typeof entry.authorizedVoter !== 'string' ||
      typeof entry.epoch !== 'number'
    ) return bad('an authorized voter entry cannot be read')
    authorizedVoters.push({ epoch: entry.epoch, voter: entry.authorizedVoter })
  }
  const bls = info.blsPubkeyCompressed
  return {
    ok: true,
    value: {
      lamports: account.lamports,
      space,
      nodePubkey: info.nodePubkey,
      blsPubkey: typeof bls === 'string' && bls.length > 0 ? bls : null,
      authorizedVoters,
    },
  }
}

/** The vote account at `address`, or null when there is none on the cluster. */
const readVoteAccount = async (
  deps: ReadinessDeps,
  url: string,
  address: string,
): Promise<Read<VoteAccount | null>> => {
  const answer = await rpcRead(deps, url, 'getAccountInfo', [address, {
    encoding: 'jsonParsed',
    commitment: 'confirmed',
  }])
  if (!answer.ok) return answer
  if (!isMapping(answer.value) || !('value' in answer.value)) {
    return unexpected('getAccountInfo')
  }
  if (answer.value.value === null) return { ok: true, value: null }
  return parseVoteAccount(answer.value.value)
}

/** A node of the gossip table: its identity, the IP it gossips from and the version it advertises. */
type GossipNode = { pubkey: string; ip: string | null; version: string | null }

const readGossip = async (
  deps: ReadinessDeps,
  url: string,
): Promise<Read<GossipNode[]>> => {
  const answer = await rpcRead(deps, url, 'getClusterNodes', [])
  if (!answer.ok) return answer
  if (!Array.isArray(answer.value)) return unexpected('getClusterNodes')
  const nodes: GossipNode[] = []
  for (const item of answer.value) {
    if (!isMapping(item) || typeof item.pubkey !== 'string') continue
    nodes.push({
      pubkey: item.pubkey,
      ip: parseGossipIp(item.gossip),
      version: typeof item.version === 'string' ? item.version : null,
    })
  }
  return { ok: true, value: nodes }
}

// --- the checks ---------------------------------------------------------------

/**
 * check:alpenglow reads mainnet unless -n says otherwise, so the advice to run
 * it again names the network of this run.
 */
const checkAgain = (network: ReadinessNetwork): string =>
  `run slv v check:alpenglow -n ${network} again`

/** 1. What the cluster runs, and what that means for identity changes. */
const clusterLine = (
  network: ReadinessNetwork,
  reading: AlpenglowReading,
  epoch: number | null,
): CheckLine => {
  const again = `${
    checkAgain(network)
  } after getAgGenesisCert returns a certificate`
  switch (reading.state) {
    case 'towerbft': {
      const until = network === 'mainnet' && epoch !== null &&
          epoch < MAINNET_ACTIVATION_EPOCH
        ? ` (epoch ${epoch}; it activates at the start of epoch ${MAINNET_ACTIVATION_EPOCH}, ${
          MAINNET_ACTIVATION_EPOCH - epoch
        } epoch${MAINNET_ACTIVATION_EPOCH - epoch === 1 ? '' : 's'} from now)`
        : ''
      return {
        check: 'cluster',
        level: 'OK',
        message:
          `TowerBFT: the Alpenglow feature is not active on ${network}${until}. Identity changes (slv v switch, slv v set:identity) go on as before.`,
      }
    }
    case 'imminent':
      return {
        check: 'cluster',
        level: 'WARN',
        message:
          `the Alpenglow activation is about to start on ${network} (the feature is pending and fewer than ${reading.marginSlots} slots are left in the epoch). Identity changes are refused until the genesis certificate exists.`,
        fix: again,
      }
    case 'window':
      return {
        check: 'cluster',
        level: 'WARN',
        message:
          `migration window: the Alpenglow feature is active on ${network} and getAgGenesisCert returns no certificate yet. Identity changes are refused until it does.`,
        fix: again,
      }
    case 'alpenglow':
      return {
        check: 'cluster',
        level: 'OK',
        message:
          `Alpenglow: the genesis certificate exists on ${network}. Identity changes move the vote history file (vote_history-<identity>.bin) instead of the tower; with the old primary down use slv v set:identity -n ${network} -p <host> --primary-down.`,
      }
    case 'unknown':
      return {
        check: 'cluster',
        level: 'WARN',
        message:
          `the state of ${network} cannot be read (${reading.detail}). Identity changes are refused while it cannot be read.`,
        fix: `${checkAgain(network)}; the public RPC may be rate limiting`,
      }
  }
}

const upgradeCommands = (
  network: ReadinessNetwork,
  host: ReadinessHost,
): string =>
  `slv v build:solana -n ${network} -p ${host.name}, then slv v update:script -n ${network} -p ${host.name} and slv v restart -n ${network} -p ${host.name}`

const VERSION_KEYS: Record<string, string> = {
  agave: 'version_agave',
  jito: 'version_jito',
  'allnodes-jito': 'version_allnodes_jito',
}

type PinSource = { value: string; fromFile: boolean }

/** The version versions.yml pins for `key`, or the default that applies without one. */
const pinOf = (
  versions: unknown,
  defaults: CmnType,
  section: string,
  key: string,
): PinSource | null => {
  const pinnedSection = isMapping(versions) ? versions[section] : undefined
  const pinned = isMapping(pinnedSection) ? pinnedSection[key] : undefined
  if (typeof pinned === 'string' || typeof pinned === 'number') {
    return { value: String(pinned), fromFile: true }
  }
  // A key with nothing in it is a pin that cannot be read, as the floor reads it.
  if (pinned === null) return { value: '', fromFile: true }
  const fallback =
    (defaults as unknown as Record<string, Record<string, unknown>>)[
      section
    ]?.[key]
  return typeof fallback === 'string'
    ? { value: fallback, fromFile: false }
    : null
}

/** 2. A client Alpenglow runs on, at or above the floor of the network. */
const clientLine = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  versions: unknown,
  defaults: CmnType,
): CheckLine => {
  const section = `${network}_validators`
  const type = host.validatorType
  const supported = Object.keys(VERSION_KEYS)
  if (!supported.includes(type)) {
    if (isFdctlValidatorType(type)) {
      if (network === 'testnet') {
        return {
          check: 'client',
          level: 'WARN',
          message:
            `validator_type ${type} (Firedancer or Frankendancer): slv does not move the identity of such a node while testnet runs Alpenglow, because where it keeps the vote history file is unconfirmed. Mainnet does not support it at all during the migration.`,
          fix:
            `use agave, jito or allnodes-jito for a node that has to move its identity, and move it with slv v switch -n ${network}`,
        }
      }
      return {
        check: 'client',
        level: 'FAIL',
        message:
          `validator_type ${type} cannot be a mainnet voting validator: Alpenglow starts on mainnet at epoch ${MAINNET_ACTIVATION_EPOCH}, and Firedancer and Frankendancer are not supported during the migration.`,
        fix:
          `set validator_type to agave, jito or allnodes-jito in the inventory, and move the node to one of them with slv v switch -n ${network} before epoch ${MAINNET_ACTIVATION_EPOCH}`,
      }
    }
    return {
      check: 'client',
      level: 'FAIL',
      message: type === ''
        ? 'the inventory has no validator_type for this host.'
        : `validator_type ${type} is not one slv supports for a validator (${
          supported.join(', ')
        }).`,
      fix: `set validator_type to ${supported.join(', ')} in the inventory`,
    }
  }

  const key = VERSION_KEYS[type]
  const pin = pinOf(versions, defaults, section, key)
  if (pin === null) {
    return {
      check: 'client',
      level: 'WARN',
      message:
        `no ${section}.${key} pin or default to check against the floor.`,
    }
  }
  const floor = ALPENGLOW_FLOORS[network]
  const where = pin.fromFile
    ? `${section}.${key} is ${
      pin.value === '' ? '(empty)' : pin.value
    } in ~/.slv/versions.yml`
    : `no ${section}.${key} in ~/.slv/versions.yml, so the default ${pin.value} applies`
  const suggested = pinOf({}, defaults, section, key)?.value ?? floor
  const upgrade = upgradeCommands(network, host)
  if (readClientVersion(pin.value) === null) {
    const mainnet = network === 'mainnet'
    return {
      check: 'client',
      level: mainnet ? 'FAIL' : 'WARN',
      message:
        `${where}, which is not a version (X.Y.Z), so it cannot be checked against ${floor}, the oldest release Alpenglow runs on ${network}.`,
      fix:
        `set ${section}.${key} to ${suggested} in ~/.slv/versions.yml, then ${upgrade}`,
    }
  }
  if (isBelowFloor(pin.value, floor)) {
    return {
      check: 'client',
      level: 'FAIL',
      message:
        `${where}, below ${floor}, the oldest release Alpenglow runs on ${network}.`,
      fix:
        `set ${section}.${key} to ${suggested} in ~/.slv/versions.yml, then ${upgrade}`,
    }
  }
  return {
    check: 'client',
    level: 'OK',
    message:
      `${type}: ${where}, at or above ${floor}, the oldest release Alpenglow runs on ${network}. The version running on the host is not read.`,
  }
}

const isLoopback = (ip: string): boolean =>
  ip.startsWith('127.') || ip === '::1'

/** 2b. The version the node of the host advertises in gossip. */
const runningLine = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  gossip: Read<GossipNode[]> | null,
  addresses: readonly string[],
  pin: PinSource | null,
): CheckLine => {
  const floor = ALPENGLOW_FLOORS[network]
  const section = `${network}_validators`
  if (host.identityAccount === '' || gossip === null) {
    return {
      check: 'running',
      level: 'WARN',
      message:
        'not checked: the inventory has no identity_account (see identity).',
    }
  }
  if (!gossip.ok) {
    return {
      check: 'running',
      level: 'WARN',
      message:
        `the gossip table of ${network} cannot be read (${gossip.reason}), so the version the node runs was not checked.`,
      fix: checkAgain(network),
    }
  }
  const entries = gossip.value.filter((node) =>
    node.pubkey === host.identityAccount
  )
  if (entries.length === 0) {
    return {
      check: 'running',
      level: 'WARN',
      message:
        `the identity is not in the gossip table of ${network}: the node is stopped, or it runs its unstaked identity (a standby on its unstaked key is not visible), so the version it runs was not read.`,
    }
  }
  // The node of this host is the one that gossips from the address of the host.
  const own = addresses.filter((ip) => !isLoopback(ip))
  const mine = own.length > 0
    ? entries.filter((node) => node.ip !== null && own.includes(node.ip))
    : entries
  if (mine.length === 0) {
    const elsewhere = [
      ...new Set(entries.map((node) => node.ip ?? 'no address')),
    ]
    return {
      check: 'running',
      level: 'OK',
      message: `the identity is in gossip at ${
        elsewhere.join(', ')
      }, not at this host (${host.ansibleHost}): a standby on its unstaked key is not visible, so the version it runs was not read.`,
    }
  }
  const compared = own.length > 0
    ? ''
    : ` (the address of this host cannot be compared with gossip, so the node of the identity is taken to be this host's)`
  const version = mine[0].version
  if (isFdctlValidatorType(host.validatorType)) {
    return {
      check: 'running',
      level: 'OK',
      message: `the node advertises ${
        version ?? 'no version'
      }; Firedancer and Frankendancer number their releases on their own scheme, so it is not compared with the floor of ${network}${compared}.`,
    }
  }
  if (version === null || readClientVersion(version) === null) {
    return {
      check: 'running',
      level: 'WARN',
      message: `the node advertises ${
        version ?? 'no version'
      }, which is not a version (X.Y.Z), so it cannot be checked against ${floor}${compared}.`,
    }
  }
  const upgrade = upgradeCommands(network, host)
  const pinFine = pin !== null && readClientVersion(pin.value) !== null &&
    !isBelowFloor(pin.value, floor)
  if (isBelowFloor(version, floor)) {
    return {
      check: 'running',
      level: network === 'mainnet' ? 'FAIL' : 'WARN',
      message:
        `the node advertises ${version}, below ${floor}, the oldest release Alpenglow runs on ${network}${compared}.`,
      fix: `${
        pinFine ? '' : 'set the pin first (see client), then '
      }${upgrade}`,
    }
  }
  const key = VERSION_KEYS[host.validatorType]
  if (
    pin !== null && readClientVersion(pin.value) !== null &&
    (isBelowFloor(version, pin.value) || isBelowFloor(pin.value, version))
  ) {
    return {
      check: 'running',
      level: 'WARN',
      message: `pinned ${pin.value}${
        pin.fromFile ? '' : ' (the default)'
      }, running ${version}${compared}.`,
      fix:
        `to run the pin: ${upgrade}; or set ${section}.${key} to ${version} in ~/.slv/versions.yml if that is the version you want`,
    }
  }
  return {
    check: 'running',
    level: 'OK',
    message: `the node advertises ${version}${
      pin !== null ? `, the pinned ${pin.value}` : ''
    }, at or above ${floor}, the oldest release Alpenglow runs on ${network}${compared}.`,
  }
}

type VoteRead = Read<VoteAccount | null>

type Problem = { level: Level; message: string; fix?: string }

/** The vote account of a host, or why a check that needs it cannot be made. */
const resolveVote = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  vote: VoteRead | null,
): { account: VoteAccount } | { problem: Problem } => {
  if (vote === null) {
    return {
      problem: {
        level: 'FAIL',
        message: 'the inventory has no vote_account for this host.',
        fix:
          `set vote_account in the inventory (slv v gen:vote-account -n ${network} creates a vote account)`,
      },
    }
  }
  if (!vote.ok) {
    return {
      problem: {
        level: 'FAIL',
        message:
          `the vote account ${host.voteAccount} cannot be read (${vote.reason}), so the BLS key, the VAT and the authorized voter cannot be checked.`,
        fix: checkAgain(network),
      },
    }
  }
  if (vote.value === null) {
    return {
      problem: {
        level: 'FAIL',
        message:
          `the vote account ${host.voteAccount} does not exist on ${network}.`,
        fix:
          `correct vote_account in the inventory, or create the vote account (slv v gen:vote-account -n ${network})`,
      },
    }
  }
  return { account: vote.value }
}

const notChecked = (check: CheckName): CheckLine => ({
  check,
  level: 'WARN',
  message: 'not checked: the vote account could not be used (see bls).',
})

/** 3. The vote account has a BLS public key. */
const blsLine = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  vote: VoteRead | null,
  voterOk: boolean,
): CheckLine => {
  const resolved = resolveVote(host, network, vote)
  if ('problem' in resolved) return { check: 'bls', ...resolved.problem }
  const { account } = resolved
  if (account.blsPubkey !== null) {
    return {
      check: 'bls',
      level: 'OK',
      message: `the vote account has a BLS public key (${
        account.blsPubkey.slice(0, 8)
      }...).`,
    }
  }
  return {
    check: 'bls',
    level: 'FAIL',
    message:
      `the vote account has no BLS public key: a validator without one is excluded from the Validator Admission Ticket set and stops participating in consensus once Alpenglow is active.`,
    fix: `${
      voterOk
        ? ''
        : 'make the identity the authorized voter first (see voter), then '
    }run slv v register:bls -n ${network} -p ${host.name} (it needs solana CLI 4.1.0 or later and the identity keypair in ~/.slv/keys)`,
  }
}

/** 4. The vote account can pay the Validator Admission Ticket. */
const vatLine = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  vote: VoteRead | null,
  rentExempt: Read<number> | null,
  state: AlpenglowReading['state'],
  epoch: number | null,
): CheckLine => {
  const resolved = resolveVote(host, network, vote)
  if ('problem' in resolved) return notChecked('vat')
  if (rentExempt === null || !rentExempt.ok) {
    return {
      check: 'vat',
      level: 'FAIL',
      message: `the rent-exempt minimum of the vote account cannot be read (${
        rentExempt === null ? 'no size' : rentExempt.reason
      }), so the VAT surplus cannot be worked out.`,
      fix: checkAgain(network),
    }
  }
  const { account } = resolved
  const surplus = Math.max(0, account.lamports - rentExempt.value)
  const epochs = Math.floor(surplus / VAT_LAMPORTS)
  const when = network === 'mainnet' && epoch !== null &&
      (state === 'towerbft' || state === 'imminent') &&
      epoch < MAINNET_ACTIVATION_EPOCH
    ? `the first VAT is charged at the start of epoch ${MAINNET_ACTIVATION_EPOCH} for admission in ${
      MAINNET_ACTIVATION_EPOCH + 1
    }`
    : 'a VAT is charged at the start of every epoch for the next one'
  const held = `the vote account holds ${
    sol(surplus)
  } SOL above its rent-exempt minimum (${
    sol(rentExempt.value)
  } SOL), which covers ${epochs} epoch${
    epochs === 1 ? '' : 's'
  } of the VAT (0.8 SOL per epoch, taken from the vote account only); ${when}.`
  if (epochs < 1) {
    return {
      check: 'vat',
      level: 'FAIL',
      message:
        `${held} With less than one VAT the validator is not admitted for the next epoch.`,
      fix: `send at least ${
        sol(VAT_LAMPORTS - surplus)
      } SOL to the vote account ${host.voteAccount}, not to the identity (${
        sol(VAT_WARN_EPOCHS * VAT_LAMPORTS - surplus)
      } SOL keeps ${VAT_WARN_EPOCHS} epochs covered)`,
    }
  }
  if (epochs < VAT_WARN_EPOCHS) {
    return {
      check: 'vat',
      level: 'WARN',
      message: `${held} It is a warning below ${VAT_WARN_EPOCHS} epochs (${
        sol(VAT_WARN_EPOCHS * VAT_LAMPORTS)
      } SOL).`,
      fix: `send ${
        sol(VAT_WARN_EPOCHS * VAT_LAMPORTS - surplus)
      } SOL or more to the vote account ${host.voteAccount}, not to the identity`,
    }
  }
  return { check: 'vat', level: 'OK', message: held }
}

/** 5. The identity can pay what it still pays for. */
const identityLine = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  balance: Read<number> | null,
  state: AlpenglowReading['state'],
): CheckLine => {
  if (balance === null) {
    return {
      check: 'identity',
      level: 'FAIL',
      message: 'the inventory has no identity_account for this host.',
      fix: 'set identity_account in the inventory',
    }
  }
  if (!balance.ok) {
    return {
      check: 'identity',
      level: 'WARN',
      message:
        `the balance of the identity ${host.identityAccount} cannot be read (${balance.reason}).`,
      fix: checkAgain(network),
    }
  }
  const held = `the identity holds ${sol(balance.value)} SOL.`
  if (state === 'alpenglow') {
    return {
      check: 'identity',
      level: 'OK',
      message:
        `${held} Under Alpenglow votes are not transactions, so the identity no longer pays vote fees (the VAT comes from the vote account).`,
    }
  }
  const needed = IDENTITY_WARN_EPOCHS * TOWERBFT_VOTE_FEES_PER_EPOCH_LAMPORTS
  const pays =
    'Under TowerBFT it pays the vote transaction fees, about 1 SOL per epoch, and that goes on until Votor takes over; under Alpenglow those fees go away.'
  if (balance.value < needed) {
    return {
      check: 'identity',
      level: 'WARN',
      message:
        `${held} ${pays} It is a warning below ${IDENTITY_WARN_EPOCHS} epochs of fees (${
          sol(needed)
        } SOL).`,
      fix: `send ${
        sol(needed - balance.value)
      } SOL or more to the identity ${host.identityAccount}`,
    }
  }
  return { check: 'identity', level: 'OK', message: `${held} ${pays}` }
}

/** The authorized voter in force at `epoch`: the latest entry that has begun. */
const voterAt = (
  voters: readonly AuthorizedVoter[],
  epoch: number | null,
): AuthorizedVoter | null => {
  const sorted = [...voters].sort((a, b) => a.epoch - b.epoch)
  if (sorted.length === 0) return null
  if (epoch === null) return sorted[sorted.length - 1]
  const begun = sorted.filter((entry) => entry.epoch <= epoch)
  return begun.length > 0 ? begun[begun.length - 1] : sorted[0]
}

/** 6. The authorized voter of the vote account is the identity slv adds to the validator. */
const voterLine = (
  host: ReadinessHost,
  network: ReadinessNetwork,
  vote: VoteRead | null,
  epoch: number | null,
): CheckLine => {
  const resolved = resolveVote(host, network, vote)
  if ('problem' in resolved) return notChecked('voter')
  if (host.identityAccount === '') {
    return {
      check: 'voter',
      level: 'WARN',
      message:
        'not checked: the inventory has no identity_account (see identity).',
    }
  }
  const { account } = resolved
  const current = voterAt(account.authorizedVoters, epoch)
  if (current === null) {
    return {
      check: 'voter',
      level: 'FAIL',
      message: 'the vote account lists no authorized voter.',
    }
  }
  const sorted = [...account.authorizedVoters].sort((a, b) => a.epoch - b.epoch)
  const last = sorted[sorted.length - 1]
  const rpc = CLUSTER_RPC_URLS[network]
  const expected = host.identityAccount
  if (current.voter === expected && last.voter === expected) {
    return {
      check: 'voter',
      level: 'OK',
      message: 'the authorized voter of the vote account is the identity.',
    }
  }
  if (current.voter === expected) {
    return {
      check: 'voter',
      level: 'WARN',
      message:
        `the authorized voter is the identity now, but it changes to ${last.voter} at epoch ${last.epoch}.`,
      fix:
        `if that is not intended, authorize the identity again: solana vote-authorize-voter-checked ${host.voteAccount} <keypair of the authorized voter or the withdraw authority> ~/.slv/keys/${expected}.json --url ${rpc}`,
    }
  }
  if (last.voter === expected) {
    return {
      check: 'voter',
      level: 'WARN',
      message:
        `the authorized voter is ${current.voter} now and becomes the identity at epoch ${last.epoch}.`,
      fix:
        `wait for epoch ${last.epoch}, then run slv v register:bls -n ${network} -p ${host.name} if the BLS public key is not set`,
    }
  }
  return {
    check: 'voter',
    level: 'FAIL',
    message:
      `the authorized voter is ${current.voter}, not the identity ${expected}. slv adds only the identity keypair to the validator, and Votor votes only when the BLS key derived from the validator's authorized voter keypairs is the one registered on the vote account.`,
    fix:
      `authorize the identity: solana vote-authorize-voter-checked ${host.voteAccount} <keypair of the authorized voter or the withdraw authority> ~/.slv/keys/${expected}.json --url ${rpc}, then slv v register:bls -n ${network} -p ${host.name}`,
  }
}

// --- the report -----------------------------------------------------------------

type HostReport = { host: ReadinessHost; lines: CheckLine[] }

type ReadinessReport = {
  network: ReadinessNetwork
  epoch: number | null
  cluster: CheckLine
  hosts: HostReport[]
  counts: Record<Level, number>
}

type ReadinessInput = {
  network: ReadinessNetwork
  hosts: readonly ReadinessHost[]
  /** The parsed ~/.slv/versions.yml, or null when there is none (the defaults apply). */
  versions: unknown | null
  defaults: CmnType
}

/** Runs the six checks for `hosts`. It only reads. */
const checkReadiness = async (
  input: ReadinessInput,
  deps: ReadinessDeps,
): Promise<ReadinessReport> => {
  const { network } = input
  const url = CLUSTER_RPC_URLS[network]
  const reading = await deps.readState(network)
  const epochRead = await readEpoch(deps, url)
  const epoch = epochRead.ok ? epochRead.value : null
  const cluster = clusterLine(network, reading, epoch)

  // Hosts that share a vote account, an identity or a vote account size are read once.
  const votes = new Map<string, VoteRead>()
  const balances = new Map<string, Read<number>>()
  const rents = new Map<number, Read<number>>()
  const addressesOf = new Map<string, string[]>()
  let gossip: Read<GossipNode[]> | null = null
  const hosts: HostReport[] = []
  for (const host of input.hosts) {
    let vote: VoteRead | null = null
    if (host.voteAccount !== '') {
      vote = votes.get(host.voteAccount) ?? null
      if (vote === null) {
        vote = await readVoteAccount(deps, url, host.voteAccount)
        votes.set(host.voteAccount, vote)
      }
    }
    let rentExempt: Read<number> | null = null
    if (vote !== null && vote.ok && vote.value !== null) {
      rentExempt = rents.get(vote.value.space) ?? null
      if (rentExempt === null) {
        rentExempt = await readRentExempt(deps, url, vote.value.space)
        rents.set(vote.value.space, rentExempt)
      }
    }
    let balance: Read<number> | null = null
    if (host.identityAccount !== '') {
      balance = balances.get(host.identityAccount) ?? null
      if (balance === null) {
        balance = await readBalance(deps, url, host.identityAccount)
        balances.set(host.identityAccount, balance)
      }
    }
    if (host.identityAccount !== '' && gossip === null) {
      gossip = await readGossip(deps, url)
    }
    let addresses = addressesOf.get(host.ansibleHost)
    if (addresses === undefined) {
      try {
        addresses = host.ansibleHost === ''
          ? []
          : (await deps.resolveHost(host.ansibleHost)).map((ip) =>
            ip.toLowerCase()
          )
      } catch {
        addresses = []
      }
      addressesOf.set(host.ansibleHost, addresses)
    }
    const section = `${network}_validators`
    const pin = Object.keys(VERSION_KEYS).includes(host.validatorType)
      ? pinOf(
        input.versions,
        input.defaults,
        section,
        VERSION_KEYS[host.validatorType],
      )
      : null
    const voter = voterLine(host, network, vote, epoch)
    hosts.push({
      host,
      lines: [
        clientLine(host, network, input.versions, input.defaults),
        runningLine(host, network, gossip, addresses, pin),
        blsLine(host, network, vote, voter.level === 'OK'),
        vatLine(host, network, vote, rentExempt, reading.state, epoch),
        identityLine(host, network, balance, reading.state),
        voter,
      ],
    })
  }

  const counts: Record<Level, number> = { OK: 0, WARN: 0, FAIL: 0 }
  for (const line of [cluster, ...hosts.flatMap((entry) => entry.lines)]) {
    counts[line.level]++
  }
  return { network, epoch, cluster, hosts, counts }
}

/** One line of the report: the level, the check, what was found and the fix. */
const formatCheckLine = (line: CheckLine): string =>
  `${line.level.padEnd(4)}  ${line.check.padEnd(8)}  ${line.message}${
    line.fix ? ` Fix: ${line.fix}.` : ''
  }`

export {
  checkReadiness,
  formatCheckLine,
  parseValidatorHosts,
  READ_ONLY_METHODS,
  VAT_LAMPORTS,
}
export type {
  CheckLine,
  CheckName,
  HostReport,
  Level,
  ReadinessDeps,
  ReadinessHost,
  ReadinessInput,
  ReadinessNetwork,
  ReadinessReport,
}
