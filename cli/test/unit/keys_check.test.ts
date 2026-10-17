import { assertEquals, assertStringIncludes } from '@std/assert'
import { checkKey } from '/src/validator/keys/checkKey.ts'
import {
  captureIo,
  holdsKey,
  ITEM,
  KEY_A,
  KEY_B,
  OTHER_VAULT,
  refOf,
  scriptedOp,
  scriptedTty,
  setupDeps,
  TOKEN,
  VAULT,
} from '/test/unit/_keylessFixtures.ts'

/** Runs `body` with every start of a process refused and counted, whatever is started. */
const countingProcesses = async <T>(
  body: () => Promise<T>,
): Promise<{ value: T; started: number }> => {
  const original = Deno.Command
  let started = 0 // deno-lint-ignore no-explicit-any
  ;(Deno as any).Command = class {
    constructor() {
      started++
      throw new Error('a process was started')
    }
  }
  try {
    return { value: await body(), started }
  } finally {
    // deno-lint-ignore no-explicit-any
    ;(Deno as any).Command = original
  }
}

const run = async (
  options: { network?: string; host?: string; ref?: string; pubkey?: string },
  config: {
    printed?: string
    opFails?: string
    setupOverrides?: Parameters<typeof setupDeps>[1]
  } = {},
) => {
  const op = scriptedOp(() =>
    config.opFails === undefined
      ? { success: true, stdout: config.printed ?? KEY_A.canonical }
      : { success: false, stderr: config.opFails }
  )
  const captured = captureIo()
  const { value, started } = await countingProcesses(() =>
    checkKey(options, {
      setup: setupDeps(op.op, config.setupOverrides),
      io: captured.io,
    })
  )
  return { result: value, started, op, captured }
}

const CHECK = { network: 'testnet', ref: refOf(), pubkey: KEY_A.pubkey }

Deno.test('keys:check reads the key as `op read -n <ref>`, proves it, and prints its public key and nothing else of it; it starts no process of its own, so there is no ssh or ansible', async () => {
  const { result, started, op, captured } = await run({
    ...CHECK,
    pubkey: KEY_A.pubkey,
  })
  assertEquals(result, true)
  assertEquals(started, 0)
  assertEquals(op.calls.map((call) => call.args), [['read', '-n', refOf()]])
  assertEquals(op.calls[0].stdinLength, null)
  assertEquals(op.calls[0].env.OP_CACHE, 'false')
  assertEquals(captured.exitCode(), undefined)
  const lines = captured.info.join('\n')
  assertStringIncludes(lines, KEY_A.pubkey)
  assertStringIncludes(lines, 'pubkey matches the expected one')
  assertEquals(holdsKey(lines, KEY_A), false)
  assertEquals(captured.error, [])

  // The text of the key may have spaces and line breaks, as `op` and the files of the CLI of Solana write it.
  const spaced = await run({ ...CHECK, pubkey: KEY_B.pubkey }, {
    printed: `[ ${[...KEY_B.keypair].join(', ')} ]\n`,
  })
  assertEquals(spaced.result, true)
  assertStringIncludes(spaced.captured.info.join('\n'), KEY_B.pubkey)
})

Deno.test('a reference without --pubkey is refused before op is run, as is -p together with --ref or --pubkey, and neither of them', async () => {
  const cases: [string, Parameters<typeof run>[0], string][] = [
    [
      'a reference with no public key to hold it against',
      { network: 'testnet', ref: refOf() },
      'keys:check --ref needs --pubkey',
    ],
    [
      'a host and a reference',
      { network: 'testnet', host: 'node-1', ref: refOf() },
      'and not both',
    ],
    [
      'a host and a public key',
      { network: 'testnet', host: 'node-1', pubkey: KEY_A.pubkey },
      'and not both',
    ],
    ['neither', { network: 'testnet' }, 'keys:check needs -p'],
  ]
  for (const [name, options, expected] of cases) {
    const { result, started, op, captured } = await run(options)
    assertEquals(result, false, name)
    assertEquals(started, 0, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error.join('\n'), expected)
  }
})

