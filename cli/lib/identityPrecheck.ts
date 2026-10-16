import { colors } from '@cliffy/colors'
import { Input } from '@cliffy/prompt'
import type { InventoryType } from '@cmn/types/config.ts'
import {
  type AlpenglowReading,
  checkAlpenglowState,
  type Consensus,
  readAlpenglowState,
} from '/lib/alpenglowState.ts'
import { getTemplatePath } from '/lib/getTemplatePath.ts'
import {
  type ExtraVars,
  runAnsibleCapture,
  runAnsilbe,
} from '/lib/runAnsible.ts'
import {
  type ConfirmFn,
  decidePromotionConfirmation,
  type InventoryHost,
  promptConfirm,
  readInventoryHosts,
  resolveSingleHostTarget,
} from '/lib/targetGuard.ts'

// Checks run before `slv v set:identity` promotes a host, and the command flow
// around them. Every check that cannot get an answer counts as a refusal.

type IdentityNetwork = 'mainnet' | 'testnet'

// Public RPC endpoints, as in registerBlsPubkey.ts.
const RPC_URLS: Record<IdentityNetwork, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  testnet: 'https://api.testnet.solana.com',
}

const RPC_TIMEOUT_MS = 20_000
const RUNNING_IDENTITY_PLAYBOOK = 'cmn/read_running_identity.yml'

// A vote of the vote account this recent means that someone is voting with the
// identity. Only the vote counts: the root slot of a vote account is no sign of
// life under Alpenglow (on testnet, 3 of 459 active validators did not move
// their root in 400 s while their last vote advanced by 1,798 slots).
//
// towerbft: 150 slots, the age at which a vote transaction signed before its
//   sender stopped can no longer land (MAX_PROCESSING_AGE).
// alpenglow: a vote is not a transaction, so MAX_PROCESSING_AGE bounds nothing.
//   On testnet (4.4.0-beta.1, 2026-10-16) the lastVote of an active validator
//   was within -2 to +9 slots of the confirmed slot in 9,639 readings of 459
//   validators over 400 s, and a delinquent one was at least 45,409 slots
//   behind, so any window above 10 slots tells a voting identity from a stopped
//   one. 270 slots is one minute at the 4.5 slots/s measured there, as 150
//   slots were at 400 ms per slot.
const TOWERBFT_VOTE_WINDOW_SLOTS = 150
const ALPENGLOW_VOTE_WINDOW_SLOTS = 270
const RECENT_VOTE_WINDOW_SLOTS = TOWERBFT_VOTE_WINDOW_SLOTS

const voteWindowSlots = (consensus: Consensus): number =>
  consensus === 'alpenglow'
    ? ALPENGLOW_VOTE_WINDOW_SLOTS
    : TOWERBFT_VOTE_WINDOW_SLOTS

type PrecheckInput = {
  network: IdentityNetwork
  inventoryType: InventoryType
  target: InventoryHost
  /** Every host of the inventory group, the target included. */
  hosts: readonly InventoryHost[]
  peerDownConfirmed: boolean
  /** The consensus of the cluster; towerbft when absent. */
  consensus?: Consensus
  /** The inventory name of the peer the operator confirmed to be stopped. */
  downPeer?: string
}

type PrecheckResult = {
  ok: boolean
  failures: string[]
  notes: string[]
  /**
   * The address of a stale gossip entry of the identity that the precheck
   * allowed (see judgeForeignEntry). set:identity hands it to the playbook as
   * primary_down_address. Absent unless the precheck is ok and allowed one.
   */
  staleAddress?: string
}

type PrecheckDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  resolveHost: (host: string) => Promise<string[]>
  runCapture: (
    playbook: string,
    inventoryType: InventoryType,
    limit: string,
  ) => Promise<{ success: boolean; output: string }>
  /** Absolute path of cmn/read_running_identity.yml in the installed template. */
  playbookPath: string
}

