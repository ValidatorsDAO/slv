import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from '@std/assert'
import { genKey, itemTemplate } from '/src/validator/keys/genKey.ts'
import {
  captureIo,
  holdsKey,
  ITEM,
  KEY_A,
  KEY_B,
  type OpAnswer,
  type OpCall,
  OTHER_VAULT,
  refOf,
  scriptedOp,
  scriptedTty,
  setupDeps,
  TOKEN,
  VAULT,
} from '/test/unit/_keylessFixtures.ts'

type Stored = { id: string; title: string; fields: Record<string, string> }

/** An op with a vault list and the items that `item create` was given. */
const vaultOp = (
  options: {
    readBack?: (field: string, stored: Stored) => OpAnswer
    createFails?: string
    twoItems?: boolean
  } = {},
) => {
  const items: Stored[] = []
  const fake = scriptedOp((call: OpCall): OpAnswer => {
    const [a, b] = call.args
    if (a === 'vault' && b === 'list') {
      return {
        success: true,
        stdout: JSON.stringify([
          { id: VAULT, name: 'Testnet lab' },
          { id: OTHER_VAULT, name: 'Prod\u001b[31m vault' },
        ]),
      }
    }
    if (a === 'item' && b === 'list') {
      return {
        success: true,
        stdout: JSON.stringify(
          items.map((item) => ({ id: item.id, title: item.title })),
        ),
      }
    }
    if (a === 'item' && b === 'create') {
      if (options.createFails !== undefined) {
        return { success: false, stderr: options.createFails }
      }
      const template = JSON.parse(new TextDecoder().decode(call.stdin!))
      const fields: Record<string, string> = {}
      for (const field of template.fields) fields[field.label] = field.value
      items.push({ id: ITEM, title: template.title, fields })
      if (options.twoItems) {
        items.push({ id: 'z'.repeat(26), title: template.title, fields })
      }
      // What a real op prints about the new item: the key is in it.
      return { success: true, stdout: JSON.stringify(template) }
    }
    if (a === 'read') {
      const [, item, field] = call.args[2].slice('op://'.length).split('/')
      const stored = items.find((i) => i.id === item)
      if (stored === undefined) return { success: false, stderr: 'no item' }
      return options.readBack?.(field, stored) ??
        { success: true, stdout: stored.fields[field] }
    }
    return { success: false, stderr: 'unexpected' }
  }, { recordStdin: true })
  return { ...fake, items }
}

const run = async (
  options: { network?: string; title?: string },
  config: {
    vaultId?: string | null
    op?: ReturnType<typeof vaultOp>
    answers?: string[]
    made?: Uint8Array
    writeVault?: (network: string, vaultId: string) => Promise<void>
    setupOverrides?: Parameters<typeof setupDeps>[1]
  } = {},
) => {
  const op = config.op ?? vaultOp()
  const captured = captureIo()
  const terminal = scriptedTty(config.answers ?? [])
  const written: [string, string][] = []
  const made = config.made ?? KEY_A.keypair.slice()
  const result = await genKey(options, {
    setup: setupDeps(op.op, {
      readConfig: () =>
        Promise.resolve({
          networks: {
            testnet: {
              vaultId: config.vaultId === undefined ? VAULT : config.vaultId,
              tokenFile: null,
            },
          },
          identityAgent: null,
        }),
      ...config.setupOverrides,
    }),
    tty: terminal.tty,
    io: captured.io,
    generate: () => Promise.resolve(made),
    writeVault: config.writeVault ??
      ((network, vaultId) => {
        written.push([network, vaultId])
        return Promise.resolve()
      }),
  })
  return { result, op, captured, terminal, written, made }
}

const TESTNET = { network: 'testnet', title: 'lab key 1' }

/** keyless.yml gives the network a service account token file, and the file is as it has to be. */
const withToken = (
  vaultId: string | null,
): Parameters<typeof setupDeps>[1] => ({
  readConfig: () =>
    Promise.resolve({
      networks: { testnet: { vaultId, tokenFile: '/home/op/.slv/token' } },
      identityAgent: null,
    }),
  policy: {
    readText: () => Promise.resolve(`${TOKEN}\n`),
    lstat: () =>
      Promise.resolve({
        isFile: true,
        isSymlink: false,
        mode: 0o100600,
        uid: 1000,
      }),
    uid: () => 1000,
  },
})

