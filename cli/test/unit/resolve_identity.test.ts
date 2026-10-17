import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { parseIdentityRef } from '/lib/secret/identityRef.ts'
import { KEYPAIR_BYTES, keypairText } from '/lib/secret/keypairBytes.ts'
import {
  buildOpEnv,
  findExecutable,
  firstLine,
  type OpSpawn,
  type OpSpawnOptions,
} from '/lib/secret/opCli.ts'
import {
  readPubkeyField,
  type ResolveDeps,
  ResolveError,
  resolveIdentity,
} from '/lib/secret/resolveIdentity.ts'

const VAULT = 'abcdefghijklmnopqrstuvwxyz'
const ITEM = 'a1b2c3d4e5f6g7h8i9j0k1l2m3'
const REF = `op://${VAULT}/${ITEM}/keypair`
const TOKEN = 'ops_token_from_the_file_1234567890'
const OP_PATH = '/usr/bin/op'

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

// RFC 8032, section 7.1, test 1.
const SEED = hex(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
)
const PUBLIC = hex(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
)
const PUBKEY = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'

const keypair = (seed = SEED, publicBytes = PUBLIC): Uint8Array => {
  const bytes = new Uint8Array(KEYPAIR_BYTES)
  bytes.set(seed, 0)
  bytes.set(publicBytes, 32)
  return bytes
}

const ref = parseIdentityRef(REF, { homeDir: '/home/op' }).ref

type Call = { command: string; args: string[]; options: OpSpawnOptions }

const fakeOp = (
  answer: (
    call: Call,
  ) => { success: boolean; stdout?: Uint8Array; stderr?: string },
): { op: OpSpawn; calls: Call[]; stdouts: Uint8Array[] } => {
  const calls: Call[] = []
  const stdouts: Uint8Array[] = []
  return {
    calls,
    stdouts,
    op: (command, args, options) => {
      const call = { command, args, options }
      calls.push(call)
      const reply = answer(call)
      const stdout = reply.stdout ?? new Uint8Array()
      stdouts.push(stdout)
      return Promise.resolve({
        success: reply.success,
        stdout,
        stderr: new TextEncoder().encode(reply.stderr ?? ''),
      })
    },
  }
}

const PARENT: Record<string, string> = {
  HOME: '/home/op',
  PATH: '/usr/bin:/bin',
  USER: 'op',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
  OP_ACCOUNT: 'my.1password.com',
  // What the child must never get from the parent.
  OP_SESSION_myaccount: 'session-canary',
  OP_SERVICE_ACCOUNT_TOKEN: 'ops_token_of_the_parent',
  OP_CONNECT_TOKEN: 'connect-canary',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  ANSIBLE_CONFIG: '/tmp/ansible.cfg',
  SLV_CANARY: 'canary',
}

const deps = (
  op: OpSpawn,
  overrides: Partial<ResolveDeps> = {},
): ResolveDeps => ({
  op,
  opPath: OP_PATH,
  parentEnv: (name) => PARENT[name],
  token: TOKEN,
  readFile: () => Promise.reject(new Error('no file is read')),
  ...overrides,
})

Deno.test('op is run as `op read -n <ref>` by its absolute path, with no stdin, and an environment of its own in which the token of the file is the only token', async () => {
  const fake = fakeOp(() => ({ success: true, stdout: keypairText(keypair()) }))
  const resolved = await resolveIdentity(ref, {}, deps(fake.op))
  assertEquals(resolved.pubkey, PUBKEY)
  assertEquals(fake.calls.length, 1)
  const [call] = fake.calls
  assertEquals(call.command, OP_PATH)
  assertEquals(call.args, ['read', '-n', REF])
  assertEquals(call.options.stdin, null)
  assertEquals(call.options.env, {
    HOME: '/home/op',
    PATH: '/usr/bin:/bin',
    USER: 'op',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    OP_ACCOUNT: 'my.1password.com',
    OP_SERVICE_ACCOUNT_TOKEN: TOKEN,
  })
  for (
    const name of [
      'OP_SESSION_myaccount',
      'OP_CONNECT_TOKEN',
      'SSH_AUTH_SOCK',
      'ANSIBLE_CONFIG',
      'SLV_CANARY',
    ]
  ) {
    assertEquals(name in call.options.env, false, name)
  }

  // Without a token of the file, the token of the parent is not passed either.
  const none = fakeOp(() => ({ success: true, stdout: keypairText(keypair()) }))
  await resolveIdentity(ref, {}, deps(none.op, { token: null }))
  assertEquals('OP_SERVICE_ACCOUNT_TOKEN' in none.calls[0].options.env, false)
  assertEquals(
    buildOpEnv(() => undefined, null),
    {},
  )
})

Deno.test('what op printed is turned into the canonical text, the proved public key is returned, and every buffer that held the key is wiped', async () => {
  const printed = new TextEncoder().encode(
    `[ ${[...keypair()].join(', ')} ]\n`,
  )
  const fake = fakeOp(() => ({ success: true, stdout: printed }))
  const resolved = await resolveIdentity(
    ref,
    { expectedPubkey: PUBKEY },
    deps(fake.op),
  )
  assertEquals(resolved.pubkey, PUBKEY)
  assertEquals(
    new TextDecoder().decode(resolved.canonical),
    `[${[...keypair()].join(',')}]`,
  )
  // The buffer that op's output came in is zero.
  assertEquals([...printed].every((byte) => byte === 0), true)
  resolved.wipe()
  assertEquals([...resolved.canonical].every((byte) => byte === 0), true)
})