// --- addresses --------------------------------------------------------------

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

const looksLikeIp = (value: string): boolean =>
  IPV4.test(value) || (value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value))

const isLoopback = (ip: string): boolean =>
  ip.startsWith('127.') || ip === '::1'

/** The IP in a gossip "ip:port" value, or null when there is none. */
const parseGossipIp = (gossip: unknown): string | null => {
  if (typeof gossip !== 'string' || gossip.length === 0) return null
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(gossip)
  if (bracketed) return bracketed[1].toLowerCase()
  const colons = gossip.split(':').length - 1
  return colons === 1
    ? gossip.slice(0, gossip.indexOf(':'))
    : gossip.toLowerCase()
}

/** IP addresses for an ansible_host value: the value itself when it is an IP, else its A and AAAA records. */
const resolveHostAddresses = async (host: string): Promise<string[]> => {
  if (looksLikeIp(host)) return [host.toLowerCase()]
  if (host === 'localhost') return ['127.0.0.1', '::1']
  const found = new Set<string>()
  for (const recordType of ['A', 'AAAA'] as const) {
    try {
      for (const ip of await Deno.resolveDns(host, recordType)) {
        found.add(ip.toLowerCase())
      }
    } catch {
      // The name has no record of this type.
    }
  }
  return [...found]
}

// --- JSON-RPC ---------------------------------------------------------------

