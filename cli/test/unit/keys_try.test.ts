import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from '@std/assert'
import { encodeBase58 } from '/lib/secret/base58.ts'
import { zero } from '/lib/secret/keypairBytes.ts'
import {
  SshRefusal,
  type SshRunResult,
  type SshSession,
} from '/lib/ssh/hardenedSsh.ts'
import type { SshTarget } from '/lib/ssh/sshTarget.ts'
import { type TryDeps, tryKey } from '/src/validator/keys/tryKey.ts'
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
  VAULT,
} from '/test/unit/_keylessFixtures.ts'

// The key that is tried is KEY_B. KEY_A is the unstaked identity of the node.
const TRIED = KEY_B.pubkey
const UNSTAKED = KEY_A.pubkey
const STAKED = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'
const VOTE = 'Vote111111111111111111111111111111111111111'

const inventory = (type = 'agave'): string =>
  [
    'testnet_validators:',
    '  hosts:',
    '    node-1:',
    '      ansible_host: 203.0.113.7',
    '      ansible_port: 2222',
    '      ansible_user: solv',
    '      ansible_ssh_private_key_file: ~/.ssh/node_ed25519',
    `      identity_account: ${STAKED}`,
    `      vote_account: ${VOTE}`,
    `      validator_type: ${type}`,
  ].join('\n')

type Node = {
  /** The identity that the node runs when keys:try starts. */
  running?: string
  /** The public key of /home/solv/unstaked-identity.json. */
  unstakedFile?: string | null
  aliveFails?: boolean
  /** What set-identity with the key comes to: it is applied unless it fails. */
  set?: 'ok' | 'failed' | 'failed-applied' | 'timeout-applied' | 'throws'
  /** The first contact-info after the key was set fails. */
  contactInfoFailsAfterSet?: boolean
  /** The node runs this identity from the second reading on. */
  movesAway?: string
  /** This many calls to set the node back fail before one works; Infinity: none does. */
  revertFailures?: number
}

type Run = { name: string; flag?: string; stdinLength: number | null }

/** A node that keeps an identity, and the session that talks to it. */
const fakeNode = (node: Node, events: string[]) => {
  let identity = node.running ?? UNSTAKED
  let readings = 0
  let revertsFailed = 0
  let keySet = false
  let failedOnce = false
  const runs: Run[] = []
  let closed = false
  const ok = (stdout = ''): SshRunResult => ({
    outcome: 'ok',
    code: 0,
    stdout,
    stderrLine: '',
  })
  const failed = (stderrLine = ''): SshRunResult => ({
    outcome: 'failed',
    code: 1,
    stdout: '',
    stderrLine,
  })
  const session: SshSession = {
    target: {} as SshTarget,
    run: (name, options = {}) => {
      runs.push({
        name,
        flag: options.flag,
        stdinLength: options.stdin?.length ?? null,
      })
      events.push(`ssh:${name}`)
      switch (name) {
        case 'alive':
          return Promise.resolve(
            node.aliveFails ? failed('Connection timed out') : ok(),
          )
        case 'guardContactInfo': {
          readings++
          if (node.contactInfoFailsAfterSet && keySet && !failedOnce) {
            failedOnce = true
            return Promise.resolve(failed('admin rpc unavailable'))
          }
          if (node.movesAway !== undefined && readings >= 2) {
            identity = node.movesAway
          }
          return Promise.resolve(
            ok(`{"id": "${identity}", "gossip": "1.2.3.4:8001"}`),
          )
        }
        case 'unstakedPubkey':
          return Promise.resolve(
            node.unstakedFile === null
              ? failed('No such file')
              : ok(`${node.unstakedFile ?? UNSTAKED}\n`),
          )
        case 'setIdentity': {
          const stdin = options.stdin!
          const key = JSON.parse(new TextDecoder().decode(stdin)) as number[]
          const sent = encodeBase58(Uint8Array.from(key.slice(32)))
          zero(stdin)
          keySet = true
          switch (node.set ?? 'ok') {
            case 'ok':
              identity = sent
              return Promise.resolve(ok(`New validator identity: ${sent}\n`))
            case 'failed':
              return Promise.resolve(failed('set-identity failed'))
            case 'failed-applied':
              identity = sent
              return Promise.resolve(
                failed('set-identity failed after the change'),
              )
            case 'timeout-applied':
              identity = sent
              return Promise.resolve({
                outcome: 'timeout',
                code: null,
                stdout: '',
                stderrLine: '',
              })
            case 'throws':
              return Promise.reject(new Error('cannot start ssh'))
          }
          return Promise.reject(new Error('unreachable'))
        }
        case 'setUnstaked': {
          if (revertsFailed < (node.revertFailures ?? 0)) {
            revertsFailed++
            return Promise.resolve(failed('set-identity failed'))
          }
          identity = node.unstakedFile ?? UNSTAKED
          return Promise.resolve(ok())
        }
        default:
          return Promise.reject(new Error(`unexpected ${name}`))
      }
    },
    close: () => {
      closed = true
      return Promise.resolve()
    },
  }
  return {
    session,
    runs,
    identity: () => identity,
    closed: () => closed,
    names: () => runs.map((run) => run.name),
  }
}

