import { VERSION } from '@cmn/constants/version.ts'
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { parse } from '@std/yaml'
import {
  ALPENGLOW_FEATURE_ID,
  type AlpenglowReading,
  alpenglowRefusal,
  type AlpenglowState,
  checkAlpenglowState,
  CLUSTER_RPC_URLS,
  DEFAULT_MARGIN_SLOTS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  FEATURE_PROGRAM_ID,
  readAlpenglowState,
  RPC_TIMEOUT_MS,
} from '/lib/alpenglowState.ts'

// --- a scripted cluster -----------------------------------------------------

type Reply = () => Response

const text = (body: string, status = 200): Reply => () =>
  new Response(body, { status })
const json = (body: unknown, status = 200): Reply =>
  text(JSON.stringify(body), status)
const result = (value: unknown): Reply =>
  json({ jsonrpc: '2.0', id: 1, result: value })
const failure = (code = -32005): Reply =>
  json({ jsonrpc: '2.0', id: 1, error: { code, message: 'node is unhealthy' } })
const noAnswer: Reply = () => {
  throw new TypeError('connection refused')
}

const CERTIFICATE = {
  block: { blockId: 'Hq3kJ2', slot: 444_625_255 },
  signature: '3Xz9',
}
const account = (data: string, owner = FEATURE_PROGRAM_ID): Reply =>
  result({
    context: { slot: 1 },
    value: {
      owner,
      data: [data, 'base64'],
      lamports: 1,
      executable: false,
      rentEpoch: 0,
      space: 1,
    },
  })
const ABSENT = result({ context: { slot: 1 }, value: null })
const SLOTS_IN_EPOCH = 432_000
const epochWith = (slotsLeft: number): Reply =>
  result({
    epoch: 100,
    slotIndex: SLOTS_IN_EPOCH - slotsLeft,
    slotsInEpoch: SLOTS_IN_EPOCH,
    absoluteSlot: 1,
    blockHeight: 1,
  })

type Call = {
  url: string
  method: string
  params: unknown
  keys: string[]
}