const rpcRequest = async (
  deps: PrecheckDeps,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> => {
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}`)
  }
  const body = await response.json() as {
    result?: unknown
    error?: { message?: string }
  }
  if (body.error) {
    throw new Error(
      `${method} failed: ${body.error.message ?? 'unknown error'}`,
    )
  }
  if (body.result === undefined) throw new Error(`${method} returned no result`)
  return body.result
}

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null
    )
    : []

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// --- peer output --------------------------------------------------------------

/**
 * Reads `SLV_RUNNING_IDENTITY <host> <pubkey|unknown>` lines out of the output
 * of cmn/read_running_identity.yml, including lines wrapped in ansible debug
 * output. Returns every value reported per host.
 */
const parseRunningIdentityLines = (output: string): Map<string, string[]> => {
  const reports = new Map<string, string[]>()
  const line =
    /SLV_RUNNING_IDENTITY\s+([^\s"'\\,]+)\s+(unknown|[1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])/g
  for (const match of output.matchAll(line)) {
    const values = reports.get(match[1]) ?? []
    values.push(match[2])
    reports.set(match[1], values)
  }
  return reports
}

// --- the checks ---------------------------------------------------------------

/** The other hosts of the inventory that hold the target's identity. */
const peersHoldingIdentity = (
  target: InventoryHost,
  hosts: readonly InventoryHost[],
): InventoryHost[] =>
  hosts.filter((host) =>
    host.name !== target.name && host.identityAccount === target.identityAccount
  )

type Collected = { failures: string[]; notes: string[] }

/** What the running-identity read says about one peer. */
type PeerState = 'runs-identity' | 'other-identity' | 'unread'

const consensusLabel = (consensus: Consensus): string =>
  consensus === 'alpenglow' ? 'Alpenglow' : 'TowerBFT'

/** The vote account's last vote, read before the gossip entries are judged. */
type VoteReading =
  | { kind: 'skipped' }
  | { kind: 'failed'; error: string }
  | { kind: 'read'; lastVote: number; age: number }

const readVote = async (
  input: PrecheckInput,
  deps: PrecheckDeps,
): Promise<VoteReading> => {
  const { target } = input
  if (target.voteAccount === '') return { kind: 'skipped' }
  const rpcUrl = RPC_URLS[input.network]
  try {
    const votes = await rpcRequest(deps, rpcUrl, 'getVoteAccounts', [{
      votePubkey: target.voteAccount,
      commitment: 'confirmed',
    }]) as { current?: unknown; delinquent?: unknown }
    const slot = await rpcRequest(deps, rpcUrl, 'getSlot', [{
      commitment: 'confirmed',
    }])
    if (typeof slot !== 'number') throw new Error('getSlot returned no slot')
    if (
      typeof votes !== 'object' || votes === null ||
      !Array.isArray(votes.current) || !Array.isArray(votes.delinquent)
    ) {
      throw new Error('getVoteAccounts returned no vote account lists')
    }
    const lastVote = Math.max(
      0,
      ...[...asRecords(votes.current), ...asRecords(votes.delinquent)]
        .filter((vote) => vote.votePubkey === target.voteAccount)
        .map((vote) => typeof vote.lastVote === 'number' ? vote.lastVote : 0),
    )
    return { kind: 'read', lastVote, age: Math.max(0, slot - lastVote) }
  } catch (error) {
    return { kind: 'failed', error: describe(error) }
  }
}

/**
 * The addresses the ansible_host of each peer stands for. A peer whose
 * ansible_host is empty or does not resolve has none, and so can never be
 * matched to a gossip entry.
 */
const resolvePeerAddresses = async (
  peers: readonly InventoryHost[],
  deps: PrecheckDeps,
): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>()
  for (const peer of peers) {
    let ips: string[] = []
    if (peer.ansibleHost !== '') {
      try {
        ips = (await deps.resolveHost(peer.ansibleHost)).map((ip) =>
          ip.toLowerCase()
        )
      } catch {
        // Left empty: the peer cannot be matched to an address.
      }
    }
    found.set(peer.name, ips)
  }
  return found
}

type GossipContext = {
  identity: string
  target: InventoryHost
  peers: readonly InventoryHost[]
  peerAddresses: ReadonlyMap<string, string[]>
  peerStates: ReadonlyMap<string, PeerState>
  downPeer: string | undefined
  peerDownConfirmed: boolean
  vote: VoteReading
  consensus: Consensus
}

type GossipVerdict =
  | { allowed: false; failure: string }
  | { allowed: true; note: string }

/** How a peer is known to be down, or null when nothing shows it. */
const howDown = (peer: InventoryHost, ctx: GossipContext): string | null => {
  const state = ctx.peerStates.get(peer.name)
  if (state === 'other-identity') return 'running another identity'
  if (state === 'unread') {
    if (peer.name === ctx.downPeer) {
      return 'named as stopped with --primary-down'
    }
    if (ctx.peerDownConfirmed) {
      return 'confirmed stopped with --peer-down-confirmed'
    }
  }
  return null
}

/**
 * Judges one gossip entry of the identity at an address that is not the
 * target's. A staked node stays in gossip for up to 2 days after it stops, so
 * such an entry is the stale entry of a stopped host, and not a second
 * instance, only when all three hold: the address is that of an inventory host
 * that shares the identity, that host is down (it reads another identity, or
 * the operator named or confirmed it stopped), and nothing votes with the
 * identity (the last vote of the vote account is older than the vote window of
 * the consensus). Anything that cannot be shown is a refusal.
 */
const judgeForeignEntry = (ip: string, ctx: GossipContext): GossipVerdict => {
  const { identity, vote } = ctx
  const refuse = (failure: string): GossipVerdict => ({
    allowed: false,
    failure,
  })
  const names = (peers: readonly InventoryHost[]): string =>
    peers.map((peer) => peer.name).join(', ')

  const owners = ctx.peers.filter((peer) =>
    (ctx.peerAddresses.get(peer.name) ?? []).includes(ip)
  )
  if (owners.length === 0) {
    const holders = ctx.peers.length === 0
      ? 'no other host of the inventory holds it'
      : ctx.peers.map((peer) => {
        const addresses = ctx.peerAddresses.get(peer.name) ?? []
        if (addresses.length > 0) {
          return `${peer.name} is at ${addresses.join(', ')}`
        }
        return peer.ansibleHost === ''
          ? `${peer.name} has no ansible_host`
          : `${peer.name}: ansible_host ${peer.ansibleHost} does not resolve`
      }).join('; ')
    return refuse(
      `identity ${identity} is already in gossip at ${ip}, which is not an inventory host of this identity (${holders}); stop it there first`,
    )
  }

  const running = owners.filter((owner) =>
    ctx.peerStates.get(owner.name) === 'runs-identity'
  )
  if (running.length > 0) {
    return refuse(
      `identity ${identity} is already in gossip at ${ip}, the address of ${
        names(running)
      }, which is running it; stop it there first`,
    )
  }
  const down: { peer: InventoryHost; how: string }[] = []
  const notDown: InventoryHost[] = []
  for (const owner of owners) {
    const how = howDown(owner, ctx)
    if (how === null) notDown.push(owner)
    else down.push({ peer: owner, how })
  }
  if (notDown.length > 0) {
    return refuse(
      `identity ${identity} is already in gossip at ${ip}, the address of ${
        names(notDown)
      }, whose running identity could not be read; if it is stopped, name it with --primary-down or run with --peer-down-confirmed, otherwise stop it there first`,
    )
  }

  const window = voteWindowSlots(ctx.consensus)
  const unproven = (reason: string): GossipVerdict =>
    refuse(
      `identity ${identity} is already in gossip at ${ip}, the address of ${
        names(owners)
      }, but ${reason}; stop it there first`,
    )
  if (vote.kind === 'skipped') {
    return unproven(
      `${ctx.target.name} has no vote_account in the inventory, so nothing shows that the entry is stale`,
    )
  }
  if (vote.kind === 'failed') {
    return unproven(
      `the vote account could not be read (${vote.error}), so nothing shows that the entry is stale`,
    )
  }
  if (vote.lastVote === 0) {
    return unproven(
      `vote account ${ctx.target.voteAccount} has no vote on record, so nothing shows that the entry is stale`,
    )
  }
  if (vote.age <= window) {
    return unproven(
      `vote account ${ctx.target.voteAccount} voted ${vote.age} slot(s) ago (slot ${vote.lastVote}), within the ${window} slots of ${
        consensusLabel(ctx.consensus)
      }, so something still votes with the identity and the entry is not stale`,
    )
  }
  return {
    allowed: true,
    note: `identity ${identity} is in gossip at ${ip}, the stale entry of ${
      down.map((owner) => `${owner.peer.name} (${owner.how})`).join(', ')
    }; the vote account last voted ${vote.age} slots ago, more than the ${window} slots of ${
      consensusLabel(ctx.consensus)
    }, so nothing votes with it. A staked node stays in gossip for up to 2 days after it stops`,
  }
}

/**
 * Compares the gossip table and the vote account with the target. Returns the
 * address of the stale gossip entry it allowed, when it allowed one.
 */
const checkClusterView = async (
  input: PrecheckInput,
  deps: PrecheckDeps,
  out: Collected,
  peers: readonly InventoryHost[],
  peerStates: ReadonlyMap<string, PeerState>,
): Promise<string | undefined> => {
  const { target, network } = input
  const identity = target.identityAccount
  const rpcUrl = RPC_URLS[network]

  if (target.ansibleHost === '') {
    out.failures.push(
      `${target.name} has no ansible_host, so its address cannot be compared with the cluster's gossip table`,
    )
    return undefined
  }
  let targetIps: string[] = []
  try {
    targetIps = (await deps.resolveHost(target.ansibleHost)).map((ip) =>
      ip.toLowerCase()
    )
  } catch {
    // Left empty: reported below.
  }
  if (
    target.ansibleConnection === 'local' ||
    (targetIps.length > 0 && targetIps.every(isLoopback))
  ) {
    out.failures.push(
      `${target.name} is reached over a local connection (ansible_host ${target.ansibleHost}), so its address cannot be compared with the cluster's gossip table`,
    )
    return undefined
  }
  if (targetIps.length === 0) {
    out.failures.push(
      `cannot resolve ansible_host ${target.ansibleHost} of ${target.name} to an IP address, so it cannot be compared with the cluster's gossip table`,
    )
    return undefined
  }

  // Both tables are read before anything is said: a gossip entry at another
  // address is judged by the last vote.
  let gossip: { ips: (string | null)[] } | { error: string }
  try {
    const nodes = await rpcRequest(deps, rpcUrl, 'getClusterNodes', [])
    if (!Array.isArray(nodes)) {
      throw new Error('getClusterNodes returned no list')
    }
    gossip = {
      ips: asRecords(nodes)
        .filter((node) => node.pubkey === identity)
        .map((entry) => parseGossipIp(entry.gossip)),
    }
  } catch (error) {
    gossip = { error: describe(error) }
  }
  const vote = await readVote(input, deps)
  const consensus = input.consensus ?? 'towerbft'

  // null until the gossip table has been read.
  let identityAtTarget: boolean | null = null
  let staleAddress: string | undefined
  if ('error' in gossip) {
    out.failures.push(
      `could not read the gossip table from ${rpcUrl}: ${gossip.error}`,
    )
  } else {
    identityAtTarget = false
    if (gossip.ips.length === 0) {
      out.notes.push(`identity ${identity} is not in the gossip table`)
    }
    const stale: { ip: string; note: string }[] = []
    const judged = new Set<string>()
    let context: GossipContext | null = null
    for (const ip of gossip.ips) {
      if (ip === null) {
        out.failures.push(
          `identity ${identity} is in the gossip table without an address`,
        )
      } else if (targetIps.includes(ip)) {
        identityAtTarget = true
        out.notes.push(
          `identity ${identity} is in gossip at ${ip}, the address of ${target.name}`,
        )
      } else if (!judged.has(ip)) {
        judged.add(ip)
        context ??= {
          identity,
          target,
          peers,
          peerAddresses: await resolvePeerAddresses(peers, deps),
          peerStates,
          downPeer: input.downPeer,
          peerDownConfirmed: input.peerDownConfirmed,
          vote,
          consensus,
        }
        const verdict = judgeForeignEntry(ip, context)
        if (verdict.allowed) stale.push({ ip, note: verdict.note })
        else out.failures.push(verdict.failure)
      }
    }
    if (stale.length === 1) {
      out.notes.push(stale[0].note)
      staleAddress = stale[0].ip
    } else if (stale.length > 1) {
      out.failures.push(
        `identity ${identity} is in gossip at ${
          stale.map((entry) => entry.ip).join(' and ')
        }, each the stale entry of a stopped host; the playbook takes one such address (primary_down_address), so set:identity does not go on with ${stale.length}`,
      )
    }
  }

  if (vote.kind === 'skipped') {
    out.notes.push(
      `${target.name} has no vote_account in the inventory; the vote check was skipped`,
    )
  } else if (vote.kind === 'failed') {
    out.failures.push(
      `could not read the vote account from ${rpcUrl}: ${vote.error}`,
    )
  } else if (vote.lastVote === 0) {
    out.notes.push(`vote account ${target.voteAccount} has no vote on record`)
  } else if (vote.age > voteWindowSlots(consensus)) {
    out.notes.push(
      `vote account ${target.voteAccount} last voted ${vote.age} slots ago`,
    )
  } else if (identityAtTarget === true) {
    out.notes.push(
      `vote account ${target.voteAccount} voted ${vote.age} slots ago, from ${target.name}`,
    )
  } else if (identityAtTarget === false) {
    out.failures.push(
      `vote account ${target.voteAccount} voted ${vote.age} slot(s) ago (slot ${vote.lastVote}) but identity ${identity} is not in gossip at ${target.name}; another host may be voting with it`,
    )
  } else {
    out.failures.push(
      `vote account ${target.voteAccount} voted ${vote.age} slot(s) ago (slot ${vote.lastVote}) and the gossip table could not be read to show that ${target.name} is the one voting`,
    )
  }
  return staleAddress
}

