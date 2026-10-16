import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import type { AlpenglowState } from '/lib/alpenglowState.ts'
import {
  type PrecheckInput,
  type PrecheckResult,
  runSetIdentity,
  type SetIdentityDeps,
} from '/lib/identityPrecheck.ts'
import type { InventoryHost } from '/lib/targetGuard.ts'

const IDENTITY = 'Aa'.repeat(22)
const OTHER_IDENTITY = 'Bb'.repeat(22)
const VOTE = 'Cc'.repeat(22)

const makeHost = (
  name: string,
  ansibleHost: string,
  identityAccount: string,
): InventoryHost => ({
  name,
  ansibleHost,
  identityAccount,
  voteAccount: VOTE,
  ansibleConnection: '',
})

// val-primary was voting with IDENTITY; val-standby is the host to promote.
const PRIMARY = makeHost('val-primary', '203.0.113.10', IDENTITY)
const STANDBY = makeHost('val-standby', '203.0.113.11', IDENTITY)
const OTHER = makeHost('val-other', '203.0.113.12', OTHER_IDENTITY)
const HOSTS = [PRIMARY, STANDBY, OTHER]

type Run = {
  playbook: string
  inventoryType: string
  limit: string
  extraVars?: Record<string, string | boolean>
}

type Harness = {
  deps: SetIdentityDeps
  /** What happened, in order: state, ask, precheck, confirm, playbook. */
  events: string[]
  states: string[]
  asks: string[]
  prechecks: PrecheckInput[]
  runs: Run[]
  info: string[]
  errors: string[]
  exitCodes: number[]
}

const harness = (
  options: {
    isTty?: boolean
    state?: AlpenglowState
    typed?: string
    precheck?: PrecheckResult
    answer?: boolean
    hosts?: InventoryHost[]
  } = {},
): Harness => {
  const h: Harness = {
    deps: undefined as unknown as SetIdentityDeps,
    events: [],
    states: [],
    asks: [],
    prechecks: [],
    runs: [],
    info: [],
    errors: [],
    exitCodes: [],
  }
  h.deps = {
    isTty: () => options.isTty ?? true,
    readHosts: () => Promise.resolve(options.hosts ?? HOSTS),
    readState: (network) => {
      h.events.push('state')
      h.states.push(network)
      const state = options.state ?? 'towerbft'
      return Promise.resolve({
        state,
        detail: `getAgGenesisCert: ${state}`,
        marginSlots: 3000,
      })
    },
    ask: (message) => {
      h.events.push('ask')
      h.asks.push(message)
      return Promise.resolve(options.typed ?? '')
    },
    precheck: (input) => {
      h.events.push('precheck')
      h.prechecks.push(input)
      return Promise.resolve(
        options.precheck ?? { ok: true, failures: [], notes: [] },
      )
    },
    confirm: () => {
      h.events.push('confirm')
      return Promise.resolve(options.answer ?? true)
    },
    runPlaybook: (playbook, inventoryType, limit, extraVars) => {
      h.events.push('playbook')
      h.runs.push({ playbook, inventoryType, limit, extraVars })
      return Promise.resolve(true)
    },
    templateRoot: () => '/t',
    info: (line) => h.info.push(line),
    error: (line) => h.errors.push(line),
    setExitCode: (code) => h.exitCodes.push(code),
  }
  return h
}

// --- the state of the cluster, before anything else ---------------------------

Deno.test('set:identity reads the Alpenglow state of the network before the precheck and the playbook, prints it, and gives the consensus to the precheck', async () => {
  const tower = harness({ state: 'towerbft' })
  assertEquals(
    await runSetIdentity(
      { network: 'testnet', pubkey: 'val-standby' },
      tower.deps,
    ),
    true,
  )
  assertEquals(tower.events, ['state', 'precheck', 'playbook'])
  assertEquals(tower.states, ['testnet'])
  assertEquals(tower.prechecks[0].consensus, 'towerbft')
  assert(tower.info.some((line) => line.startsWith('Consensus on testnet: ')))

  const votor = harness({ state: 'alpenglow' })
  assertEquals(
    await runSetIdentity(
      { network: 'mainnet', pubkey: 'val-standby' },
      votor.deps,
    ),
    true,
  )
  assertEquals(votor.events, ['state', 'precheck', 'confirm', 'playbook'])
  assertEquals(votor.states, ['mainnet'])
  assertEquals(votor.prechecks[0].consensus, 'alpenglow')
})

Deno.test('set:identity in the migration window, with the activation imminent, or with the state unreadable, runs no precheck and no playbook, and asks nothing', async () => {
  for (const state of ['window', 'imminent', 'unknown'] as const) {
    for (const primaryDown of [false, true]) {
      const h = harness({ state, typed: 'val-primary' })
      const went = await runSetIdentity(
        { network: 'testnet', pubkey: 'val-standby', primaryDown },
        h.deps,
      )
      const name = `${state} primaryDown=${primaryDown}`
      assertEquals(went, false, name)
      assertEquals(h.events, ['state'], name)
      assertEquals(h.exitCodes, [1], name)
      assertStringIncludes(h.errors.join('\n'), `State: ${state}`)
    }
  }
})

// --- --primary-down -----------------------------------------------------------

Deno.test('set:identity --primary-down needs a terminal on every network, and reads and asks nothing without one', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const h = harness({ isTty: false, typed: 'val-primary' })
    const went = await runSetIdentity(
      { network, pubkey: 'val-standby', primaryDown: true },
      h.deps,
    )
    assertEquals(went, false, network)
    assertEquals(h.events, [], network)
    assertEquals(h.exitCodes, [1], network)
    assertStringIncludes(h.errors.join('\n'), 'terminal')
  }
})

