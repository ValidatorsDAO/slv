import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { parse } from 'https://deno.land/std@0.202.0/yaml/parse.ts'
import { stringify } from 'https://deno.land/std@0.202.0/yaml/stringify.ts'
import {
  defaultImportDeps,
  type ImportDeps,
  importKey,
  type ImportOptions,
} from '/src/validator/keys/importKey.ts'
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

const IDENTITY = KEY_B.pubkey
const INVENTORY_PATH = '/home/op/.slv/inventory.testnet.validators.yml'
const KEY_PATH = `/home/op/.slv/keys/${IDENTITY}.json`
const REF = refOf(VAULT, ITEM, 'keypair')

const host = (name: string, identity: string, more: object = {}) => ({
  name,
  ansible_host: name === 'ams1' ? '203.0.113.7' : '203.0.113.8',
  ansible_user: 'solv',
  ansible_ssh_private_key_file: '~/.ssh/id_ed25519',
  identity_account: identity,
  vote_account: 'Vote111111111111111111111111111111111111111',
  authority_account: KEY_A.pubkey,
  validator_type: 'agave',
  snapshot_url: '',
  ...more,
})

// The JSON round trip drops the keys whose value is undefined, which stringify cannot write.
const inventoryOf = (hosts: Record<string, object>): string =>
  stringify(JSON.parse(JSON.stringify({ testnet_validators: { hosts } })))

/** ams1 and ams2 are one identity on two boxes; ams3 is another. */
const INVENTORY = inventoryOf({
  ams1: host('ams1', IDENTITY),
  ams2: host('ams2', IDENTITY),
  ams3: host('ams3', KEY_A.pubkey),
})

type Stored = { id: string; title: string; fields: Record<string, string> }