/** Each method answers with its replies in turn, the last one for ever. */
const cluster = (script: Record<string, Reply[]>) => {
  const calls: Call[] = []
  const sleeps: number[] = []
  const used: Record<string, number> = {}
  const deps = {
    fetch: (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const method = String(body.method)
      calls.push({ url, method, params: body.params, keys: Object.keys(body) })
      const replies = script[method]
      if (!replies) return Promise.reject(new Error(`unscripted ${method}`))
      const index = Math.min(used[method] ?? 0, replies.length - 1)
      used[method] = (used[method] ?? 0) + 1
      return Promise.resolve().then(replies[index])
    },
    sleep: (ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  }
  return { calls, sleeps, deps }
}

const methodsOf = (calls: Call[]): string[] => calls.map((call) => call.method)

// --- what the cluster says ---------------------------------------------------

Deno.test('a genesis certificate means Alpenglow, and getAgGenesisCert is the only call made', async () => {
  const c = cluster({ getAgGenesisCert: [result(CERTIFICATE)] })
  const reading = await readAlpenglowState('testnet', {}, c.deps)
  assertEquals(reading.state, 'alpenglow')
  assertEquals(
    reading.detail,
    'getAgGenesisCert: certificate; feature account: not asked',
  )
  assertEquals(methodsOf(c.calls), ['getAgGenesisCert'])
  assertEquals(c.calls[0].url, 'https://api.testnet.solana.com')
  // The playbook sends no params with it.
  assertEquals([...c.calls[0].keys].sort(), ['id', 'jsonrpc', 'method'])
})

Deno.test('a null certificate and an activated feature account is the migration window', async () => {
  const c = cluster({
    getAgGenesisCert: [result(null)],
    getAccountInfo: [account('AQ==')],
  })
  const reading = await readAlpenglowState('mainnet', {}, c.deps)
  assertEquals(reading.state, 'window')
  assertEquals(methodsOf(c.calls), ['getAgGenesisCert', 'getAccountInfo'])
  assertEquals(c.calls[1].url, 'https://api.mainnet-beta.solana.com')
  assertEquals(c.calls[1].params, [ALPENGLOW_FEATURE_ID, {
    encoding: 'base64',
    dataSlice: { offset: 0, length: 1 },
    commitment: 'processed',
  }])
})

Deno.test('a null certificate with the feature account absent, or pending with the epoch far from its end, is TowerBFT', async () => {
  const absent = cluster({
    getAgGenesisCert: [result(null)],
    getAccountInfo: [ABSENT],
  })
  const none = await readAlpenglowState('mainnet', {}, absent.deps)
  assertEquals(none.state, 'towerbft')
  assertEquals(
    none.detail,
    'getAgGenesisCert: null; feature account: absent',
  )
  assertEquals(methodsOf(absent.calls), ['getAgGenesisCert', 'getAccountInfo'])

  const pending = cluster({
    getAgGenesisCert: [result(null)],
    getAccountInfo: [account('AA==')],
    getEpochInfo: [epochWith(200_000)],
  })
  const far = await readAlpenglowState('mainnet', {}, pending.deps)
  assertEquals(far.state, 'towerbft')
  assertEquals(
    far.detail,
    'getAgGenesisCert: null; feature account: inactive; epoch: 200000 slots left',
  )
  assertEquals(
    methodsOf(pending.calls),
    ['getAgGenesisCert', 'getAccountInfo', 'getEpochInfo'],
  )
  assertEquals(pending.calls[2].params, [{ commitment: 'processed' }])
})

Deno.test('a pending feature with fewer slots left than the margin is imminent; the margin is 3000 and 0 turns it off', async () => {
  assertEquals(DEFAULT_MARGIN_SLOTS, 3000)
  const slotsLeft = async (
    left: number,
    marginSlots?: number,
  ): Promise<AlpenglowReading> =>
    await readAlpenglowState(
      'mainnet',
      { marginSlots },
      cluster({
        getAgGenesisCert: [result(null)],
        getAccountInfo: [account('AA==')],
        getEpochInfo: [epochWith(left)],
      }).deps,
    )
  assertEquals((await slotsLeft(2999)).state, 'imminent')
  assertEquals((await slotsLeft(3000)).state, 'towerbft')
  assertEquals((await slotsLeft(2999, 2999)).state, 'towerbft')
  assertEquals((await slotsLeft(1, 0)).state, 'towerbft')
  assertEquals((await slotsLeft(1, 0)).marginSlots, 0)
})

Deno.test('an answer that cannot be read makes the state unknown, whichever call it is', async () => {
  const pendingFeature = {
    getAgGenesisCert: [result(null)],
    getAccountInfo: [account('AA==')],
  }
  const cases: [string, Record<string, Reply[]>, string][] = [
    ['no answer', { getAgGenesisCert: [noAnswer] }, 'unreadable (no answer)'],
    [
      'HTTP error',
      { getAgGenesisCert: [text('rate limited', 429)] },
      'unreadable (HTTP 429)',
    ],
    [
      'not JSON',
      { getAgGenesisCert: [text('<html>bad gateway</html>')] },
      'unreadable (no JSON answer)',
    ],
    [
      'JSON-RPC error',
      { getAgGenesisCert: [failure(-32005)] },
      'unreadable (JSON-RPC error -32005)',
    ],
    [
      'no result',
      { getAgGenesisCert: [json({ jsonrpc: '2.0', id: 1 })] },
      'unreadable (no result)',
    ],
    [
      'a certificate without a signature',
      { getAgGenesisCert: [result({ block: {} })] },
      'unreadable (unexpected result)',
    ],
    [
      'an account the feature program does not own',
      {
        getAgGenesisCert: [result(null)],
        getAccountInfo: [account('AQ==', '11111111111111111111111111111111')],
      },
      'feature account: unreadable (not a feature account)',
    ],
    [
      'account data that is neither 0 nor 1',
      { getAgGenesisCert: [result(null)], getAccountInfo: [account('Ag==')] },
      'feature account: unreadable (unexpected account data)',
    ],
    [
      'the feature account call failing',
      { getAgGenesisCert: [result(null)], getAccountInfo: [failure()] },
      'feature account: unreadable (JSON-RPC error -32005)',
    ],
    [
      'an epoch that ends before it has begun',
      {
        ...pendingFeature,
        getEpochInfo: [
          result({ slotIndex: 10, slotsInEpoch: 5, epoch: 1 }),
        ],
      },
      'epoch: unreadable (unexpected result)',
    ],
    [
      'the epoch call failing',
      { ...pendingFeature, getEpochInfo: [failure()] },
      'epoch: unreadable (JSON-RPC error -32005)',
    ],
  ]
  for (const [name, script, expected] of cases) {
    const reading = await readAlpenglowState(
      'testnet',
      { retries: 0 },
      cluster(script).deps,
    )
    assertEquals(reading.state, 'unknown', name)
    assertStringIncludes(reading.detail, expected)
  }
})

Deno.test('a call whose answer cannot be read is tried twice more, 2 s apart, and a later good answer is used', async () => {
  assertEquals(DEFAULT_RETRIES, 2)
  assertEquals(DEFAULT_RETRY_DELAY_MS, 2000)
  const recovering = cluster({
    getAgGenesisCert: [failure(), noAnswer, result(CERTIFICATE)],
  })
  const reading = await readAlpenglowState('testnet', {}, recovering.deps)
  assertEquals(reading.state, 'alpenglow')
  assertEquals(recovering.calls.length, 3)
  assertEquals(recovering.sleeps, [2000, 2000])

  const failing = cluster({ getAgGenesisCert: [failure()] })
  const gone = await readAlpenglowState('testnet', {}, failing.deps)
  assertEquals(gone.state, 'unknown')
  assertEquals(failing.calls.length, 3)
  assertEquals(failing.sleeps, [2000, 2000])
})

// --- what a command does with it ---------------------------------------------

const readingOf = (state: AlpenglowState): AlpenglowReading => ({
  state,
  detail: `getAgGenesisCert: ${state}`,
  marginSlots: 3000,
})

Deno.test('the state is printed, and window, imminent and unknown stop the command with exit code 1 while TowerBFT and Alpenglow let it go', async () => {
  const states: AlpenglowState[] = [
    'towerbft',
    'imminent',
    'window',
    'alpenglow',
    'unknown',
  ]
  for (const state of states) {
    const info: string[] = []
    const errors: string[] = []
    const exitCodes: number[] = []
    const reading = readingOf(state)
    const went = await checkAlpenglowState('mainnet', {
      read: () => Promise.resolve(reading),
      info: (line) => info.push(line),
      error: (line) => errors.push(line),
      setExitCode: (code) => exitCodes.push(code),
    })
    assertEquals(info.length, 1, state)
    assertStringIncludes(info[0], 'Consensus on mainnet: ')
    if (state === 'towerbft' || state === 'alpenglow') {
      assertEquals(went, reading, state)
      assertEquals([errors, exitCodes], [[], []], state)
    } else {
      assertEquals(went, null, state)
      assertEquals(exitCodes, [1], state)
      assertEquals(errors.length, 1, state)
      assertStringIncludes(errors[0], `State: ${state}`)
      assertStringIncludes(errors[0], 'Nothing was changed')
    }
  }
  assertStringIncludes(
    alpenglowRefusal(readingOf('imminent')) ?? '',
    'fewer than 3000 slots',
  )
})

// --- agreement with the playbooks ----------------------------------------------

type Task = Record<string, unknown>

const PROBE = new URL(
  `../../../template/${VERSION}/ansible/cmn/tasks/alpenglow_state.yml`,
  import.meta.url,
)

const probeTasks = (): Task[] => parse(Deno.readTextFileSync(PROBE)) as Task[]

const taskNamed = (tasks: Task[], fragment: string): Task => {
  const found = tasks.find((task) => String(task.name).includes(fragment))
  assert(found, `alpenglow_state.yml has no task named like "${fragment}"`)
  return found
}

const args = (task: Task, module: string): Record<string, unknown> =>
  task[`ansible.builtin.${module}`] as Record<string, unknown>

const squeezed = (value: unknown): string =>
  String(value).replaceAll(/\s+/g, '')

Deno.test('the CLI asks what alpenglow_state.yml asks, the same way', () => {
  const tasks = probeTasks()
  const cert = taskNamed(tasks, 'getAgGenesisCert')
  const feature = taskNamed(tasks, 'its feature account')
  const epoch = taskNamed(tasks, 'getEpochInfo')

  const body = (task: Task) => args(task, 'uri').body as Record<string, unknown>
  assertEquals(body(cert).method, 'getAgGenesisCert')
  assertEquals('params' in body(cert), false)
  assertEquals(body(feature).method, 'getAccountInfo')
  assertEquals(body(feature).params, [ALPENGLOW_FEATURE_ID, {
    encoding: 'base64',
    dataSlice: { offset: 0, length: 1 },
    commitment: 'processed',
  }])
  assertEquals(body(epoch).method, 'getEpochInfo')
  assertEquals(body(epoch).params, [{ commitment: 'processed' }])

  // The feature account is asked when the certificate is null, the epoch when
  // the feature is not activated yet.
  assertEquals(feature.when, "slv_ag_cert_kind == 'null'")
  assertEquals(epoch.when, "slv_ag_feature_kind == 'inactive'")

  for (const task of [cert, feature, epoch]) {
    assertEquals(args(task, 'uri').timeout, RPC_TIMEOUT_MS / 1000)
    assertEquals(
      Number(/default\((\d+)\)/.exec(String(task.retries))?.[1]),
      DEFAULT_RETRIES,
    )
    assertEquals(
      Number(/default\((\d+)\)/.exec(String(task.delay))?.[1]),
      DEFAULT_RETRY_DELAY_MS / 1000,
    )
    for (const [network, url] of Object.entries(CLUSTER_RPC_URLS)) {
      assertStringIncludes(
        String(args(task, 'uri').url),
        `'${network}': '${url}'`,
      )
    }
  }
})

Deno.test('the CLI names what it read as alpenglow_state.yml does', () => {
  const tasks = probeTasks()
  const facts = (fragment: string): Task =>
    args(taskNamed(tasks, fragment), 'set_fact')
  const labels: [string, string, string[]][] = [
    ['certificate answer', 'slv_ag_cert_kind', [
      'unreadable (no answer)',
      'unreadable (HTTP',
      'unreadable (no JSON answer)',
      'unreadable (JSON-RPC error',
      'unreadable (no result)',
      'unreadable (unexpected result)',
      'null',
      'certificate',
    ]],
    ['feature account answer', 'slv_ag_feature_kind', [
      'not asked',
      'unreadable (no answer)',
      'unreadable (HTTP',
      'unreadable (no JSON answer)',
      'unreadable (JSON-RPC error',
      'unreadable (unexpected result)',
      'absent',
      'unreadable (not a feature account)',
      FEATURE_PROGRAM_ID,
      'AA==',
      'AQ==',
      'inactive',
      'active',
      'unreadable (unexpected account data)',
    ]],
    ['epoch answer', 'slv_ag_epoch_kind', [
      'not asked',
      'unreadable (no answer)',
      'unreadable (HTTP',
      'unreadable (no JSON answer)',
      'unreadable (JSON-RPC error',
      'unreadable (unexpected result)',
      'slots left',
    ]],
  ]
  for (const [fragment, fact, expected] of labels) {
    const template = String(facts(fragment)[fact])
    for (const label of expected) {
      assertStringIncludes(template, label, `${fact} lacks "${label}"`)
    }
  }

  const decided = facts('Decide which consensus')
  assertEquals(
    squeezed(decided.slv_alpenglow_state),
    squeezed(`
      {%- if slv_ag_cert_kind.startswith('unreadable') -%}unknown
      {%- elif slv_ag_cert_kind == 'certificate' -%}alpenglow
      {%- elif slv_ag_feature_kind.startswith('unreadable') -%}unknown
      {%- elif slv_ag_feature_kind == 'active' -%}window
      {%- elif slv_ag_feature_kind == 'inactive' -%}
      {%- if slv_ag_epoch_kind.startswith('unreadable') or slv_ag_epoch_kind == 'not asked' -%}unknown
      {%- elif (slv_ag_epoch_kind.split(' ')[0] | int) < (slv_alpenglow_margin_slots | default(${DEFAULT_MARGIN_SLOTS}) | int) -%}imminent
      {%- else -%}towerbft
      {%- endif -%}
      {%- else -%}towerbft
      {%- endif -%}
    `),
  )
  assertEquals(
    String(decided.slv_alpenglow_detail),
    "getAgGenesisCert: {{ slv_ag_cert_kind }}; feature account: {{ slv_ag_feature_kind }}{{ '; epoch: ' ~ slv_ag_epoch_kind if slv_ag_epoch_kind != 'not asked' else '' }}",
  )
})

Deno.test('the CLI stops an identity change in the states in which the playbooks stop it', () => {
  const tasks = probeTasks()
  const stops = tasks.filter((task) =>
    String(task.name).startsWith('Stop the identity change')
  )
  assertEquals(stops.length, 2)
  const conditions = stops.flatMap((task) =>
    (args(task, 'assert').that as string[]).map(String)
  )
  const inList = /^slv_alpenglow_state not in \[(.*)\]$/
  const different = /^slv_alpenglow_state != '(\w+)'$/
  const stopped = conditions.flatMap((condition) => {
    const list = inList.exec(condition)?.[1]
    if (list) return list.split(',').map((name) => name.trim().slice(1, -1))
    const one = different.exec(condition)?.[1]
    assert(one, `unrecognised condition: ${condition}`)
    return [one]
  })
  const all: AlpenglowState[] = [
    'towerbft',
    'imminent',
    'window',
    'alpenglow',
    'unknown',
  ]
  assertEquals(
    all.filter((state) => alpenglowRefusal(readingOf(state)) !== null).sort(),
    [...stopped].sort(),
  )
})