Deno.test('set:identity --primary-down and --first-activation exclude each other', async () => {
  const h = harness({ typed: 'val-primary' })
  const went = await runSetIdentity({
    network: 'testnet',
    pubkey: 'val-standby',
    primaryDown: true,
    firstActivation: true,
  }, h.deps)
  assertEquals(went, false)
  assertEquals(h.events, [])
  assertEquals(h.exitCodes, [1])
})

Deno.test('set:identity --primary-down is refused when no other host of the inventory holds the identity', async () => {
  const h = harness({ hosts: [PRIMARY, OTHER], typed: 'val-other' })
  const went = await runSetIdentity(
    { network: 'testnet', pubkey: 'val-primary', primaryDown: true },
    h.deps,
  )
  assertEquals(went, false)
  assertEquals(h.events, [])
  assertEquals(h.exitCodes, [1])
  assertStringIncludes(h.errors.join('\n'), IDENTITY)
})

Deno.test('set:identity --primary-down asks for the inventory name of the old primary, and any other answer runs nothing', async () => {
  for (
    const typed of ['', 'val-standby', 'val-other', 'nobody', 'VAL-PRIMARY']
  ) {
    const h = harness({ typed })
    const went = await runSetIdentity(
      { network: 'testnet', pubkey: 'val-standby', primaryDown: true },
      h.deps,
    )
    assertEquals(went, false, `typed "${typed}"`)
    assertEquals(h.events, ['state', 'ask'], `typed "${typed}"`)
    assertEquals(h.exitCodes, [1], `typed "${typed}"`)
    assertStringIncludes(h.errors.join('\n'), 'Nothing was changed')
    // The question names the host and its address, and what is being confirmed.
    assertStringIncludes(h.asks[0], 'val-primary (203.0.113.10)')
    assertStringIncludes(h.asks[0], 'stopped')
    assertStringIncludes(h.asks[0], 'cannot vote')
  }
})

Deno.test('set:identity --primary-down with the name of the old primary tells the precheck which peer is down and runs the playbook with primary_down_confirmed', async () => {
  const h = harness({ typed: ' val-primary ' })
  const went = await runSetIdentity(
    { network: 'testnet', pubkey: 'val-standby', primaryDown: true },
    h.deps,
  )
  assertEquals(went, true)
  assertEquals(h.events, ['state', 'ask', 'precheck', 'playbook'])
  assertEquals(h.prechecks[0].downPeer, 'val-primary')
  assertEquals(h.prechecks[0].target.name, 'val-standby')
  assertEquals(h.runs, [{
    playbook: '/t/ansible/testnet-validator/set_identity_key.yml',
    inventoryType: 'testnet_validators',
    limit: 'val-standby',
    extraVars: { primary_down_confirmed: true },
  }])
})

Deno.test('set:identity --primary-down on mainnet still asks the mainnet confirmation after the name, and answering no runs nothing', async () => {
  const h = harness({ typed: 'val-primary', answer: false })
  const went = await runSetIdentity(
    { network: 'mainnet', pubkey: 'val-standby', primaryDown: true },
    h.deps,
  )
  assertEquals(went, false)
  assertEquals(h.events, ['state', 'ask', 'precheck', 'confirm'])
  assertEquals(h.runs, [])
})

Deno.test('set:identity --primary-down stops where the precheck stops, for instance when the identity is in gossip at another address', async () => {
  const h = harness({
    typed: 'val-primary',
    precheck: {
      ok: false,
      failures: [`identity ${IDENTITY} is already in gossip at 203.0.113.10`],
      notes: [],
    },
  })
  const went = await runSetIdentity(
    { network: 'testnet', pubkey: 'val-standby', primaryDown: true },
    h.deps,
  )
  assertEquals(went, false)
  assertEquals(h.events, ['state', 'ask', 'precheck'])
  assertEquals(h.exitCodes, [1])
  assertStringIncludes(h.errors.join('\n'), '203.0.113.10')
})

Deno.test('set:identity without --primary-down asks nothing, names no down peer and sends no primary_down_confirmed', async () => {
  const plain = harness({ typed: 'val-primary' })
  await runSetIdentity(
    { network: 'testnet', pubkey: 'val-standby' },
    plain.deps,
  )
  assertEquals(plain.asks, [])
  assertEquals(plain.prechecks[0].downPeer, undefined)
  assertEquals(plain.runs[0].extraVars, undefined)

  const first = harness({ typed: 'val-primary' })
  await runSetIdentity(
    { network: 'testnet', pubkey: 'val-standby', firstActivation: true },
    first.deps,
  )
  assertEquals(first.asks, [])
  assertEquals(first.runs[0].extraVars, { first_activation: true })
})

Deno.test('slv v set:identity declares --primary-down and hands it to runSetIdentity', async () => {
  const index = await Deno.readTextFile(
    new URL('../../src/validator/index.ts', import.meta.url),
  )
  const start = index.indexOf("validatorCmd.command('set:identity')")
  assert(start > 0, 'no set:identity command')
  const block = index.slice(
    start,
    index.indexOf('validatorCmd.command(', start + 1),
  )
  assertStringIncludes(block, "'--primary-down'")
  assertStringIncludes(block, 'primaryDown: options.primaryDown')
})