Deno.test('a key that op cannot read, that is no keypair, whose seed does not give its public key or is not the expected one, is refused without a word of the key, and the buffer is still wiped', async () => {
  const bad = keypairText(keypair(SEED, new Uint8Array(32).fill(7)))
  const cases: [
    string,
    () => { success: boolean; stdout?: Uint8Array; stderr?: string },
    string,
    string | undefined,
  ][] = [
    [
      'op fails',
      () => ({ success: false, stderr: `[ERROR] bad token ${TOKEN}\nmore` }),
      'op could not read',
      undefined,
    ],
    [
      'the field holds base58 text',
      () => ({ success: true, stdout: new TextEncoder().encode(PUBKEY) }),
      'not a Solana keypair',
      undefined,
    ],
    [
      'the seed does not give the public key',
      () => ({ success: true, stdout: bad }),
      'does not give the public key',
      undefined,
    ],
    [
      'the public key is not the expected one',
      () => ({ success: true, stdout: keypairText(keypair()) }),
      'not 11111111111111111111111111111111',
      '11111111111111111111111111111111',
    ],
  ]
  for (const [name, answer, expected, expectedPubkey] of cases) {
    const fake = fakeOp(answer)
    const error = await assertRejects(
      () => resolveIdentity(ref, { expectedPubkey }, deps(fake.op)),
      ResolveError,
      undefined,
      name,
    )
    assertStringIncludes(error.message, expected, name)
    for (const secret of [TOKEN, '157']) {
      assertEquals(error.message.includes(secret), false, `${name}: ${secret}`)
    }
    assert(fake.stdouts[0].every((byte) => byte === 0), `${name}: not wiped`)
  }
})

Deno.test('a file reference is read from the file and op is not run; the pubkey field of an item is read as `op read -n` too and has to be a public key', async () => {
  const file =
    parseIdentityRef('file:///home/op/key.json', { homeDir: '/home/op' }).ref
  const fake = fakeOp(() => ({ success: true }))
  const resolved = await resolveIdentity(
    file,
    {},
    deps(fake.op, { readFile: () => Promise.resolve(keypairText(keypair())) }),
  )
  assertEquals(resolved.pubkey, PUBKEY)
  assertEquals(fake.calls.length, 0)

  const field = fakeOp(() => ({
    success: true,
    stdout: new TextEncoder().encode(`${PUBKEY}\n`),
  }))
  assertEquals(
    await readPubkeyField(`op://${VAULT}/${ITEM}/pubkey`, deps(field.op)),
    PUBKEY,
  )
  assertEquals(field.calls[0].args, [
    'read',
    '-n',
    `op://${VAULT}/${ITEM}/pubkey`,
  ])
  assertEquals(field.calls[0].options.stdin, null)

  for (const text of ['', 'not a key', '[1,2,3]', `${PUBKEY} x`]) {
    const wrong = fakeOp(() => ({
      success: true,
      stdout: new TextEncoder().encode(text),
    }))
    await assertRejects(
      () => readPubkeyField(`op://${VAULT}/${ITEM}/pubkey`, deps(wrong.op)),
      ResolveError,
      'is not a public key',
    )
  }
})

Deno.test('op is looked up in the absolute directories of PATH, and what op says on stderr is cut to a line with the token taken out', async () => {
  const seen: string[] = []
  const executable = (path: string) => {
    seen.push(path)
    return Promise.resolve(path === '/usr/local/bin/op')
  }
  assertEquals(
    await findExecutable(
      'op',
      'bin:/opt//:/usr/local/bin/:/usr/bin',
      executable,
    ),
    '/usr/local/bin/op',
  )
  // A relative directory is never looked in.
  assertEquals(seen, ['/opt/op', '/usr/local/bin/op'])
  assertEquals(await findExecutable('op', undefined, executable), null)
  assertEquals(await findExecutable('op', '', executable), null)

  const line = firstLine(
    new TextEncoder().encode(
      `\n  [ERROR] token ${TOKEN} rejected\nsecond line\n`,
    ),
    [TOKEN],
  )
  assertEquals(line, '[ERROR] token [removed] rejected')
  assertEquals(firstLine(new TextEncoder().encode('x'.repeat(500))).length, 203)
  assertEquals(firstLine(new TextEncoder().encode('a\u0007b')), 'a b')
  // The controls of C1 are taken out too, and so is a run of integers like part of a key.
  assertEquals(firstLine(new TextEncoder().encode('a\u009bb')), 'a b')
  assertEquals(
    firstLine(
      new TextEncoder().encode('bad value [157,97, 177,157,239] at 3, 4'),
    ),
    'bad value [[removed]] at 3, 4',
  )
  // The first line with a word in it, not a row of @.
  assertEquals(
    firstLine(
      new TextEncoder().encode('@@@@@@\n@  WARNING: HOST KEY CHANGED  @\n'),
    ),
    '@  WARNING: HOST KEY CHANGED  @',
  )
})