type Scenario = {
  node?: Node
  /** Answers typed at the terminal. */
  answers?: string[]
  nodes?: unknown[]
  votes?: { current: unknown[]; delinquent: unknown[] }
  inventoryText?: string
  openSession?: TryDeps['openSession']
  setupOverrides?: Parameters<typeof setupDeps>[1]
  pubkeyField?: string
  sleeps?: number[]
}

const run = async (
  options: { network?: string; host?: string; ref?: string },
  scenario: Scenario = {},
) => {
  const events: string[] = []
  const node = fakeNode(scenario.node ?? {}, events)
  const op = scriptedOp((call) => {
    const field = call.args[2]?.split('/').pop()
    events.push(`op:${field}`)
    return {
      success: true,
      stdout: field === 'pubkey'
        ? scenario.pubkeyField ?? TRIED
        : KEY_B.canonical,
    }
  })
  const captured = captureIo()
  const terminal = scriptedTty(scenario.answers ?? ['node-1'])
  const opened: string[] = []
  const deps: Partial<TryDeps> = {
    setup: setupDeps(op.op, scenario.setupOverrides),
    reader: {
      readText: () => Promise.resolve(scenario.inventoryText ?? inventory()),
      homeDir: '/home/op',
    },
    unused: {
      fetch: (_url, init) => {
        const method = JSON.parse(String(init.body)).method as string
        events.push(`rpc:${method}`)
        const result = method === 'getClusterNodes'
          ? scenario.nodes ?? []
          : scenario.votes ?? { current: [], delinquent: [] }
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
        )
      },
    },
    openSession: scenario.openSession ?? ((target) => {
      opened.push(target.name)
      return Promise.resolve(node.session)
    }),
    tty: {
      say: (text) => terminal.tty.say(text),
      ask: (prompt) => {
        events.push('tty:ask')
        return terminal.tty.ask(prompt)
      },
    },
    io: captured.io,
    sleep: (ms) => {
      scenario.sleeps?.push(ms)
      return Promise.resolve()
    },
  }
  const result = await tryKey(options, deps)
  return { result, node, op, captured, terminal, events, opened }
}

const TRY = { network: 'testnet', host: 'node-1', ref: refOf() }

const output = (
  captured: ReturnType<typeof captureIo>,
  terminal?: { said: string[]; asked: string[] },
): string =>
  [
    ...captured.info,
    ...captured.error,
    ...(terminal?.said ?? []),
    ...(terminal?.asked ?? []),
  ].join('\n')