Deno.test('a key made in memory goes to 1Password on the stdin of `op item create`, is read back equal, and only its public key and reference are printed; no argument, environment or line of output holds it', async () => {
  const { result, op, captured, written, made } = await run(TESTNET)
  assertEquals(result, true)
  assertEquals(captured.exitCode(), undefined)

  assertEquals(op.calls.map((call) => call.args), [
    ['item', 'list', '--vault', VAULT, '--format', 'json'],
    ['item', 'create', '--vault', VAULT, '-'],
    ['item', 'list', '--vault', VAULT, '--format', 'json'],
    ['read', '-n', refOf()],
    ['read', '-n', refOf(VAULT, ITEM, 'pubkey')],
  ])
  // The template is on stdin: the key once, and its public key; positive control for the checks below.
  const create = op.calls[1]
  const template = JSON.parse(new TextDecoder().decode(create.stdin!))
  assertEquals(template.title, 'lab key 1')
  assertEquals(template.fields, [
    {
      id: 'keypair',
      label: 'keypair',
      type: 'CONCEALED',
      value: KEY_A.canonical,
    },
    { id: 'pubkey', label: 'pubkey', type: 'STRING', value: KEY_A.pubkey },
  ])
  assertEquals(
    new TextDecoder().decode(create.stdin!).split(KEY_A.canonical).length - 1,
    1,
  )
  // Every call of op runs with caching off, whatever the parent has.
  assertEquals(
    op.calls.map((call) => call.env.OP_CACHE),
    ['false', 'false', 'false', 'false', 'false'],
  )
  // op prints the item it made; that output is not collected. The others are read.
  assertEquals(
    op.calls.map((call) => call.stdout),
    ['piped', 'null', 'piped', 'piped', 'piped'],
  )
  // Not in any argument or environment of any call, nor in what was written.
  const outside = JSON.stringify(
    op.calls.map((c) => [c.command, c.args, c.env]),
  )
  assertEquals(holdsKey(outside, KEY_A), false)
  const lines = [...captured.info, ...captured.error].join('\n')
  assertEquals(holdsKey(lines, KEY_A), false)
  assertStringIncludes(lines, KEY_A.pubkey)
  assertStringIncludes(lines, refOf())
  // The buffers are wiped, and the vault was configured, so nothing is written to keyless.yml.
  assertEquals(made.every((byte) => byte === 0), true)
  assertEquals(written, [])
  assertEquals(
    op.calls.some((call) => call.args[0] === 'vault'),
    false,
  )
})

Deno.test('the template is JSON with the key placed into it as bytes, and the title is escaped', () => {
  const template = itemTemplate(
    'say "hi"\\',
    KEY_B.pubkey,
    new TextEncoder().encode(KEY_B.canonical),
  )
  const parsed = JSON.parse(new TextDecoder().decode(template))
  assertEquals(parsed.title, 'say "hi"\\')
  assertEquals(parsed.category, 'API_CREDENTIAL')
  assertEquals(parsed.fields[0].value, KEY_B.canonical)
  assertEquals(parsed.fields[1].value, KEY_B.pubkey)
})

Deno.test('with no vault in keyless.yml the vaults of op are listed on the terminal, only the id of a listed one is taken, and the vault is written to keyless.yml after the key is saved and read back', async () => {
  const { result, op, terminal, written, captured } = await run(TESTNET, {
    vaultId: null,
    answers: [VAULT],
  })
  assertEquals(result, true)
  assertEquals(op.calls[0].args, ['vault', 'list', '--format', 'json'])
  // The listing, the creation and the reads all run with caching off.
  assertEquals(op.calls.length, 6)
  assertEquals(op.calls.every((call) => call.env.OP_CACHE === 'false'), true)
  assertStringIncludes(terminal.said[0], VAULT)
  assertStringIncludes(terminal.said[0], 'Testnet lab')
  assertStringIncludes(terminal.said[0], OTHER_VAULT)
  // The control character in a name is gone.
  assertEquals(terminal.said[0].includes('\u001b'), false)
  assertEquals(written, [['testnet', VAULT]])
  assertEquals(captured.exitCode(), undefined)

  // Any other answer: nothing is saved or written.
  for (
    const answer of ['', 'abc', VAULT.toUpperCase(), `${VAULT} `.trim() + 'x']
  ) {
    const stopped = await run(TESTNET, { vaultId: null, answers: [answer] })
    assertEquals(stopped.result, false, answer)
    assertEquals(
      stopped.op.calls.map((call) => call.args[1]),
      ['list'],
      answer,
    )
    assertEquals(stopped.written, [], answer)
    assertEquals(stopped.captured.exitCode(), 1, answer)
  }
})