/** Reads what each peer runs. Returns the state of every peer it could judge. */
const checkPeers = async (
  input: PrecheckInput,
  peers: readonly InventoryHost[],
  deps: PrecheckDeps,
  out: Collected,
): Promise<Map<string, PeerState>> => {
  const states = new Map<string, PeerState>()
  if (peers.length === 0) return states
  const identity = input.target.identityAccount
  let output = ''
  try {
    const result = await deps.runCapture(
      deps.playbookPath,
      input.inventoryType,
      peers.map((peer) => peer.name).join(','),
    )
    output = result.output
  } catch (error) {
    out.notes.push(`reading the peer hosts failed: ${describe(error)}`)
  }
  const reports = parseRunningIdentityLines(output)
  const unread: string[] = []
  for (const peer of peers) {
    const values = [
      ...(reports.get(peer.name) ?? []),
      ...(reports.get(peer.ansibleHost) ?? []),
    ]
    if (values.includes(identity)) {
      states.set(peer.name, 'runs-identity')
      out.failures.push(
        `peer ${peer.name} (${peer.ansibleHost}) is running identity ${identity}; stop it there first`,
      )
    } else if (values.every((value) => value === 'unknown')) {
      states.set(peer.name, 'unread')
      unread.push(peer.name)
    } else {
      states.set(peer.name, 'other-identity')
      out.notes.push(`peer ${peer.name} runs a different identity`)
    }
  }
  // The peer the operator named as stopped may stay unread; one that answers
  // and runs the identity was caught above.
  const confirmedDown = unread.filter((name) => name === input.downPeer)
  if (confirmedDown.length > 0) {
    out.notes.push(
      `could not read ${
        confirmedDown.join(', ')
      }; continuing because you confirmed it is stopped`,
    )
  }
  const stillUnread = unread.filter((name) => name !== input.downPeer)
  if (stillUnread.length === 0) return states
  if (input.peerDownConfirmed) {
    out.notes.push(
      `could not read ${
        stillUnread.join(', ')
      }; continuing because --peer-down-confirmed was given`,
    )
  } else {
    out.failures.push(
      `could not read the running identity of ${
        stillUnread.join(', ')
      } (reported unknown or printed nothing). If that host is confirmed not to be running ${identity}, run again with --peer-down-confirmed`,
    )
  }
  return states
}