Deno.test('a key that is not the expected one, is not a whole keypair, cannot be read, or is in a vault that is not the configured one, fails with the exit code 1 and without a word of the key', async () => {
  const cases: [
    string,
    Parameters<typeof run>[0],
    Parameters<typeof run>[1],
    string,
    number,
  ][] = [
    [
      'another public key',
      { ...CHECK, pubkey: KEY_B.pubkey },
      {},
      `is ${KEY_A.pubkey}, not ${KEY_B.pubkey}`,
      1,
    ],
    [
      'not a keypair',
      CHECK,
      { printed: KEY_A.pubkey },
      'not a Solana keypair',
      1,
    ],
    [
      'a seed that does not give the public key',
      CHECK,
      {
        printed: `[${
          [...KEY_A.keypair.slice(0, 32), ...new Array(32).fill(5)].join(',')
        }]`,
      },
      'does not give the public key',
      1,
    ],
    [
      'op cannot read it',
      CHECK,
      { opFails: `[ERROR] ${TOKEN} denied` },
      'op could not read',
      1,
    ],
    [
      'a vault that is not the configured one',
      { ...CHECK, ref: refOf(OTHER_VAULT) },
      {},
      'not the vault configured for testnet',
      0,
    ],
  ]
  for (const [name, options, config, expected, ops] of cases) {
    const { result, started, op, captured } = await run(options, config)
    assertEquals(result, false, name)
    assertEquals(started, 0, name)
    assertEquals(op.calls.length, ops, name)
    assertEquals(captured.exitCode(), 1, name)
    const lines = [...captured.info, ...captured.error].join('\n')
    assertStringIncludes(lines, expected)
    assertEquals(holdsKey(lines, KEY_A), false, name)
  }
})

Deno.test('a file reference is read from the file and op is not run; a wrong network, a missing or malformed reference, a malformed --pubkey and mainnet with a token configured are refused before anything is read', async () => {
  const op = scriptedOp(() => ({ success: true }))
  const captured = captureIo()
  const file = await checkKey({
    network: 'testnet',
    ref: 'file:///home/op/.slv/keys/node.json',
    pubkey: KEY_A.pubkey,
  }, {
    setup: setupDeps(op.op, {
      readFile: (path) => {
        assertEquals(path, '/home/op/.slv/keys/node.json')
        return Promise.resolve(new TextEncoder().encode(KEY_A.canonical))
      },
    }),
    io: captured.io,
  })
  assertEquals(file, true)
  assertEquals(op.calls.length, 0)

  const cases: [
    string,
    Parameters<typeof run>[0],
    Parameters<typeof run>[1],
    string,
  ][] = [
    ['no network', { ref: refOf() }, {}, 'no network'],
    [
      'a network that does not exist',
      { network: 'localnet', ref: refOf() },
      {},
      '"localnet"',
    ],
    ['no reference', { network: 'testnet' }, {}, '--ref'],
    [
      'a reference by names',
      { ...CHECK, ref: 'op://Vault/Item/keypair' },
      {},
      'by their ids',
    ],
    [
      'a reference with a section',
      { ...CHECK, ref: `op://${VAULT}/${ITEM}/sec/keypair` },
      {},
      'no section',
    ],
    ['a pubkey that is none', { ...CHECK, pubkey: 'nope' }, {}, '--pubkey'],
    [
      'mainnet while a token is configured for testnet',
      { ...CHECK, network: 'mainnet' },
      {
        setupOverrides: {
          readConfig: () =>
            Promise.resolve({
              networks: {
                testnet: { vaultId: VAULT, tokenFile: '/home/op/token' },
              },
              identityAgent: null,
            }),
        },
      },
      'mainnet is refused while a 1Password service account token is configured',
    ],
  ]
  for (const [name, options, config, expected] of cases) {
    const { result, started, op: stub, captured: out } = await run(
      options,
      config,
    )
    assertEquals(result, false, name)
    assertEquals(started, 0, name)
    assertEquals(stub.calls.length, 0, name)
    assertEquals(out.exitCode(), 1, name)
    assertStringIncludes(out.error.join('\n'), expected)
  }
})

// --- the host form: keys:check -n <network> -p <host> ----------------------

const IDENTITY = KEY_A.pubkey
const VOTE_ACCOUNT = 'Vv'.repeat(22)
const NODE = 'node-1'

const hostInventory = (
  more: Record<string, string> = {},
  group = 'testnet_validators',
): string =>
  [
    `${group}:`,
    '  hosts:',
    `    ${NODE}:`,
    '      ansible_host: 203.0.113.7',
    '      ansible_user: solv',
    '      ansible_ssh_private_key_file: ~/.ssh/node_ed25519',
    `      identity_account: ${IDENTITY}`,
    `      vote_account: ${VOTE_ACCOUNT}`,
    '      validator_type: agave',
    ...Object.entries(more).map(([key, value]) => `      ${key}: ${value}`),
  ].join('\n')

type HostScenario = {
  inventoryText?: string | null
  answers?: string[]
  /** The node that the cluster names for the vote account. */
  chainNode?: string
  stake?: number
  chainFails?: boolean
  /** What the pubkey field of the item says. */
  pubkeyField?: string
  /** What the keypair field of the item says. */
  keyText?: string
  setupOverrides?: Parameters<typeof setupDeps>[1]
  terminal?: 'none'
}