Deno.test('a read-back that is not the key that was made, a pubkey field that is not its public key, an item that cannot be found, and a create that fails, give no reference and write nothing', async () => {
  const cases: [
    string,
    ReturnType<typeof vaultOp>,
    string,
  ][] = [
    [
      'another valid key comes back',
      vaultOp({
        readBack: (field, stored) => ({
          success: true,
          stdout: field === 'keypair' ? KEY_B.canonical : stored.fields[field],
        }),
      }),
      'does not hold the key that was made',
    ],
    [
      'the key comes back unreadable',
      vaultOp({
        readBack: (field, stored) => ({
          success: true,
          stdout: field === 'keypair' ? '[1,2,3]' : stored.fields[field],
        }),
      }),
      'not a Solana keypair',
    ],
    [
      'the pubkey field is another key',
      vaultOp({
        readBack: (field, stored) => ({
          success: true,
          stdout: field === 'pubkey' ? KEY_B.pubkey : stored.fields[field],
        }),
      }),
      'not the public key of the key that was made',
    ],
    [
      'two new items have the title',
      vaultOp({ twoItems: true }),
      '2 new items',
    ],
    [
      'op cannot create the item',
      vaultOp({ createFails: `[ERROR] ${TOKEN} may not write here\nmore` }),
      'op could not create the item: [ERROR] [removed] may not write here',
    ],
  ]
  for (const [name, op, expected] of cases) {
    const { result, captured, written } = await run(TESTNET, {
      vaultId: null,
      answers: [VAULT],
      op,
      setupOverrides: name === 'op cannot create the item'
        ? withToken(null)
        : undefined,
    })
    assertEquals(result, false, name)
    assertEquals(written, [], name)
    assertEquals(captured.exitCode(), 1, name)
    const lines = [...captured.info, ...captured.error].join('\n')
    assertStringIncludes(lines, expected)
    // No success is announced: no line with the public key and the reference of a new key.
    assertEquals(captured.info, [], name)
    assertEquals(holdsKey(lines, KEY_A), false, name)
    assertEquals(holdsKey(lines, KEY_B), false, name)
    assertEquals(lines.includes(TOKEN), false, name)
  }
})

Deno.test('a network that is not testnet or devnet, a title that is not 1 to 80 printable characters, and every place where keys are not resolved, are refused before op runs', async () => {
  const cases: [string, { network?: string; title?: string }, string][] = [
    ['mainnet', { network: 'mainnet', title: 't' }, 'testnet or -n devnet'],
    ['no network', { title: 't' }, 'no network'],
    ['no title', { network: 'testnet' }, '--title'],
    ['empty title', { network: 'testnet', title: '  ' }, '--title'],
    ['a long title', { network: 'testnet', title: 'x'.repeat(81) }, '--title'],
    ['a non-ASCII title', { network: 'testnet', title: 'キー' }, '--title'],
  ]
  for (const [name, options, expected] of cases) {
    const { result, op, captured } = await run(options)
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, name)
    assertStringIncludes(captured.error[0], expected)
  }
  // The context of keys:check and keys:try holds here too: no terminal.
  const { result, op, captured } = await run(TESTNET, {
    setupOverrides: {
      context: {
        env: () => undefined,
        envNames: () => [],
        exists: () => Promise.resolve(false),
        canOpenTty: () => Promise.resolve(false),
      },
    },
  })
  assertEquals(result, false)
  assertEquals(op.calls.length, 0)
  assertStringIncludes(captured.error[0], 'no terminal')
  assertNotEquals(captured.exitCode(), undefined)
})

Deno.test('a vault that cannot be written to keyless.yml after the key is saved still prints the reference, says what to add, and fails', async () => {
  const { result, captured } = await run(TESTNET, {
    vaultId: null,
    answers: [VAULT],
    writeVault: () => Promise.reject(new Error('disk full')),
  })
  assertEquals(result, false)
  assertEquals(captured.exitCode(), 1)
  const lines = [...captured.info, ...captured.error].join('\n')
  assertStringIncludes(lines, refOf())
  assertStringIncludes(lines, `networks.testnet.vault_id: ${VAULT}`)
  assertStringIncludes(lines, 'disk full')
  assert(!holdsKey(lines, KEY_A))
})