const defaultPrecheckDeps = (): PrecheckDeps => ({
  fetch: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  resolveHost: resolveHostAddresses,
  runCapture: (playbook, inventoryType, limit) =>
    runAnsibleCapture(playbook, inventoryType, limit),
  playbookPath: `${getTemplatePath()}/ansible/${RUNNING_IDENTITY_PLAYBOOK}`,
})

/**
 * Looks for any sign that the target's identity is already running somewhere
 * else: the cluster's gossip table, the vote account's recent votes, and the
 * inventory peers that hold the same identity.
 *
 * A staked node stays in the gossip table for up to 2 days after it stops, so
 * an entry of the identity at the address of a stopped peer is no sign of a
 * second instance when nothing votes with the identity (judgeForeignEntry).
 */
const runIdentityPrecheck = async (
  input: PrecheckInput,
  deps: PrecheckDeps = defaultPrecheckDeps(),
): Promise<PrecheckResult> => {
  const out: Collected = { failures: [], notes: [] }
  const { target } = input
  if (target.identityAccount === '') {
    out.failures.push(`${target.name} has no identity_account in the inventory`)
    return { ok: false, ...out }
  }
  const peers = peersHoldingIdentity(target, input.hosts)
  // The peers are read first, because a gossip entry at a peer's address is
  // judged by whether that peer is down. Their lines follow the cluster's.
  const peerOut: Collected = { failures: [], notes: [] }
  const peerStates = await checkPeers(input, peers, deps, peerOut)
  const staleAddress = await checkClusterView(
    input,
    deps,
    out,
    peers,
    peerStates,
  )
  out.failures.push(...peerOut.failures)
  out.notes.push(...peerOut.notes)
  const ok = out.failures.length === 0
  return {
    ok,
    ...out,
    ...(ok && staleAddress !== undefined ? { staleAddress } : {}),
  }
}