Deno.test('the node is looked at, the public key is read from the item and checked as new, a person types the name of the host, and only then is the key read, sent on stdin, seen in contact-info, and the node set back and seen to be back; the summary has public keys only', async () => {
  const { result, node, op, captured, terminal, events } = await run(TRY)
  assertEquals(result, true)
  assertEquals(captured.exitCode(), undefined)

  assertEquals(node.names(), [
    'alive',
    'guardContactInfo',
    'unstakedPubkey',
    'guardContactInfo',
    'setIdentity',
    'guardContactInfo',
    'setUnstaked',
    'guardContactInfo',
  ])
  // The key was sent on stdin, as the one canonical text, with no flag; the node took it.
  const set = node.runs.find((r) => r.name === 'setIdentity')!
  assertEquals(set.stdinLength, KEY_B.canonical.length)
  assertEquals(set.flag, 'none')
  assertEquals(node.identity(), UNSTAKED)
  assertEquals(node.closed(), true)

  // The order of the steps: nothing about the key is read before the name is typed.
  const at = (event: string) => events.indexOf(event)
  assert(at('ssh:unstakedPubkey') < at('op:pubkey'))
  assert(at('op:pubkey') < at('rpc:getClusterNodes'))
  assert(at('rpc:getVoteAccounts') < at('tty:ask'))
  assert(at('tty:ask') < at('op:keypair'))
  assert(at('op:keypair') < at('ssh:setIdentity'))
  assertEquals(op.calls.map((call) => call.args), [
    ['read', '-n', refOf(VAULT, ITEM, 'pubkey')],
    ['read', '-n', refOf()],
  ])
  assertEquals(op.calls.map((call) => call.env.OP_CACHE), ['false', 'false'])

  const lines = output(captured, terminal)
  assertEquals(holdsKey(lines, KEY_B), false)
  assertStringIncludes(
    captured.info.find((line) => line.startsWith('✅'))!,
    `ran ${TRIED}`,
  )
  assertStringIncludes(lines, `set       ok`)
  assertStringIncludes(lines, `seen      ${TRIED}`)
  assertStringIncludes(lines, `back on   ${UNSTAKED}`)
  assertStringIncludes(terminal.said[0], '203.0.113.7:2222')
  assertStringIncludes(terminal.asked[0], 'Type the name of the host (node-1)')
})