/** An op with a vault and the items that `item create` was given. */
const vaultOp = (
  options: {
    existing?: {
      id: string
      title: string
      fields?: Record<string, string>
    }[]
    readBack?: (field: string, stored: Stored) => OpAnswer
    createFails?: string
  } = {},
) => {
  const items: Stored[] = (options.existing ?? []).map((item) => ({
    ...item,
    fields: item.fields ?? {},
  }))
  const fake = scriptedOp((call: OpCall): OpAnswer => {
    const [a, b] = call.args
    if (a === 'vault' && b === 'list') {
      return {
        success: true,
        stdout: JSON.stringify([
          { id: VAULT, name: 'Validators' },
          { id: OTHER_VAULT, name: 'Company' },
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
  }, { recordStdin: true, keepStdin: true })
  return { ...fake, items }
}

const TESTNET: ImportOptions = { network: 'testnet', host: 'ams1' }

const run = async (
  options: ImportOptions,
  config: {
    inventory?: string | null
    /** What every read of the inventory after the first one gives. */
    laterInventory?: string
    keyFile?: Uint8Array | Error
    op?: ReturnType<typeof vaultOp>
    answers?: string[]
    vaultId?: string | null
    tokenFile?: string
    writeVault?: ImportDeps['writeVault']
    writeInventory?: ImportDeps['writeInventory']
    setupOverrides?: Parameters<typeof setupDeps>[1]
  } = {},
) => {
  const op = config.op ?? vaultOp()
  const captured = captureIo()
  const terminal = scriptedTty(config.answers ?? [])
  let inventory: string | null = config.inventory === undefined
    ? INVENTORY
    : config.inventory
  const writes: string[] = []
  const vaultWrites: [string, string][] = []
  const keyReads: string[] = []
  /** The buffers that readKeyFile gave, to look at when the verb is over. */
  const keyFiles: Uint8Array[] = []
  let inventoryReads = 0
  let tokenFileRead = false
  const result = await importKey(options, {
    setup: setupDeps(op.op, {
      readConfig: () =>
        Promise.resolve({
          networks: {
            testnet: {
              vaultId: config.vaultId === undefined ? VAULT : config.vaultId,
              tokenFile: config.tokenFile ?? null,
            },
          },
          identityAgent: null,
        }),
      policy: {
        readText: () => {
          tokenFileRead = true
          return Promise.resolve(`${TOKEN}\n`)
        },
        lstat: () => {
          tokenFileRead = true
          return Promise.reject(new Error('the token file is not read'))
        },
        uid: () => 1000,
      },
      ...config.setupOverrides,
    }),
    tty: terminal.tty,
    io: captured.io,
    homeDir: '/home/op',
    inventoryPath: () => INVENTORY_PATH,
    readText: () => {
      inventoryReads++
      return Promise.resolve(
        inventoryReads > 1 && config.laterInventory !== undefined
          ? config.laterInventory
          : inventory,
      )
    },
    writeInventory: config.writeInventory ?? ((_path, text) => {
      writes.push(text)
      inventory = text
      return Promise.resolve()
    }),
    readKeyFile: (path) => {
      keyReads.push(path)
      const file = config.keyFile ?? new TextEncoder().encode(KEY_B.canonical)
      if (file instanceof Error) return Promise.reject(file)
      const copy = file.slice()
      keyFiles.push(copy)
      return Promise.resolve(copy)
    },
    writeVault: config.writeVault ?? ((network, vaultId) => {
      vaultWrites.push([network, vaultId])
      return Promise.resolve()
    }),
  })
  return {
    result,
    op,
    captured,
    terminal,
    writes,
    vaultWrites,
    keyReads,
    keyFiles,
    inventory: () => inventory,
    tokenFileRead: () => tokenFileRead,
  }
}

const argsOf = (op: { calls: OpCall[] }) => op.calls.map((call) => call.args)

Deno.test('the key file goes to op on the stdin of `op item create` as the one canonical text: no argument and no environment of any call holds it, and no line of output does', async () => {
  const { result, op, captured, keyReads } = await run(TESTNET)
  assertEquals(result, true, captured.error.join('\n'))
  assertEquals(keyReads, [KEY_PATH])

  assertEquals(argsOf(op), [
    ['item', 'list', '--vault', VAULT, '--format', 'json'],
    ['item', 'create', '--vault', VAULT, '-'],
    ['item', 'list', '--vault', VAULT, '--format', 'json'],
    ['read', '-n', REF],
    ['read', '-n', refOf(VAULT, ITEM, 'pubkey')],
  ])
  // op prints the item it made; that output is not collected. The others are read.
  assertEquals(
    op.calls.map((call) => call.stdout),
    ['piped', 'null', 'piped', 'piped', 'piped'],
  )
  // The template is on stdin, titled with the public key.
  const create = op.calls[1]
  const stdinText = new TextDecoder().decode(create.stdin!)
  const template = JSON.parse(stdinText)
  assertEquals(template.title, IDENTITY)
  assertEquals(template.fields, [
    {
      id: 'keypair',
      label: 'keypair',
      type: 'CONCEALED',
      value: KEY_B.canonical,
    },
    { id: 'pubkey', label: 'pubkey', type: 'STRING', value: IDENTITY },
  ])
  // Positive control: the key is in the stdin of `item create`, and in no other place a call or a line could carry it.
  assertEquals(holdsKey(stdinText, KEY_B), true)
  assertEquals(stdinText.split(KEY_B.canonical).length - 1, 1)
  for (const call of op.calls) {
    for (const argument of call.args) {
      assertEquals(holdsKey(argument, KEY_B), false, argument)
      assertEquals(argument.includes(IDENTITY), false, argument)
    }
    assertEquals(holdsKey(JSON.stringify(call.env), KEY_B), false)
  }
  for (const call of op.calls.filter((c) => c !== create)) {
    assertEquals(call.stdinLength, null)
  }
  const lines = [...captured.info, ...captured.error].join('\n')
  assertEquals(holdsKey(lines, KEY_B), false)
})

Deno.test('the reference is written to every inventory entry that has the identity_account, and to no other, the rest of the inventory is as it was, and the key file is left where it is with a word to remove it after checking', async () => {
  const { result, captured, writes, inventory } = await run(TESTNET)
  assertEquals(result, true)
  assertEquals(writes.length, 1)
  const written = parse(inventory()!) as {
    testnet_validators: { hosts: Record<string, Record<string, unknown>> }
  }
  const before = parse(INVENTORY) as typeof written
  for (const name of ['ams1', 'ams2']) {
    assertEquals(written.testnet_validators.hosts[name].identity_ref, REF, name)
  }
  assertEquals(written.testnet_validators.hosts.ams3.identity_ref, undefined)
  // Nothing but the two references was added.
  for (const name of ['ams1', 'ams2']) {
    delete written.testnet_validators.hosts[name].identity_ref
  }
  assertEquals(written, before)

  const lines = captured.info.join('\n')
  assertStringIncludes(lines, REF)
  assertStringIncludes(lines, 'ams1, ams2')
  // The check of a host: the entry has the reference now.
  assertStringIncludes(lines, 'slv v keys:check -n testnet -p ams1')
  assertStringIncludes(lines, `The key file ${KEY_PATH} was not removed`)
  assertStringIncludes(
    lines,
    'Remove it yourself after you have checked the key',
  )
})

Deno.test('a read-back that is not the key that went in, or a pubkey field that is not its public key, or an item that cannot be created, leaves the inventory unchanged and writes nothing', async () => {
  const cases: [string, ReturnType<typeof vaultOp>, string][] = [
    [
      'another valid key comes back',
      vaultOp({
        readBack: (field, stored) => ({
          success: true,
          stdout: field === 'keypair' ? KEY_A.canonical : stored.fields[field],
        }),
      }),
      'does not hold the key that was imported',
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
          stdout: field === 'pubkey' ? KEY_A.pubkey : stored.fields[field],
        }),
      }),
      'not the public key of the key that was imported',
    ],
    [
      'op cannot create the item',
      vaultOp({ createFails: '[ERROR] the vault is read only' }),
      'op could not create the item: [ERROR] the vault is read only',
    ],
  ]
  for (const [name, op, expected] of cases) {
    const { result, captured, writes, inventory, vaultWrites } = await run(
      TESTNET,
      { op, vaultId: null, answers: [VAULT] },
    )
    assertEquals(result, false, name)
    assertEquals(writes, [], name)
    assertEquals(inventory(), INVENTORY, name)
    assertEquals(vaultWrites, [], name)
    assertEquals(captured.exitCode(), 1, name)
    // No success is announced.
    assertEquals(captured.info, [], name)
    const lines = captured.error.join('\n')
    assertStringIncludes(lines, expected)
    assertEquals(holdsKey(lines, KEY_B), false, name)
    assertEquals(holdsKey(lines, KEY_A), false, name)
  }
})