// --- the command --------------------------------------------------------------

type SetIdentityOptions = {
  network?: string
  pubkey?: string
  firstActivation?: boolean
  peerDownConfirmed?: boolean
  /** The other host that holds this identity is stopped and cannot vote. */
  primaryDown?: boolean
}

type SetIdentityDeps = {
  isTty: () => boolean
  readHosts: (inventoryType: InventoryType) => Promise<InventoryHost[]>
  precheck: (input: PrecheckInput) => Promise<PrecheckResult>
  confirm: ConfirmFn
  runPlaybook: (
    playbook: string,
    inventoryType: InventoryType,
    limit: string,
    extraVars?: ExtraVars,
  ) => Promise<boolean>
  templateRoot: () => string
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
  /** The consensus the cluster runs, read the way alpenglow_state.yml reads it. */
  readState: (network: IdentityNetwork) => Promise<AlpenglowReading>
  /** Asks for one line of text on the terminal. */
  ask: (message: string) => Promise<string>
}

const defaultSetIdentityDeps = (): SetIdentityDeps => ({
  isTty: () => Deno.stdin.isTerminal(),
  readHosts: readInventoryHosts,
  precheck: (input) => runIdentityPrecheck(input),
  confirm: promptConfirm,
  runPlaybook: (playbook, inventoryType, limit, extraVars) =>
    runAnsilbe(playbook, inventoryType, limit, extraVars),
  templateRoot: getTemplatePath,
  info: (line) => console.log(colors.gray(line)),
  error: (line) => console.error(colors.red(line)),
  setExitCode: (code) => {
    Deno.exitCode = code
  },
  readState: (network) => readAlpenglowState(network),
  ask: (message) => Input.prompt({ message }),
})