const runHost = async (
  options: { network?: string; host?: string },
  scenario: HostScenario = {},
) => {
  const events: string[] = []
  const op = scriptedOp((call) => {
    const field = call.args[2]?.split('/').pop()
    events.push(`op:${field}`)
    return {
      success: true,
      stdout: field === 'pubkey'
        ? scenario.pubkeyField ?? IDENTITY
        : scenario.keyText ?? KEY_A.canonical,
    }
  })
  const captured = captureIo()
  const terminal = scriptedTty(scenario.answers ?? [NODE])
  const network = options.network ?? 'testnet'
  const inventoryText = scenario.inventoryText === undefined
    ? hostInventory({
      identity_ref: refOf(network === 'mainnet' ? OTHER_VAULT : VAULT),
    }, `${network}_validators`)
    : scenario.inventoryText
  const { value, started } = await countingProcesses(() =>
    checkKey({ host: NODE, network, ...options }, {
      setup: setupDeps(op.op, {
        readConfig: () => {
          events.push('config')
          return Promise.resolve({
            networks: {
              testnet: { vaultId: VAULT, tokenFile: null },
              mainnet: { vaultId: OTHER_VAULT, tokenFile: null },
            },
            identityAgent: null,
          })
        },
        readFile: (path) => {
          events.push(`file:${path}`)
          return Promise.resolve(new TextEncoder().encode(KEY_A.canonical))
        },
        ...scenario.setupOverrides,
      }),
      io: captured.io,
      tty: scenario.terminal === 'none'
        ? {
          say: () => Promise.reject(new Error('no tty')),
          ask: () => Promise.reject(new Error('no tty')),
        }
        : {
          say: (text) => terminal.tty.say(text),
          ask: (prompt) => {
            events.push('ask')
            return terminal.tty.ask(prompt)
          },
        },
      reader: {
        readText: () => {
          events.push('inventory')
          return Promise.resolve(inventoryText)
        },
        homeDir: '/home/op',
      },
      onchain: {
        fetch: () => {
          events.push('chain')
          if (scenario.chainFails) {
            return Promise.reject(new Error('ECONNRESET'))
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                result: {
                  current: [{
                    votePubkey: VOTE_ACCOUNT,
                    nodePubkey: scenario.chainNode ?? IDENTITY,
                    activatedStake: scenario.stake ?? 5,
                  }],
                  delinquent: [],
                },
              }),
            ),
          )
        },
      },
    })
  )
  return { result: value, started, op, captured, terminal, events }
}

Deno.test('keys:check -p <host> goes in order: where keys are resolved, the entry, the vault and the vote account on chain, the name typed by the person, the pubkey field of the item and then the key; it prints that the pubkey matches, starts no process, and nothing of the key', async () => {
  const { result, started, op, captured, terminal, events } = await runHost({})
  assertEquals(result, true, captured.error.join('\n'))
  assertEquals(started, 0)
  assertEquals(events, [
    'config',
    'inventory',
    'chain',
    'ask',
    'op:pubkey',
    'op:keypair',
  ])
  assertEquals(op.calls.map((call) => call.args), [
    ['read', '-n', refOf(VAULT, ITEM, 'pubkey')],
    ['read', '-n', refOf()],
  ])
  assertStringIncludes(terminal.said[0], `identity  ${IDENTITY}`)
  assertStringIncludes(terminal.said[0], `ref       ${refOf()}`)
  assertStringIncludes(terminal.asked[0], `Type the name of the host (${NODE})`)
  const lines = [...captured.info, ...captured.error, ...terminal.said].join(
    '\n',
  )
  assertStringIncludes(lines, 'pubkey matches')
  assertEquals(holdsKey(lines, KEY_A), false)
  assertEquals(captured.exitCode(), undefined)
})

Deno.test('when the vote account on chain does not name the identity_account, or has no stake on mainnet, or cannot be read, or the reference is in another vault, or the entry has no vote_account, nothing is asked and op is run 0 times', async () => {
  const cases: [string, Parameters<typeof runHost>[0], HostScenario, string][] =
    [
      [
        'another node on chain',
        {},
        { chainNode: KEY_B.pubkey },
        'not the identity_account',
      ],
      [
        'no stake on mainnet',
        { network: 'mainnet' },
        { stake: 0, setupOverrides: undefined },
        'no activated stake on mainnet',
      ],
      ['a chain that cannot be read', {}, { chainFails: true }, 'ECONNRESET'],
      [
        'a reference in another vault',
        {},
        {
          inventoryText: hostInventory({ identity_ref: refOf(OTHER_VAULT) }),
        },
        'not the vault configured for testnet',
      ],
      [
        'no vote_account',
        {},
        {
          inventoryText: hostInventory({ identity_ref: refOf() }).replace(
            `      vote_account: ${VOTE_ACCOUNT}\n`,
            '',
          ),
        },
        'has no vote_account',
      ],
    ]
  for (const [name, options, scenario, expected] of cases) {
    const { result, started, op, captured, terminal, events } = await runHost(
      options,
      scenario,
    )
    assertEquals(result, false, name)
    assertEquals(started, 0, name)
    assertEquals(op.calls.length, 0, `${name}: op was run`)
    assertEquals(terminal.asked, [], name)
    assertEquals(events.includes('ask'), false, name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error.join('\n'), expected)
  }
})

