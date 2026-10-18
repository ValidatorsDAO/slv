// Which consensus does the cluster run? The CLI reads what
// template/<release>/ansible/cmn/tasks/alpenglow_state.yml reads, from the same
// public RPC, and decides the same way, so that a command which refuses before
// it runs a playbook and the playbook agree.
//
//   towerbft   the Alpenglow feature account is absent or not activated, and the
//              epoch does not end soon
//   imminent   the feature account exists but is not activated yet and fewer than
//              DEFAULT_MARGIN_SLOTS slots are left in the epoch
//   window     the feature is activated and getAgGenesisCert still returns null
//   alpenglow  getAgGenesisCert returns a certificate
//   unknown    an RPC error, or an answer that cannot be read
//
// An identity change goes on in towerbft and alpenglow only.

type AlpenglowNetwork = 'mainnet' | 'testnet' | 'devnet'

type AlpenglowState =
  | 'towerbft'
  | 'imminent'
  | 'window'
  | 'alpenglow'
  | 'unknown'

/** The two states an identity change may go on in. */
type Consensus = 'towerbft' | 'alpenglow'

const ALPENGLOW_FEATURE_ID = 'A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS'
const FEATURE_PROGRAM_ID = 'Feature111111111111111111111111111111111111'

/** The public cluster RPC each network is asked, as in alpenglow_state.yml. */
const CLUSTER_RPC_URLS: Record<AlpenglowNetwork, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  testnet: 'https://api.testnet.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

/** Slots left in the epoch below which a pending activation counts as imminent. 0 turns it off. */
const DEFAULT_MARGIN_SLOTS = 3000
/** Retries of a call whose answer cannot be read, and the seconds between the attempts. */
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 2_000
const RPC_TIMEOUT_MS = 20_000

type Reading = {
  state: AlpenglowState
  /** A short reason; it never holds the RPC URL. */
  detail: string
  marginSlots: number
}

type SettledReading = Reading & { state: Consensus }

const isSettled = (reading: Reading): reading is SettledReading =>
  reading.state === 'towerbft' || reading.state === 'alpenglow'

// --- what the answers say ----------------------------------------------------

/** What one JSON-RPC call came back with. status -1: no answer at all. */
type Reply = { status: number; body: unknown }

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why a reply cannot be read, or null when it is a JSON-RPC result. */
const unreadable = (reply: Reply): string | null => {
  if (reply.status === -1) return 'unreadable (no answer)'
  if (reply.status !== 200) return `unreadable (HTTP ${reply.status})`
  if (!isMapping(reply.body)) return 'unreadable (no JSON answer)'
  if ('error' in reply.body) {
    const error = reply.body.error
    const code = isMapping(error) && Number.isInteger(error.code)
      ? ` ${error.code}`
      : ''
    return `unreadable (JSON-RPC error${code})`
  }
  return null
}

/** certificate, null, or unreadable (...): what getAgGenesisCert answered. */
const certKind = (reply: Reply): string => {
  const bad = unreadable(reply)
  if (bad) return bad
  const body = reply.body as Record<string, unknown>
  if (!('result' in body)) return 'unreadable (no result)'
  if (body.result === null) return 'null'
  if (
    isMapping(body.result) && 'block' in body.result &&
    'signature' in body.result
  ) return 'certificate'
  return 'unreadable (unexpected result)'
}

const sameList = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) && value.length === expected.length &&
  value.every((item, index) => item === expected[index])

/** absent, inactive, active, not asked, or unreadable (...): what the feature account says. */
const featureKind = (reply: Reply | null): string => {
  if (reply === null) return 'not asked'
  const bad = unreadable(reply)
  if (bad) return bad
  const result = (reply.body as Record<string, unknown>).result
  if (
    !isMapping(result) || !isMapping(result.context) || !('value' in result)
  ) return 'unreadable (unexpected result)'
  const value = result.value
  if (value === null) return 'absent'
  if (!isMapping(value) || (value.owner ?? '') !== FEATURE_PROGRAM_ID) {
    return 'unreadable (not a feature account)'
  }
  if (sameList(value.data ?? [], ['AA==', 'base64'])) return 'inactive'
  if (sameList(value.data ?? [], ['AQ==', 'base64'])) return 'active'
  return 'unreadable (unexpected account data)'
}