/**
 * `slv v set:identity`: promotes exactly one named host, after the state of the
 * cluster, the precheck, and a confirmation (default no) on mainnet. With
 * `primaryDown` the operator also types the name of the old primary, which
 * stays unread by the precheck, and the playbook is told so with
 * primary_down_confirmed. When the precheck allowed a stale gossip entry of
 * the identity, the playbook is given its address as primary_down_address.
 * Returns true when the playbook ran and succeeded.
 */
const runSetIdentity = async (
  options: SetIdentityOptions,
  overrides: Partial<SetIdentityDeps> = {},
): Promise<boolean> => {
  const deps: SetIdentityDeps = { ...defaultSetIdentityDeps(), ...overrides }
  const refuse = (message: string): false => {
    deps.error(`❌ ${message}`)
    deps.setExitCode(1)
    return false
  }

  const network = options.network
  if (network !== 'mainnet' && network !== 'testnet') {
    return refuse(
      `set:identity supports -n mainnet or -n testnet, got ${
        network === undefined ? 'no network' : `"${network}"`
      }.`,
    )
  }
  const inventoryType: InventoryType = network === 'mainnet'
    ? 'mainnet_validators'
    : 'testnet_validators'

  if (options.primaryDown) {
    if (options.firstActivation) {
      return refuse(
        '--primary-down and --first-activation exclude each other: an identity that has never voted has no primary to be down.',
      )
    }
    if (!deps.isTty()) {
      return refuse(
        'set:identity --primary-down needs an interactive terminal to confirm that the old primary is stopped; it will not run without one.',
      )
    }
  }

  let hosts: InventoryHost[]
  try {
    hosts = await deps.readHosts(inventoryType)
  } catch (error) {
    return refuse(
      `cannot read the ${inventoryType} inventory: ${describe(error)}`,
    )
  }
  const resolved = resolveSingleHostTarget(hosts, options.pubkey, inventoryType)
  if (!resolved.ok) return refuse(resolved.error)
  const target = resolved.host

  const confirmation = decidePromotionConfirmation(network, deps.isTty())
  if (confirmation === 'refuse') {
    return refuse(
      'set:identity on mainnet needs an interactive terminal to confirm; it will not run without one.',
    )
  }

  // The old primary is the other host of the inventory that holds this identity.
  const peers = peersHoldingIdentity(target, hosts)
  if (options.primaryDown && peers.length === 0) {
    return refuse(
      `no other host of ${inventoryType} holds identity ${target.identityAccount}, so there is no old primary to confirm. Without --primary-down the identity is set from the tower or vote history file on ${target.name}.`,
    )
  }

  // Before any check or playbook: identity changes wait in the migration
  // window and when the state cannot be read.
  const reading = await checkAlpenglowState(network, {
    read: deps.readState,
    info: deps.info,
    error: deps.error,
    setExitCode: deps.setExitCode,
  })
  if (reading === null) return false

  let downPeer: string | undefined
  if (options.primaryDown) {
    const named = (await deps.ask(
      `The old primary holds the same identity as ${target.name}: ${
        peers.map((peer) => `${peer.name} (${peer.ansibleHost})`).join(', ')
      }. Type the inventory name of the old primary to confirm that it is stopped, powered off if needed, and cannot vote:`,
    )).trim()
    if (!peers.some((peer) => peer.name === named)) {
      return refuse(
        `"${named}" is not the inventory name of a host that holds identity ${target.identityAccount} (${
          peers.map((peer) => peer.name).join(', ')
        }). Nothing was changed.`,
      )
    }
    downPeer = named
  }

  const check = await deps.precheck({
    network,
    inventoryType,
    target,
    hosts,
    peerDownConfirmed: options.peerDownConfirmed === true,
    consensus: reading.state,
    downPeer,
  })
  for (const note of check.notes) deps.info(`   ${note}`)
  if (!check.ok) {
    for (const failure of check.failures) deps.error(`❌ ${failure}`)
    deps.setExitCode(1)
    return false
  }

  if (confirmation === 'confirm') {
    const accepted = await deps.confirm({
      message:
        `Promote identity ${target.identityAccount} on ${target.name} (${target.ansibleHost}) on MAINNET?`,
      default: false,
    })
    if (!accepted) {
      deps.info('Cancelled...🌝')
      return false
    }
  }

  const networkPath = network === 'mainnet'
    ? 'mainnet-validator'
    : 'testnet-validator'
  const extraVars: ExtraVars = {}
  if (options.firstActivation) extraVars.first_activation = true
  if (options.primaryDown) extraVars.primary_down_confirmed = true
  if (check.staleAddress !== undefined) {
    extraVars.primary_down_address = check.staleAddress
  }
  return await deps.runPlaybook(
    `${deps.templateRoot()}/ansible/${networkPath}/set_identity_key.yml`,
    inventoryType,
    target.name,
    Object.keys(extraVars).length > 0 ? extraVars : undefined,
  )
}

export {
  ALPENGLOW_VOTE_WINDOW_SLOTS,
  defaultPrecheckDeps,
  parseGossipIp,
  parseRunningIdentityLines,
  RECENT_VOTE_WINDOW_SLOTS,
  resolveHostAddresses,
  runIdentityPrecheck,
  RUNNING_IDENTITY_PLAYBOOK,
  runSetIdentity,
  TOWERBFT_VOTE_WINDOW_SLOTS,
  voteWindowSlots,
}
export type {
  Consensus,
  PrecheckDeps,
  PrecheckInput,
  PrecheckResult,
  SetIdentityDeps,
  SetIdentityOptions,
}