Deno.test('an identity_ref that an entry has already is not overwritten, whichever entry has it and whatever it says: nothing is asked of op, and the inventory is as it was', async () => {
  for (
    const [name, hosts] of [
      [
        'a peer has a file reference',
        {
          ams1: host('ams1', IDENTITY),
          ams2: host('ams2', IDENTITY, {
            identity_ref: 'file:///home/op/key.json',
          }),
        },
      ],
      [
        'the named host has an op reference',
        {
          ams1: host('ams1', IDENTITY, { identity_ref: refOf(OTHER_VAULT) }),
          ams2: host('ams2', IDENTITY),
        },
      ],
    ] as [string, Record<string, object>][]
  ) {
    const inventory = inventoryOf(hosts)
    const { result, op, captured, writes } = await run(TESTNET, { inventory })
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(writes, [], name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], 'does not overwrite a reference')
    assertStringIncludes(captured.error[0], 'has identity_ref')
  }

  // A reference that appears while the key is going into 1Password is not overwritten either.
  const op = vaultOp()
  const racing = await run(TESTNET, {
    op,
    laterInventory: inventoryOf({
      ams1: host('ams1', IDENTITY),
      ams2: host('ams2', IDENTITY, { identity_ref: refOf(OTHER_VAULT) }),
    }),
  })
  assertEquals(racing.result, false)
  assertEquals(racing.writes, [])
  assertEquals(racing.inventory(), INVENTORY)
  assertEquals(racing.captured.exitCode(), 1)
  assertEquals(racing.captured.info, [])
  assertStringIncludes(
    racing.captured.error[0],
    'does not overwrite a reference',
  )
  assertStringIncludes(
    racing.captured.error[0],
    `The item ${REF} is in the vault`,
  )
})