/** "N slots left", not asked, or unreadable (...): what getEpochInfo says. */
const epochKind = (reply: Reply | null): string => {
  if (reply === null) return 'not asked'
  const bad = unreadable(reply)
  if (bad) return bad
  const body = reply.body as Record<string, unknown>
  const info = body.result
  if (
    !isMapping(info) || !('slotIndex' in info) || !('slotsInEpoch' in info)
  ) return 'unreadable (unexpected result)'
  const { slotIndex, slotsInEpoch } = info
  if (
    typeof slotIndex !== 'number' || typeof slotsInEpoch !== 'number' ||
    !Number.isInteger(slotIndex) || !Number.isInteger(slotsInEpoch)
  ) return 'unreadable (unexpected result)'
  if (slotIndex < 0 || slotsInEpoch <= slotIndex) {
    return 'unreadable (unexpected result)'
  }
  return `${slotsInEpoch - slotIndex} slots left`
}

/** The state the three readings add up to, decided as alpenglow_state.yml decides it. */
const decideAlpenglowState = (
  cert: string,
  feature: string,
  epoch: string,
  marginSlots: number,
): AlpenglowState => {
  if (cert.startsWith('unreadable')) return 'unknown'
  if (cert === 'certificate') return 'alpenglow'
  if (feature.startsWith('unreadable')) return 'unknown'
  if (feature === 'active') return 'window'
  if (feature === 'inactive') {
    if (epoch.startsWith('unreadable') || epoch === 'not asked') {
      return 'unknown'
    }
    return Number.parseInt(epoch, 10) < marginSlots ? 'imminent' : 'towerbft'
  }
  return 'towerbft'
}

// --- asking the cluster ------------------------------------------------------

type StateDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
}

const defaultStateDeps = (): StateDeps => ({
  fetch: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

type StateOptions = {
  marginSlots?: number
  retries?: number
  delayMs?: number
}

const answered = (reply: Reply): boolean =>
  reply.status === 200 && isMapping(reply.body) && !('error' in reply.body) &&
  'result' in reply.body

const callOnce = async (
  deps: StateDeps,
  url: string,
  method: string,
  params: unknown[] | undefined,
): Promise<Reply> => {
  try {
    const response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        ...(params ? { params } : {}),
      }),
    })
    let body: unknown = undefined
    try {
      body = await response.json()
    } catch {
      // Left undefined: the answer is not JSON.
    }
    return { status: response.status, body }
  } catch {
    return { status: -1, body: undefined }
  }
}

/** One call, tried again (after `delayMs`) while its answer cannot be read. */
const call = async (
  deps: StateDeps,
  url: string,
  method: string,
  params: unknown[] | undefined,
  retries: number,
  delayMs: number,
): Promise<Reply> => {
  let reply: Reply = { status: -1, body: undefined }
  for (let attempt = 0; attempt <= Math.max(retries, 0); attempt++) {
    if (attempt > 0) await deps.sleep(delayMs)
    reply = await callOnce(deps, url, method, params)
    if (answered(reply)) break
  }
  return reply
}

/**
 * Asks the cluster which consensus it runs: getAgGenesisCert; when that is
 * null, the feature account; when that is not activated yet, getEpochInfo.
 */
