import { assertEquals, assertStringIncludes } from '@std/assert'
import { type PinDeps, pinHost, scanArgs } from '/src/validator/keys/pinHost.ts'
import { captureIo, scriptedTty } from '/test/unit/_keylessFixtures.ts'

const ED_1 =
  'AAAAC3NzaC1lZDI1NTE5AAAAIJey4pRQbkl/YXPZyv2N/7zA86yiJjBKa87y5SxxyeL+'
const ED_1_FINGERPRINT = 'SHA256:tug+Nsa0W463DpKSTAmfelWUhRYIv+k250avQuKO3ko'
const ED_2 =
  'AAAAC3NzaC1lZDI1NTE5AAAAINJvnBfiD9Vj3rDfZh0fZPrTa41lMuHZFPhOX2t3h8cu'
const ED_2_FINGERPRINT = 'SHA256:SHwFuOAyKZj8ZjqNCQ/vL81gV2+1z4DOqBG8tb6N29k'
const ECDSA =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBB68ouA1ARfIAE5QVraNOngbAfGa3bfKN3KChxGJaxadLEKoKm4XcL9HcBLaLtHeEbhTyVg7EnnFebM/2Q5goGE='
const ECDSA_FINGERPRINT = 'SHA256:1j1u8Q0RcXVX4di7UyVfNPwZ+Lo1EDhq0LU4xYrQGM4'
// The line that `ssh-keygen -H` made of `[127.0.0.1]:22888 ssh-ed25519 <ED_1>`.
const HASHED =
  `|1|AA6wnhUQ5EwF0aRbtbW4LKM8EYk=|asIkW5lnKAvgLId6WtffxsbEMFM= ssh-ed25519 ${ED_1}`

const PINS = '/home/op/.slv/known_hosts'

const inventory = (host: string, port: number): string =>
  [
    'testnet_validators:',
    '  hosts:',
    '    node-1:',
    `      ansible_host: ${host}`,
    `      ansible_port: ${port}`,
    '      ansible_user: solv',
    '      ansible_ssh_private_key_file: ~/.ssh/node_ed25519',
    '      identity_account: 586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5',
    '      validator_type: agave',
  ].join('\n')

type Setup = {
  userKnownHosts?: string | null
  pins?: string | null
  scan?: string | (() => Promise<string>)
  answers?: string[]
  inventoryText?: string
  noTerminal?: boolean
}

const run = async (
  options: { network?: string; host?: string },
  setup: Setup,
) => {
  const captured = captureIo()
  const terminal = scriptedTty(setup.answers ?? ['yes'])
  const scans: [string, number][] = []
  const writes: { path: string; text: string }[] = []
  let pins = setup.pins ?? null
  const deps: PinDeps = {
    reader: {
      readText: () =>
        Promise.resolve(setup.inventoryText ?? inventory('127.0.0.1', 22888)),
      homeDir: '/home/op',
    },
    readUserKnownHosts: () => Promise.resolve(setup.userKnownHosts ?? null),
    pins: {
      readText: () => Promise.resolve(pins),
      writeText: (path, text) => {
        writes.push({ path, text })
        pins = text
        return Promise.resolve()
      },
    },
    pinsPath: PINS,
    scan: (host, port) => {
      scans.push([host, port])
      const scan = setup.scan ?? ''
      return typeof scan === 'string' ? Promise.resolve(scan) : scan()
    },
    identityAgent: () => Promise.resolve(null),
    tty: setup.noTerminal
      ? {
        say: () => Promise.reject(new Error('no tty')),
        ask: () => Promise.reject(new Error('no tty')),
      }
      : terminal.tty,
    io: captured.io,
  }
  const result = await pinHost(options, deps)
  return { result, captured, terminal, scans, writes }
}

const TESTNET = { network: 'testnet', host: 'node-1' }
const ALIAS = '[127.0.0.1]:22888'

