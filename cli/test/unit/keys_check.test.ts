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
  options: { network?: string; ref?: string; pubkey?: string },
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

const CHECK = { network: 'testnet', ref: refOf() }

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

  // Without --pubkey it only shows the public key.
  const bare = await run(CHECK, {
    printed: `[ ${[...KEY_B.keypair].join(', ')} ]\n`,
  })
  assertEquals(bare.result, true)
  assertStringIncludes(bare.captured.info.join('\n'), KEY_B.pubkey)
  assertEquals(bare.captured.info.join('\n').includes('matches'), false)
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
      { network: 'testnet', ref: 'op://Vault/Item/keypair' },
      {},
      'by their ids',
    ],
    [
      'a reference with a section',
      { network: 'testnet', ref: `op://${VAULT}/${ITEM}/sec/keypair` },
      {},
      'no section',
    ],
    ['a pubkey that is none', { ...CHECK, pubkey: 'nope' }, {}, '--pubkey'],
    [
      'mainnet while a token is configured for testnet',
      { network: 'mainnet', ref: refOf() },
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