Deno.test('a service account configured for the network refuses before anything is asked of op or the token file is read', async () => {
  const { result, op, captured, tokenFileRead, writes, keyReads } = await run(
    TESTNET,
    { tokenFile: '/home/op/.slv/testnet.token' },
  )
  assertEquals(result, false)
  assertEquals(op.calls.length, 0)
  assertEquals(tokenFileRead(), false)
  assertEquals(writes, [])
  assertEquals(keyReads, [], 'the key file was read')
  assertEquals(captured.exitCode(), 1)
  assertStringIncludes(captured.error[0], 'does not run with a service account')
  assertStringIncludes(captured.error[0], 'keys:gen')
})

Deno.test('a key file that is not the key of the host, is no keypair or cannot be read is refused before anything is asked of op, without a word of its content', async () => {
  const cases: [string, Uint8Array | Error, string][] = [
    [
      'the key of another identity',
      new TextEncoder().encode(KEY_A.canonical),
      `not ${IDENTITY}`,
    ],
    [
      'text that is no keypair',
      new TextEncoder().encode('[1,2,3]'),
      'not a Solana keypair',
    ],
    [
      'a seed that does not give the public key',
      new TextEncoder().encode(
        `[${
          [...KEY_B.keypair.slice(0, 32), ...new Array(32).fill(5)].join(',')
        }]`,
      ),
      'does not give the public key',
    ],
    [
      'a file that cannot be read',
      new Error('EACCES: permission denied'),
      'EACCES',
    ],
  ]
  for (const [name, keyFile, expected] of cases) {
    const { result, op, captured, writes } = await run(TESTNET, { keyFile })
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(writes, [], name)
    assertEquals(captured.exitCode(), 1, name)
    const lines = captured.error.join('\n')
    assertStringIncludes(lines, expected)
    assertEquals(holdsKey(lines, KEY_B), false, name)
    assertEquals(holdsKey(lines, KEY_A), false, name)
  }
})

Deno.test('a network without a validator inventory, a missing host, a host that is not in the inventory, a missing inventory file, a key file path that cannot be used and a place where keys are not resolved are refused before anything is asked of op', async () => {
  const cases: [string, ImportOptions, Parameters<typeof run>[1], string][] = [
    [
      'devnet',
      { network: 'devnet', host: 'ams1' },
      {},
      'testnet or -n mainnet',
    ],
    ['no network', { host: 'ams1' }, {}, 'no network'],
    ['no host', { network: 'testnet' }, {}, '-p <inventory name'],
    [
      'an unknown host',
      { network: 'testnet', host: 'ams9' },
      {},
      'not a host of testnet_validators',
    ],
    [
      'no inventory file',
      TESTNET,
      { inventory: null },
      'there is no inventory file',
    ],
    [
      'a host without identity_account',
      TESTNET,
      {
        inventory: inventoryOf({
          ams1: { ...host('ams1', IDENTITY), identity_account: undefined },
        }),
      },
      'no identity_account',
    ],
    [
      'a relative key file',
      { ...TESTNET, file: 'key.json' },
      {},
      '--file takes an absolute path',
    ],
    [
      'a key file with a space in its path',
      { ...TESTNET, file: '/home/op/my keys/key.json' },
      {},
      '--file takes an absolute path',
    ],
    [
      'a key file path with a .. segment',
      { ...TESTNET, file: '/home/op/../key.json' },
      {},
      '--file takes an absolute path',
    ],
    [
      'no terminal',
      TESTNET,
      {
        setupOverrides: {
          context: {
            env: () => undefined,
            envNames: () => [],
            exists: () => Promise.resolve(false),
            canOpenTty: () => Promise.resolve(false),
          },
        },
      },
      'no terminal',
    ],
    [
      'the AI console',
      TESTNET,
      {
        setupOverrides: {
          context: {
            env: (name) =>
              name === 'SLV_EXECUTION_CONTEXT' ? 'ai-console' : undefined,
            envNames: () => ['SLV_EXECUTION_CONTEXT'],
            exists: () => Promise.resolve(false),
            canOpenTty: () => Promise.resolve(true),
          },
        },
      },
      'this does not run from the AI console',
    ],
  ]
  for (const [name, options, config, expected] of cases) {
    const { result, op, captured, writes, keyReads } = await run(
      options,
      config,
    )
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(writes, [], name)
    assertEquals(keyReads, [], `${name}: the key file was read`)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
  }
})