const readAlpenglowState = async (
  network: AlpenglowNetwork,
  options: StateOptions = {},
  overrides: Partial<StateDeps> = {},
): Promise<Reading> => {
  const deps = { ...defaultStateDeps(), ...overrides }
  const url = CLUSTER_RPC_URLS[network]
  const marginSlots = options.marginSlots ?? DEFAULT_MARGIN_SLOTS
  const retries = options.retries ?? DEFAULT_RETRIES
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS

  const cert = certKind(
    await call(deps, url, 'getAgGenesisCert', undefined, retries, delayMs),
  )
  const feature = cert === 'null'
    ? featureKind(
      await call(
        deps,
        url,
        'getAccountInfo',
        [
          ALPENGLOW_FEATURE_ID,
          {
            encoding: 'base64',
            dataSlice: { offset: 0, length: 1 },
            commitment: 'processed',
          },
        ],
        retries,
        delayMs,
      ),
    )
    : 'not asked'
  const epoch = feature === 'inactive'
    ? epochKind(
      await call(
        deps,
        url,
        'getEpochInfo',
        [{ commitment: 'processed' }],
        retries,
        delayMs,
      ),
    )
    : 'not asked'

  return {
    state: decideAlpenglowState(cert, feature, epoch, marginSlots),
    detail: `getAgGenesisCert: ${cert}; feature account: ${feature}${
      epoch === 'not asked' ? '' : `; epoch: ${epoch}`
    }`,
    marginSlots,
  }
}

// --- what a command says -----------------------------------------------------

/** One line for the operator: the consensus the cluster runs. */
const alpenglowStateLine = (
  network: AlpenglowNetwork,
  reading: Reading,
): string => {
  const label = {
    towerbft: 'TowerBFT (the Alpenglow feature is not active)',
    imminent:
      `TowerBFT, and the Alpenglow activation is about to start (fewer than ${reading.marginSlots} slots left in the epoch)`,
    window:
      'migration window (the Alpenglow feature is active, no genesis certificate yet)',
    alpenglow: 'Alpenglow (the genesis certificate exists)',
    unknown: `cannot be read (${reading.detail})`,
  }[reading.state]
  return `Consensus on ${network}: ${label}`
}

const refusalText = (reading: Reading): string =>
  reading.state === 'imminent'
    ? `The Alpenglow activation is about to start: the feature is pending and the epoch ends in fewer than ${reading.marginSlots} slots. Run the identity change after the genesis certificate: wait until getAgGenesisCert returns a certificate. State: imminent (${reading.detail}). Nothing was changed.`
    : `The cluster is between the Alpenglow feature activation and the genesis certificate, or its state cannot be read: identity changes wait until getAgGenesisCert returns a certificate. State: ${reading.state} (${reading.detail}). Nothing was changed.`

/** Why an identity change must wait, or null when the state lets it go on. */
const alpenglowRefusal = (reading: Reading): string | null =>
  isSettled(reading) ? null : refusalText(reading)

type StateIo<Network extends AlpenglowNetwork = AlpenglowNetwork> = {
  read: (network: Network) => Promise<Reading>
  info: (line: string) => void
  error: (line: string) => void
  setExitCode: (code: number) => void
}

/**
 * Reads and prints the state. Returns the reading when the identity change may
 * go on (towerbft or alpenglow), else prints why, sets exit code 1 and returns
 * null.
 */
const checkAlpenglowState = async <Network extends AlpenglowNetwork>(
  network: Network,
  io: StateIo<Network>,
): Promise<SettledReading | null> => {
  const reading = await io.read(network)
  io.info(alpenglowStateLine(network, reading))
  if (isSettled(reading)) return reading
  io.error(`❌ ${refusalText(reading)}`)
  io.setExitCode(1)
  return null
}

export {
  ALPENGLOW_FEATURE_ID,
  alpenglowRefusal,
  checkAlpenglowState,
  CLUSTER_RPC_URLS,
  DEFAULT_MARGIN_SLOTS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  FEATURE_PROGRAM_ID,
  readAlpenglowState,
  RPC_TIMEOUT_MS,
}
export type {
  AlpenglowNetwork,
  AlpenglowState,
  Consensus,
  Reading as AlpenglowReading,
  SettledReading,
}