Deno.test('a key that ~/.ssh/known_hosts holds for the node, in its hashed form too, is shown with its fingerprint and pinned under [address]:port after yes is typed, and ssh-keyscan is not run', async () => {
  for (const known of [HASHED, `${ALIAS} ssh-ed25519 ${ED_1} laptop`]) {
    const { result, captured, terminal, scans, writes } = await run(TESTNET, {
      userKnownHosts: `# comment\n${known}\n`,
    })
    assertEquals(result, true)
    assertEquals(scans, [])
    assertEquals(writes, [{
      path: PINS,
      text: `${ALIAS} ssh-ed25519 ${ED_1}\n`,
    }])
    assertStringIncludes(terminal.said[0], 'already holds these keys')
    assertStringIncludes(terminal.said[0], ED_1_FINGERPRINT)
    assertStringIncludes(terminal.asked[0], 'Type yes')
    assertEquals(captured.exitCode(), undefined)
    assertStringIncludes(captured.info[0], 'Pinned node-1')
  }
})

Deno.test('a node that ~/.ssh/known_hosts does not hold is scanned, the keys are shown as unverified with their fingerprints, and they are pinned after yes is typed', async () => {
  const scan = [
    '# 127.0.0.1:22888 SSH-2.0-OpenSSH_9.6',
    `${ALIAS} ssh-ed25519 ${ED_1}`,
    `${ALIAS} ssh-ed25519 ${ED_2}`,
  ].join('\n')
  const { result, terminal, scans, writes } = await run(TESTNET, {
    userKnownHosts: `203.0.113.9 ssh-ed25519 ${ED_2}\n`,
    pins: '[10.0.0.1]:22 ssh-ed25519 AAAA\n',
    scan,
  })
  assertEquals(result, true)
  assertEquals(scans, [['127.0.0.1', 22888]])
  assertStringIncludes(terminal.said[0], 'not in your ~/.ssh/known_hosts')
  assertStringIncludes(terminal.said[0], 'nothing proves')
  assertStringIncludes(terminal.said[0], ED_1_FINGERPRINT)
  assertStringIncludes(terminal.said[0], ED_2_FINGERPRINT)
  // What was in the pins stays, and the new lines are added to it.
  assertEquals(writes, [{
    path: PINS,
    text:
      `[10.0.0.1]:22 ssh-ed25519 AAAA\n${ALIAS} ssh-ed25519 ${ED_1}\n${ALIAS} ssh-ed25519 ${ED_2}\n`,
  }])
})

Deno.test('anything but yes writes nothing and fails, and so does a terminal that cannot be opened', async () => {
  for (const answer of ['no', '', 'y', 'YES', 'yes please', 'Yes']) {
    for (
      const setup of [
        { userKnownHosts: `${HASHED}\n` },
        { scan: `${ALIAS} ssh-ed25519 ${ED_1}` },
      ]
    ) {
      const { result, captured, writes } = await run(TESTNET, {
        ...setup,
        answers: [answer],
      })
      assertEquals(result, false, answer)
      assertEquals(writes, [], answer)
      assertEquals(captured.exitCode(), 1, answer)
      assertStringIncludes(captured.error[0], 'Not pinned')
    }
  }
  const { result, captured, writes } = await run(TESTNET, {
    scan: `${ALIAS} ssh-ed25519 ${ED_1}`,
    noTerminal: true,
  })
  assertEquals(result, false)
  assertEquals(writes, [])
  assertStringIncludes(captured.error[0], '/dev/tty')
})

Deno.test('a node that is pinned already is left as it is: nothing is asked, scanned or written, and a different key is never put in its place', async () => {
  const { result, captured, terminal, scans, writes } = await run(TESTNET, {
    pins: `${ALIAS} ssh-ed25519 ${ED_2}\n`,
    userKnownHosts: `${HASHED}\n`,
    scan: `${ALIAS} ssh-ed25519 ${ED_1}`,
  })
  assertEquals(result, true)
  assertEquals(scans, [])
  assertEquals(writes, [])
  assertEquals(terminal.asked, [])
  assertStringIncludes(captured.info[0], 'is pinned already')
  assertStringIncludes(captured.info[0], ED_2_FINGERPRINT)
  assertEquals(captured.info[0].includes(ED_1_FINGERPRINT), false)
})