Deno.test('an item that has the public key as its title is not made a second time: op is asked for the list and for nothing else', async () => {
  const op = vaultOp({ existing: [{ id: 'z'.repeat(26), title: IDENTITY }] })
  const { result, captured, writes } = await run(TESTNET, { op })
  assertEquals(result, false)
  assertEquals(argsOf(op), [[
    'item',
    'list',
    '--vault',
    VAULT,
    '--format',
    'json',
  ]])
  assertEquals(writes, [])
  assertStringIncludes(captured.error[0], 'has an item titled')
  assertStringIncludes(captured.error[0], 'z'.repeat(26))
  // It names both ways on: remove the item and run again, or check it and set the reference by hand.
  assertStringIncludes(
    captured.error[0],
    'remove that item in 1Password and run keys:import again',
  )
  assertStringIncludes(
    captured.error[0],
    `slv v keys:check -n testnet --ref ${
      refOf(VAULT, 'z'.repeat(26))
    } --pubkey ${IDENTITY}`,
  )
  assertStringIncludes(captured.error[0], 'set identity_ref')
})

Deno.test('with no vault in keyless.yml the vaults are listed on the terminal and only the id of a listed one is taken; the vault is written to keyless.yml after the inventory, and not when the id is wrong', async () => {
  const first = await run(TESTNET, { vaultId: null, answers: [VAULT] })
  assertEquals(first.result, true, first.captured.error.join('\n'))
  assertEquals(argsOf(first.op)[0], ['vault', 'list', '--format', 'json'])
  assertStringIncludes(first.terminal.said[0], VAULT)
  assertEquals(first.vaultWrites, [['testnet', VAULT]])
  assertEquals(first.writes.length, 1)

  for (const answer of ['', 'abc', VAULT.toUpperCase()]) {
    const wrong = await run(TESTNET, { vaultId: null, answers: [answer] })
    assertEquals(wrong.result, false, answer)
    assertEquals(
      argsOf(wrong.op),
      [['vault', 'list', '--format', 'json']],
      answer,
    )
    assertEquals(wrong.vaultWrites, [], answer)
    assertEquals(wrong.writes, [], answer)
  }

  // A vault that cannot be written still leaves the inventory written, and says what to add.
  const unsaved = await run(TESTNET, {
    vaultId: null,
    answers: [VAULT],
    writeVault: () => Promise.reject(new Error('disk full')),
  })
  assertEquals(unsaved.result, false)
  assertEquals(unsaved.writes.length, 1)
  assertStringIncludes(
    unsaved.captured.error.join('\n'),
    `networks.testnet.vault_id: ${VAULT}`,
  )
})

