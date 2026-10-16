import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import type { AlpenglowState } from '/lib/alpenglowState.ts'
import {
  runSwitchCommand,
  type SwitchDeps,
} from '/src/validator/switch/switchCommand.ts'

type Harness = {
  deps: SwitchDeps
  /** What happened, in order. */
  events: string[]
  switches: [string, string, string][]
  info: string[]
  warnings: string[]
  errors: string[]
  successes: string[]
  exitCodes: number[]
}

const harness = (
  options: {
    isTty?: boolean
    network?: string
    names?: string[]
    accepted?: boolean
    state?: AlpenglowState
    switched?: boolean
  } = {},
): Harness => {
  const names = [...(options.names ?? ['val-a', 'val-b'])]
  const h: Harness = {
    deps: undefined as unknown as SwitchDeps,
    events: [],
    switches: [],
    info: [],
    warnings: [],
    errors: [],
    successes: [],
    exitCodes: [],
  }
  h.deps = {
    isTty: () => options.isTty ?? true,
    selectNetwork: () => {
      h.events.push('network')
      return Promise.resolve(options.network ?? 'testnet')
    },
    askName: (message) => {
      h.events.push(`ask ${message}`)
      return Promise.resolve(names.shift())
    },
    confirm: () => {
      h.events.push('confirm')
      return Promise.resolve(options.accepted ?? true)
    },
    readState: (network) => {
      h.events.push(`state ${network}`)
      const state = options.state ?? 'towerbft'
      return Promise.resolve({
        state,
        detail: `getAgGenesisCert: ${state}`,
        marginSlots: 3000,
      })
    },
    switchValidator: (inventoryType, from, to) => {
      h.events.push('switch')
      h.switches.push([inventoryType, from, to])
      return Promise.resolve(options.switched ?? true)
    },
    info: (line) => h.info.push(line),
    warn: (line) => h.warnings.push(line),
    error: (line) => h.errors.push(line),
    success: (line) => h.successes.push(line),
    setExitCode: (code) => h.exitCodes.push(code),
  }
  return h
}

Deno.test('slv v switch needs a terminal on every network and asks and reads nothing without one', async () => {
  for (const network of ['testnet', 'mainnet', undefined]) {
    const h = harness({ isTty: false })
    const went = await runSwitchCommand(
      { network, from: 'val-a', to: 'val-b' },
      h.deps,
    )
    assertEquals(went, false, String(network))
    assertEquals(h.events, [], String(network))
    assertEquals(h.exitCodes, [1], String(network))
    assertStringIncludes(h.errors.join('\n'), 'terminal')
  }
})

Deno.test('slv v switch takes mainnet or testnet only, and does not treat another network as testnet', async () => {
  for (const network of ['devnet', 'mainnet-beta', 'Testnet']) {
    const h = harness()
    const went = await runSwitchCommand(
      { network, from: 'val-a', to: 'val-b' },
      h.deps,
    )
    assertEquals(went, false, network)
    assertEquals(h.events, [], network)
    assertEquals(h.exitCodes, [1], network)
    assertStringIncludes(h.errors.join('\n'), network)
  }
})

Deno.test('slv v switch reads the state of the chosen network and prints it before it asks for the hosts', async () => {
  const asked = harness({ network: 'mainnet', state: 'alpenglow' })
  assertEquals(await runSwitchCommand({}, asked.deps), true)
  assertEquals(asked.events, [
    'network',
    'state mainnet',
    'ask From Validator Name',
    'ask To Validator Name',
    'confirm',
    'switch',
  ])
  assertEquals(
    asked.info[0],
    'Consensus on mainnet: Alpenglow (the genesis certificate exists)',
  )
  assertEquals(asked.info[1], '✨ Switching Mainnet Validator Identity...')

  const named = harness()
  await runSwitchCommand(
    { network: 'testnet', from: 'val-a', to: 'val-b' },
    named.deps,
  )
  assertEquals(named.events, ['state testnet', 'confirm', 'switch'])
})

Deno.test('slv v switch in the migration window, with the activation imminent, or with the state unreadable, asks for no host and switches nothing', async () => {
  for (const state of ['window', 'imminent', 'unknown'] as const) {
    const h = harness({ state })
    const went = await runSwitchCommand({}, h.deps)
    assertEquals(went, false, state)
    assertEquals(h.events, ['network', 'state testnet'], state)
    assertEquals(h.exitCodes, [1], state)
    assertStringIncludes(h.errors.join('\n'), `State: ${state}`)
  }
})

Deno.test('slv v switch under TowerBFT and under Alpenglow switches the two named hosts of the network and says so', async () => {
  for (const state of ['towerbft', 'alpenglow'] as const) {
    const testnet = harness({ state })
    assertEquals(
      await runSwitchCommand(
        { network: 'testnet', from: 'val-a', to: 'val-b' },
        testnet.deps,
      ),
      true,
      state,
    )
    assertEquals(testnet.switches, [['testnet_validators', 'val-a', 'val-b']])
    assertEquals(testnet.successes, [
      '✅ Successfully Switched Validator Identity',
    ])
    assertEquals(testnet.exitCodes, [])

    const mainnet = harness({ state })
    await runSwitchCommand(
      { network: 'mainnet', from: 'val-a', to: 'val-b' },
      mainnet.deps,
    )
    assertEquals(mainnet.switches, [['mainnet_validators', 'val-a', 'val-b']])
  }
})

Deno.test('slv v switch switches nothing and exits 1 when the confirmation is declined', async () => {
  const declined = harness({ accepted: false })
  assertEquals(
    await runSwitchCommand(
      { network: 'testnet', from: 'val-a', to: 'val-b' },
      declined.deps,
    ),
    false,
  )
  assertEquals(declined.switches, [])
  assertStringIncludes(declined.errors.join('\n'), 'Switch Cancelled')
  assertEquals(declined.exitCodes, [1])
})

Deno.test('slv v switch switches nothing and exits 1 when a host name is missing', async () => {
  const missing = harness({ names: ['val-a', ''] })
  assertEquals(
    await runSwitchCommand({ network: 'testnet' }, missing.deps),
    false,
  )
  assertEquals(missing.switches, [])
  assertStringIncludes(
    missing.warnings.join('\n'),
    'From and To Validators are required',
  )
  assertEquals(missing.exitCodes, [1])
})

Deno.test('slv v switch exits 1 and does not call it a success when the switch itself fails', async () => {
  const failed = harness({ switched: false })
  assertEquals(
    await runSwitchCommand(
      { network: 'testnet', from: 'val-a', to: 'val-b' },
      failed.deps,
    ),
    false,
  )
  assertEquals(failed.switches, [['testnet_validators', 'val-a', 'val-b']])
  assertEquals(failed.successes, [])
  assertEquals(failed.exitCodes, [1])
})

Deno.test('slv v switch is the action of runSwitchCommand', async () => {
  const index = await Deno.readTextFile(
    new URL('../../src/validator/index.ts', import.meta.url),
  )
  const start = index.indexOf("validatorCmd.command('switch')")
  assert(start > 0, 'no switch command')
  const block = index.slice(
    start,
    index.indexOf('registerDoubleZeroCommands(', start),
  )
  assertStringIncludes(block, 'await runSwitchCommand({')
  for (
    const option of [
      'from: options.from',
      'to: options.to',
      'network: options.network',
    ]
  ) {
    assertStringIncludes(block, option)
  }
  assertEquals(block.includes('switchValidator('), false)
})