Deno.test('a node that does not run its unstaked identity, whose unstaked file is a staked key or cannot be read, or that cannot be reached, is refused before op or the cluster is asked, and nothing is sent', async () => {
  const cases: [string, Node, string][] = [
    [
      'it runs the staked identity',
      { running: STAKED },
      `runs ${STAKED}, not its unstaked identity`,
    ],
    ['it runs another key', { running: TRIED }, 'not its unstaked identity'],
    [
      'the unstaked file holds an account of the inventory',
      { running: STAKED, unstakedFile: STAKED },
      'names as an identity or vote account',
    ],
    [
      'the unstaked file cannot be read',
      { unstakedFile: null },
      'cannot read the public key',
    ],
    ['it cannot be reached', { aliveFails: true }, 'Connection timed out'],
  ]
  for (const [name, node, expected] of cases) {
    const { result, node: fake, op, captured, events } = await run(TRY, {
      node,
    })
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(events.some((e) => e.startsWith('rpc:')), false, name)
    assertEquals(fake.names().includes('setIdentity'), false, name)
    assertEquals(fake.names().includes('setUnstaked'), false, name)
    assertEquals(fake.closed(), true, name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
  }
})

Deno.test('a key whose public key is in the gossip table, a vote account or the inventory, or that cannot be shown to be new, is refused before the name is asked for and before the key is read', async () => {
  const cases: [string, Scenario, string][] = [
    [
      'gossip',
      { nodes: [{ pubkey: TRIED }] },
      'in the gossip table of testnet',
    ],
    [
      'a vote account',
      { votes: { current: [], delinquent: [{ nodePubkey: TRIED }] } },
      'a vote account of testnet names',
    ],
    [
      'the inventory',
      {
        inventoryText: inventory().replace(STAKED, TRIED),
      },
      'of the inventory',
    ],
  ]
  for (const [name, scenario, expected] of cases) {
    const { result, node, op, captured, terminal } = await run(TRY, scenario)
    assertEquals(result, false, name)
    // Only the pubkey field was read; the person was not asked; nothing was sent.
    assertEquals(
      op.calls.map((c) => c.args[2].split('/').pop()),
      ['pubkey'],
      name,
    )
    assertEquals(terminal.asked, [], name)
    assertEquals(node.names().includes('setIdentity'), false, name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
    assertStringIncludes(captured.error[0], 'Nothing was changed')
  }
  // The pubkey field of the item is no public key.
  const { result, captured } = await run(TRY, { pubkeyField: 'not a key' })
  assertEquals(result, false)
  assertStringIncludes(captured.error[0], 'is not a public key')
})

Deno.test('anything but the name of the host at the prompt stops with nothing sent and the key not read', async () => {
  for (const answer of ['', 'node-2', 'NODE-1', 'node-1x', 'y', 'yes']) {
    const { result, node, op, captured } = await run(TRY, { answers: [answer] })
    assertEquals(result, false, answer)
    assertEquals(
      op.calls.map((c) => c.args[2].split('/').pop()),
      ['pubkey'],
      answer,
    )
    assertEquals(node.names().includes('setIdentity'), false, answer)
    assertEquals(captured.exitCode(), 1, answer)
    assertStringIncludes(captured.error[0], 'Nothing was changed')
  }
  // A person who types it with spaces around it is still the person who typed it.
  assertEquals((await run(TRY, { answers: ['  node-1  '] })).result, true)
})

Deno.test('a node that moved off its unstaked identity while the person was typing is not given the key', async () => {
  const { result, node, captured, op } = await run(TRY, {
    node: { movesAway: STAKED },
  })
  assertEquals(result, false)
  assertEquals(node.names().includes('setIdentity'), false)
  assertEquals(node.names().includes('setUnstaked'), false)
  assertStringIncludes(captured.error[0], `runs ${STAKED} now`)
  assertStringIncludes(captured.error[0], 'Nothing was changed')
  // The key was read, and is not kept: the verb has no copy to look at, but it never reached ssh.
  assertEquals(op.calls.length, 2)
})

Deno.test('whatever set-identity comes to, and whatever is seen afterwards, the node is told to go back to its unstaked identity and the identity it runs is read again', async () => {
  const cases: [string, Node, string][] = [
    [
      'set-identity fails and changes nothing',
      { set: 'failed' },
      'set-identity failed',
    ],
    ['set-identity fails after it changed the identity', {
      set: 'failed-applied',
    }, 'set-identity failed after the change'],
    ['set-identity times out after it changed the identity', {
      set: 'timeout-applied',
    }, 'set-identity timeout'],
    [
      'ssh cannot even be started for it',
      { set: 'throws' },
      'cannot start ssh',
    ],
    ['contact-info fails after the key was set', {
      contactInfoFailsAfterSet: true,
    }, 'cannot read the identity after set-identity'],
  ]
  for (const [name, node, expected] of cases) {
    const { result, node: fake, captured, terminal } = await run(TRY, { node })
    // After the key was sent: set back, then read.
    const names = fake.names()
    const sent = names.indexOf('setIdentity')
    assertNotEquals(sent, -1, name)
    const back = names.indexOf('setUnstaked')
    assert(back > sent, `${name}: not set back after ${names}`)
    assertEquals(names[names.length - 1], 'guardContactInfo', name)
    assertEquals(fake.identity(), UNSTAKED, name)
    // It failed, and said why, but the node is back.
    assertEquals(result, false, name)
    assertEquals(captured.exitCode(), 1, name)
    const lines = output(captured, terminal)
    assertStringIncludes(lines, expected)
    assertStringIncludes(lines, `back on   ${UNSTAKED}`)
    assertEquals(holdsKey(lines, KEY_B), false, name)
  }
})

Deno.test('the node is told to go back up to three times; one that never goes back is reported as not confirmed with the command that sets it back', async () => {
  const sleeps: number[] = []
  const late = await run(TRY, { node: { revertFailures: 2 }, sleeps })
  assertEquals(late.result, true)
  assertEquals(late.node.names().filter((n) => n === 'setUnstaked').length, 3)
  assertEquals(sleeps.length, 2)
  assertEquals(late.node.identity(), UNSTAKED)

  const never = await run(TRY, {
    node: { revertFailures: Infinity },
    sleeps: [],
  })
  assertEquals(never.result, false)
  assertEquals(never.node.names().filter((n) => n === 'setUnstaked').length, 3)
  assertEquals(never.captured.exitCode(), 1)
  const lines = output(never.captured)
  assertStringIncludes(lines, 'back on   NOT CONFIRMED')
  assertStringIncludes(lines, 'slv v set:unstaked -n testnet -p node-1')
  assertEquals(never.node.identity(), TRIED)
  assertEquals(never.node.closed(), true)
})

Deno.test('an error of op or of ssh that nobody planned for, before the key is sent, is one line, the session is closed, and the node is not touched', async () => {
  const throwing = (name: string): TryDeps['openSession'] => () =>
    Promise.resolve({
      target: {} as SshTarget,
      run: (run) =>
        run === name
          ? Promise.reject(new Error(`${name} could not be started`))
          : Promise.resolve({
            outcome: 'ok',
            code: 0,
            stdout: '',
            stderrLine: '',
          }),
      close: () => {
        closed.push(name)
        return Promise.resolve()
      },
    })
  const closed: string[] = []
  const alive = await run(TRY, { openSession: throwing('alive') })
  assertEquals(alive.result, false)
  assertStringIncludes(
    alive.captured.error[0],
    'keys:try stopped: alive could not be started',
  )
  assertEquals(closed, ['alive'])
  assertEquals(alive.op.calls.length, 0)

  // op itself fails on the pubkey field, as when 1Password is locked.
  const events: string[] = []
  const node = fakeNode({}, events)
  const captured = captureIo()
  const op = scriptedOp(() => ({ success: false, stderr: 'account is locked' }))
  const locked = await tryKey(TRY, {
    setup: setupDeps(op.op),
    reader: {
      readText: () => Promise.resolve(inventory()),
      homeDir: '/home/op',
    },
    unused: { fetch: () => Promise.reject(new Error('not asked')) },
    openSession: () => Promise.resolve(node.session),
    tty: scriptedTty([]).tty,
    io: captured.io,
    sleep: () => Promise.resolve(),
  })
  assertEquals(locked, false)
  assertStringIncludes(captured.error[0], 'account is locked')
  assertEquals(node.names().includes('setIdentity'), false)
  assertEquals(node.closed(), true)
})

Deno.test('only testnet, an inventory host, a 1Password reference of the configured vault, and a host that is not Firedancer and is pinned are tried; every other case is refused before op is run', async () => {
  const cases: [string, Parameters<typeof run>[0], Scenario, string][] = [
    ['mainnet', { ...TRY, network: 'mainnet' }, {}, 'never on mainnet'],
    [
      'devnet',
      { ...TRY, network: 'devnet' },
      {},
      'devnet has no validator inventory',
    ],
    ['no network', { host: 'node-1', ref: refOf() }, {}, 'no network'],
    ['no host', { network: 'testnet', ref: refOf() }, {}, '-p <inventory name'],
    ['no reference', { network: 'testnet', host: 'node-1' }, {}, '--ref'],
    [
      'a file reference',
      { ...TRY, ref: 'file:///home/op/.slv/keys/k.json' },
      {},
      'takes a 1Password reference',
    ],
    [
      'a vault that is not the configured one',
      { ...TRY, ref: refOf(OTHER_VAULT) },
      {},
      'not the vault configured',
    ],
    [
      'a host that is not in the inventory',
      { ...TRY, host: 'node-9' },
      {},
      'not a host of testnet_validators',
    ],
    [
      'a Firedancer host',
      TRY,
      { inventoryText: inventory('firedancer-jito') },
      'does not handle Firedancer',
    ],
    [
      'a host with no validator type',
      TRY,
      { inventoryText: inventory('""') },
      'agave, jito, allnodes-jito hosts only',
    ],
    [
      'a host that is not pinned',
      TRY,
      {
        openSession: () =>
          Promise.reject(new SshRefusal('node-1 is not pinned')),
      },
      'is not pinned',
    ],
    [
      'a shell reached over ssh with no service account',
      TRY,
      {
        setupOverrides: {
          context: {
            env: (name: string) =>
              name === 'SSH_CONNECTION' ? '1.2.3.4 22 5.6.7.8 22' : undefined,
            envNames: () => [],
            exists: () => Promise.resolve(false),
            canOpenTty: () => Promise.resolve(true),
          },
        },
      },
      'reached over ssh',
    ],
  ]
  for (const [name, options, scenario, expected] of cases) {
    const { result, op, node, captured } = await run(options, scenario)
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(node.runs.length, 0, name)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(captured.error[0], expected)
  }
})