Deno.test('with the files of the system: the inventory is replaced whole and keeps its mode, the key file stays with its content and its mode, and no other file is left', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'slv-import-' })
  try {
    const inventoryFile = `${dir}/inventory.testnet.validators.yml`
    const keyFile = `${dir}/key.json`
    await Deno.writeTextFile(inventoryFile, INVENTORY, { mode: 0o644 })
    await Deno.chmod(inventoryFile, 0o644)
    await Deno.writeTextFile(keyFile, KEY_B.canonical, { mode: 0o600 })

    const op = vaultOp()
    const captured = captureIo()
    const defaults = defaultImportDeps()
    const result = await importKey(
      { ...TESTNET, file: keyFile },
      {
        setup: setupDeps(op.op),
        tty: scriptedTty([]).tty,
        io: captured.io,
        homeDir: '/home/op',
        inventoryPath: () => inventoryFile,
        readText: defaults.readText,
        writeInventory: defaults.writeInventory,
        readKeyFile: defaults.readKeyFile,
        writeVault: () =>
          Promise.reject(new Error('the vault is in keyless.yml')),
      },
    )
    assertEquals(result, true, captured.error.join('\n'))
    const hosts = (parse(await Deno.readTextFile(inventoryFile)) as {
      testnet_validators: { hosts: Record<string, Record<string, unknown>> }
    }).testnet_validators.hosts
    assertEquals(hosts.ams1.identity_ref, REF)
    assertEquals(hosts.ams2.identity_ref, REF)
    assertEquals((await Deno.stat(inventoryFile)).mode! & 0o777, 0o644)
    // The key file was read and left alone.
    assertEquals(await Deno.readTextFile(keyFile), KEY_B.canonical)
    assertEquals((await Deno.stat(keyFile)).mode! & 0o777, 0o600)
    assertEquals(
      [...Deno.readDirSync(dir)].map((entry) => entry.name).sort(),
      ['inventory.testnet.validators.yml', 'key.json'],
    )
    assertStringIncludes(
      captured.info.join('\n'),
      `The key file ${keyFile} was not removed`,
    )

    // A file that is too big for a key file is refused by the reader.
    await Deno.writeTextFile(keyFile, ' '.repeat(20 * 1024))
    await Deno.writeTextFile(inventoryFile, INVENTORY)
    const big = captureIo()
    assertEquals(
      await importKey(
        { ...TESTNET, file: keyFile },
        {
          setup: setupDeps(vaultOp().op),
          tty: scriptedTty([]).tty,
          io: big.io,
          homeDir: '/home/op',
          inventoryPath: () => inventoryFile,
          readText: defaults.readText,
          writeInventory: defaults.writeInventory,
          readKeyFile: defaults.readKeyFile,
        },
      ),
      false,
    )
    assertStringIncludes(big.error[0], 'is not a key file')
    assert((await Deno.readTextFile(inventoryFile)) === INVENTORY)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('the buffer of the key file and the template that held the key are zero when the verb is over, on success and on every refusal after the file was read', async () => {
  const wrongKey = new TextEncoder().encode(KEY_A.canonical)
  const cases: [string, Parameters<typeof run>[1], boolean][] = [
    ['success', {}, true],
    ['a key file of another key', { keyFile: wrongKey }, false],
    ['text that is no keypair', {
      keyFile: new TextEncoder().encode('[1,2,3]'),
    }, false],
    ['op cannot create the item', {
      op: vaultOp({ createFails: '[ERROR] read only' }),
    }, true],
    [
      'the item does not read back as the key',
      {
        op: vaultOp({
          readBack: (field, stored) => ({
            success: true,
            stdout: field === 'keypair'
              ? KEY_A.canonical
              : stored.fields[field],
          }),
        }),
      },
      true,
    ],
    ['a reference that appears in the meantime', {
      laterInventory: inventoryOf({
        ams1: host('ams1', IDENTITY),
        ams2: host('ams2', IDENTITY, { identity_ref: refOf(OTHER_VAULT) }),
      }),
    }, true],
  ]
  for (const [name, config, createsItem] of cases) {
    const { keyFiles, op } = await run(TESTNET, config)
    assertEquals(keyFiles.length, 1, name)
    assertEquals(keyFiles[0].every((byte) => byte === 0), true, name)
    const created = op.calls.filter((call) => call.args[1] === 'create')
    assertEquals(created.length, createsItem ? 1 : 0, name)
    for (const call of created) {
      assertEquals(call.stdin!.some((byte) => byte !== 0), true, name)
      assertEquals(call.stdinRef!.every((byte) => byte === 0), true, name)
    }
  }
})

// --- an entry added later: the item is in the vault already ----------------

/** The item of REF as keys:import made it. */
const STORED = [{
  id: ITEM,
  title: IDENTITY,
  fields: { keypair: KEY_B.canonical, pubkey: IDENTITY },
}]

/** ams1 points at REF; ams2, which was added later, has the identity_account and no reference. */
const LATE = inventoryOf({
  ams1: host('ams1', IDENTITY, { identity_ref: REF }),
  ams2: host('ams2', IDENTITY),
  ams3: host('ams3', KEY_A.pubkey),
})

Deno.test('an entry added after the import gets the reference of the item that is in the vault already: no item is made, the stored key is read back against the key file, and only the entries that lack the reference get it', async () => {
  const op = vaultOp({ existing: STORED })
  const { result, captured, writes, inventory, keyReads } = await run(
    { network: 'testnet', host: 'ams2' },
    { inventory: LATE, op },
  )
  assertEquals(result, true, captured.error.join('\n'))
  // The vault was asked for its items, and the item was read back; nothing was created.
  assertEquals(op.calls.some((call) => call.args[1] === 'create'), false)
  assertEquals(op.calls.map((call) => call.args), [
    ['item', 'list', '--vault', VAULT, '--format', 'json'],
    ['read', '-n', REF],
    ['read', '-n', refOf(VAULT, ITEM, 'pubkey')],
  ])
  assertEquals(keyReads, [KEY_PATH])
  assertEquals(writes.length, 1)
  const written = parse(inventory()!) as {
    testnet_validators: { hosts: Record<string, Record<string, unknown>> }
  }
  const hosts = written.testnet_validators.hosts
  assertEquals(hosts.ams1.identity_ref, REF)
  assertEquals(hosts.ams2.identity_ref, REF)
  assertEquals(hosts.ams3.identity_ref, undefined)
  const lines = captured.info.join('\n')
  assertStringIncludes(lines, `hosts  ams2`)
  assertEquals(lines.includes('ams1,'), false)
  assertStringIncludes(lines, 'slv v keys:check -n testnet -p ams2')
  assertStringIncludes(lines, `The key file ${KEY_PATH} was not removed`)
  assertEquals(
    holdsKey([...captured.info, ...captured.error].join('\n'), KEY_B),
    false,
  )
})

Deno.test('when every entry of the identity points at the item already nothing is asked of op, read or written', async () => {
  const everyone = inventoryOf({
    ams1: host('ams1', IDENTITY, { identity_ref: REF }),
    ams2: host('ams2', IDENTITY, { identity_ref: REF }),
  })
  const { result, captured, op, writes, keyReads } = await run(
    { network: 'testnet', host: 'ams1' },
    { inventory: everyone },
  )
  assertEquals(result, true)
  assertEquals(op.calls.length, 0)
  assertEquals(writes, [])
  assertEquals(keyReads, [])
  assertStringIncludes(captured.info.join('\n'), 'Nothing was changed')
})

Deno.test('the item that an entry points at has to be there, be titled with the identity_account and hold the key of the file; otherwise nothing is written, and the advice does not say to remove an item', async () => {
  const cases: [string, ReturnType<typeof vaultOp>, string][] = [
    ['an item that is not in the vault', vaultOp(), 'has no item with that id'],
    [
      'an item with another title',
      vaultOp({
        existing: [{ ...STORED[0], title: 'something else' }],
      }),
      'is titled "something else"',
    ],
    [
      'an item that holds another key',
      vaultOp({
        existing: [{
          ...STORED[0],
          fields: { keypair: KEY_A.canonical, pubkey: IDENTITY },
        }],
      }),
      'does not hold the key that was read from the key file',
    ],
    [
      'an item whose pubkey field is another key',
      vaultOp({
        existing: [{
          ...STORED[0],
          fields: { keypair: KEY_B.canonical, pubkey: KEY_A.pubkey },
        }],
      }),
      'is not the public key of the key that was read from the key file',
    ],
  ]
  for (const [name, op, expected] of cases) {
    const { result, captured, writes, inventory } = await run(
      { network: 'testnet', host: 'ams2' },
      { inventory: LATE, op },
    )
    assertEquals(result, false, name)
    assertEquals(writes, [], name)
    assertEquals(inventory(), LATE, name)
    assertEquals(
      op.calls.some((call) => call.args[1] === 'create'),
      false,
      name,
    )
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
    assertEquals(captured.error[0].includes('remove that item'), false, name)
  }
})

Deno.test('a reference is shared only when the entries agree on it and it is in the configured vault: different references, a reference of another vault, a file reference and a reference that changes meanwhile are refused, and a different one is never overwritten', async () => {
  const OTHER_REF = refOf(VAULT, 'z'.repeat(26))
  const cases: [string, NonNullable<Parameters<typeof run>[1]>, string][] = [
    [
      'two entries with two references',
      {
        inventory: inventoryOf({
          ams1: host('ams1', IDENTITY, { identity_ref: REF }),
          ams2: host('ams2', IDENTITY, { identity_ref: OTHER_REF }),
          ams3: host('ams3', IDENTITY),
        }),
        op: vaultOp({ existing: STORED }),
      },
      'do not agree on the reference',
    ],
    [
      'a reference of another vault',
      {
        inventory: inventoryOf({
          ams1: host('ams1', IDENTITY, { identity_ref: refOf(OTHER_VAULT) }),
          ams2: host('ams2', IDENTITY),
        }),
        op: vaultOp({ existing: STORED }),
      },
      'not the vault configured for testnet',
    ],
    [
      'a file reference',
      {
        inventory: inventoryOf({
          ams1: host('ams1', IDENTITY, {
            identity_ref: 'file:///home/op/k.json',
          }),
          ams2: host('ams2', IDENTITY),
        }),
        op: vaultOp({ existing: STORED }),
      },
      'does not overwrite a reference',
    ],
    [
      'a different reference that appears while the item is being checked',
      {
        inventory: LATE,
        laterInventory: inventoryOf({
          ams1: host('ams1', IDENTITY, { identity_ref: REF }),
          ams2: host('ams2', IDENTITY, { identity_ref: OTHER_REF }),
        }),
        op: vaultOp({ existing: STORED }),
      },
      'does not overwrite a reference',
    ],
  ]
  for (const [name, config, expected] of cases) {
    const op = config.op!
    const { result, captured, writes, inventory } = await run(
      { network: 'testnet', host: 'ams2' },
      config,
    )
    assertEquals(result, false, name)
    assertEquals(writes, [], name)
    assertEquals(inventory(), config.inventory, name)
    assertEquals(
      op.calls.some((call) => call.args[1] === 'create'),
      false,
      name,
    )
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
  }
})

Deno.test('the attach path wipes the key file buffer too', async () => {
  const { keyFiles, op } = await run(
    { network: 'testnet', host: 'ams2' },
    { inventory: LATE, op: vaultOp({ existing: STORED }) },
  )
  assertEquals(keyFiles.length, 1)
  assertEquals(keyFiles[0].every((byte) => byte === 0), true)
  assertEquals(op.calls.filter((call) => call.args[1] === 'create'), [])
})