Deno.test('a name that is not the name of the host gives 0 reads of the key and of the item, and so does a terminal that cannot be opened', async () => {
  for (const answer of ['', 'node-2', 'NODE-1', 'node-1x', 'yes']) {
    const { result, op, captured } = await runHost({}, { answers: [answer] })
    assertEquals(result, false, answer)
    assertEquals(op.calls.length, 0, answer)
    assertStringIncludes(
      captured.error.join('\n'),
      'That is not the name of the host',
    )
  }
  const none = await runHost({}, { terminal: 'none' })
  assertEquals(none.result, false)
  assertEquals(none.op.calls.length, 0)
  assertStringIncludes(none.captured.error.join('\n'), '/dev/tty')
})

Deno.test('the item has to say whose key it is: a pubkey field that is not the identity_account, or a key that is not the keypair of it, is refused, and the first of them before the key is read', async () => {
  const field = await runHost({}, { pubkeyField: KEY_B.pubkey })
  assertEquals(field.result, false)
  assertEquals(field.op.calls.map((call) => call.args[2].split('/').pop()), [
    'pubkey',
  ])
  assertStringIncludes(field.captured.error.join('\n'), 'The key was not read')

  const other = await runHost({}, { keyText: KEY_B.canonical })
  assertEquals(other.result, false)
  assertStringIncludes(other.captured.error.join('\n'), `not ${IDENTITY}`)
  assertEquals(holdsKey(other.captured.error.join('\n'), KEY_B), false)
})

Deno.test('a host with no identity_ref is checked on its legacy key file with a warning, a host that is not in the inventory, an inventory that is not there, devnet and a mainnet with a token configured are refused before anything is read, and the name must be a name', async () => {
  const legacy = await runHost({}, { inventoryText: hostInventory() })
  assertEquals(legacy.result, true, legacy.captured.error.join('\n'))
  assertEquals(legacy.op.calls.length, 0)
  assertEquals(legacy.events.filter((e) => e.startsWith('file:')), [
    `file:/home/op/.slv/keys/${IDENTITY}.json`,
  ])
  assertStringIncludes(legacy.captured.info.join('\n'), 'no identity_ref')

  const cases: [string, Parameters<typeof runHost>[0], HostScenario, string][] =
    [
      [
        'an inventory that is not there',
        {},
        { inventoryText: null },
        'no inventory file',
      ],
      [
        'a host that is not in the inventory',
        { host: 'node-9' },
        {},
        'node-9 is not a host',
      ],
      ['devnet', { network: 'devnet' }, {}, 'devnet has none'],
      [
        'a name that is none',
        { host: '-n evil' },
        {},
        'is not the inventory name',
      ],
      [
        'an identity_ref that is no reference',
        {},
        {
          inventoryText: hostInventory({
            identity_ref: 'op://Vault/Item/keypair',
          }),
        },
        'by their ids',
      ],
      [
        'mainnet while a token is configured for testnet',
        { network: 'mainnet' },
        {
          setupOverrides: {
            readConfig: () =>
              Promise.resolve({
                networks: {
                  testnet: { vaultId: VAULT, tokenFile: '/home/op/token' },
                  mainnet: { vaultId: OTHER_VAULT, tokenFile: null },
                },
                identityAgent: null,
              }),
          },
        },
        'mainnet is refused while a 1Password service account token is configured',
      ],
    ]
  for (const [name, options, scenario, expected] of cases) {
    const { result, started, op, captured, events } = await runHost(
      options,
      scenario,
    )
    assertEquals(result, false, name)
    assertEquals(started, 0, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(events.includes('chain'), false, name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error.join('\n'), expected)
  }
})

Deno.test('keys:check imports no module that starts ssh or ansible', async () => {
  const source = await Deno.readTextFile(
    new URL('../../src/validator/keys/checkKey.ts', import.meta.url),
  )
  for (
    const forbidden of [
      'hardenedSsh',
      'runAnsible',
      'openSession',
      'Deno.Command',
    ]
  ) {
    assertEquals(source.includes(forbidden), false, forbidden)
  }
})