Deno.test('a network that is not testnet or mainnet, a missing host name, a host that is not in the inventory and a node that gives no key are refused, and nothing is written', async () => {
  const cases: [string, { network?: string; host?: string }, Setup, string][] =
    [
      [
        'devnet',
        { network: 'devnet', host: 'node-1' },
        {},
        'testnet or -n mainnet',
      ],
      ['no network', { host: 'node-1' }, {}, 'no network'],
      ['no host', { network: 'testnet' }, {}, '-p <inventory name'],
      [
        'unknown host',
        { network: 'testnet', host: 'node-9' },
        {},
        'not a host of testnet_validators',
      ],
      [
        'a host that could run something',
        TESTNET,
        { inventoryText: inventory('"-oProxyCommand=id"', 22) },
        'ansible_host',
      ],
      [
        'no key from the scan',
        TESTNET,
        { scan: '# nothing\n' },
        'returned no ssh-ed25519 key',
      ],
      [
        'a scan that fails',
        TESTNET,
        { scan: () => Promise.reject(new Error('Connection refused')) },
        'Connection refused',
      ],
    ]
  for (const [name, options, setup, expected] of cases) {
    const { result, captured, writes } = await run(options, setup)
    assertEquals(result, false, name)
    assertEquals(writes, [], name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
  }
  // Mainnet is allowed: a pin is no secret.
  const mainnet = await run({ network: 'mainnet', host: 'node-1' }, {
    inventoryText: inventory('127.0.0.1', 22888).replace(
      'testnet_validators',
      'mainnet_validators',
    ),
    scan: `${ALIAS} ssh-ed25519 ${ED_1}`,
  })
  assertEquals(mainnet.result, true)
})

Deno.test('only the ssh-ed25519 key is scanned for, shown and pinned: the other key types that a scan or ~/.ssh/known_hosts holds are left out, and a node with no ed25519 key is refused with nothing written', async () => {
  // ssh-keyscan is asked for the one type, and the arguments say nothing of the others.
  const args = scanArgs('127.0.0.1', 22888)
  assertEquals(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), [
    '-t',
    'ed25519',
  ])
  assertEquals(args.join(' ').includes('ecdsa'), false)
  assertEquals(args.join(' ').includes('rsa'), false)

  // A scan that answers with an ed25519 key and with keys of other types (an attacker on the path answers the probes of the types that the person did not check) pins the ed25519 key only.
  const scan = [
    `${ALIAS} ssh-ed25519 ${ED_1}`,
    `${ALIAS} ecdsa-sha2-nistp256 ${ECDSA}`,
    `${ALIAS} ssh-rsa ${ED_1}`,
  ].join('\n')
  const scanned = await run(TESTNET, { scan })
  assertEquals(scanned.result, true)
  assertEquals(scanned.writes, [{
    path: PINS,
    text: `${ALIAS} ssh-ed25519 ${ED_1}\n`,
  }])
  assertStringIncludes(scanned.terminal.said[0], ED_1_FINGERPRINT)
  assertEquals(scanned.terminal.said[0].includes(ECDSA_FINGERPRINT), false)

  // The same from the keys that ~/.ssh/known_hosts holds.
  const known = await run(TESTNET, {
    userKnownHosts:
      `${ALIAS} ssh-ed25519 ${ED_1}\n${ALIAS} ecdsa-sha2-nistp256 ${ECDSA}\n`,
  })
  assertEquals(known.result, true)
  assertEquals(known.scans, [])
  assertEquals(known.writes, [{
    path: PINS,
    text: `${ALIAS} ssh-ed25519 ${ED_1}\n`,
  }])

  // A node with an ECDSA key alone, from either source, is not pinned.
  for (
    const setup of [
      { scan: `${ALIAS} ecdsa-sha2-nistp256 ${ECDSA}` },
      {
        userKnownHosts: `${ALIAS} ecdsa-sha2-nistp256 ${ECDSA}\n`,
        scan: '# nothing\n',
      },
    ]
  ) {
    const refused = await run(TESTNET, setup)
    assertEquals(refused.result, false)
    assertEquals(refused.writes, [])
    assertEquals(refused.captured.exitCode(), 1)
    assertStringIncludes(refused.captured.error[0], 'no ssh-ed25519 key')
  }
})
