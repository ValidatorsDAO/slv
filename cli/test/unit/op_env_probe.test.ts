import { assertEquals, assertStringIncludes } from '@std/assert'
import { runProbe } from '/scripts/op_env_probe.ts'
import {
  OP_PATH,
  OTHER_VAULT,
  PARENT_ENV,
  refOf,
  scriptedOp,
  setupDeps,
} from '/test/unit/_keylessFixtures.ts'

// A field with a character that takes two bytes in UTF-8, so that a length in
// characters and a length in bytes differ.
const CANARY = 'canary-É-field-value-93f1'
const CANARY_BYTES = new TextEncoder().encode(CANARY).length
const REFERENCE = refOf(OTHER_VAULT, 'a1b2c3d4e5f6g7h8i9j0k1l2m3', 'pubkey')

const probe = async (
  args: string[],
  answer: Parameters<typeof scriptedOp>[0],
  setup: Parameters<typeof setupDeps>[1] = {},
) => {
  const op = scriptedOp(answer)
  const out: string[] = []
  const err: string[] = []
  const code = await runProbe(args, {
    setup: setupDeps(op.op, {
      // The probe does not read keyless.yml.
      readConfig: () => Promise.reject(new Error('keyless.yml was read')),
      ...setup,
    }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, op, out, err }
}

Deno.test('the probe prints the number of bytes of the field and nothing of its content; op is run once, by its path, with the arguments and the environment the verbs give it', async () => {
  const { code, op, out, err } = await probe(
    [REFERENCE],
    () => ({ success: true, stdout: CANARY }),
  )
  assertEquals(code, 0, err.join('\n'))
  assertEquals(CANARY_BYTES !== CANARY.length, true)
  assertEquals(out, [String(CANARY_BYTES)])
  assertEquals(err, [])
  assertEquals(
    [...out, ...err].join('\n').includes(CANARY.slice(0, 6)),
    false,
  )

  assertEquals(op.calls.length, 1)
  const [call] = op.calls
  assertEquals(call.command, OP_PATH)
  assertEquals(call.args, ['read', '-n', REFERENCE])
  assertEquals(call.stdinLength, null)
  // What the parent had besides these (a session, a token, an agent socket, a cache setting) did not reach op.
  assertEquals(call.env, {
    HOME: PARENT_ENV.HOME,
    PATH: PARENT_ENV.PATH,
    USER: PARENT_ENV.USER,
    LANG: PARENT_ENV.LANG,
    TMPDIR: PARENT_ENV.TMPDIR,
    OP_CACHE: 'false',
    OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
  })
})

Deno.test('a field that op does not give is a failure with the first line of what op said, and nothing is printed on stdout', async () => {
  const { code, out, err } = await probe(
    [REFERENCE],
    () => ({
      success: false,
      stdout: CANARY,
      stderr:
        `\n[ERROR] 2026/10/17 could not connect to the 1Password app\nsecond line ${CANARY}`,
    }),
  )
  assertEquals(code, 1)
  assertEquals(out, [])
  assertEquals(err.length, 1)
  assertStringIncludes(err[0], `op could not read ${REFERENCE}`)
  assertStringIncludes(err[0], 'could not connect to the 1Password app')
  assertEquals(err[0].includes(CANARY), false)
})

Deno.test('a wrong command line is refused with a usage line before op is looked for or run, and so is every field of an item but its pubkey field, whatever the case', async () => {
  const cases: [string, string[]][] = [
    ['no argument', []],
    ['two arguments', [REFERENCE, REFERENCE]],
    ['names in place of ids', ['op://Validators/item/pubkey']],
    ['a section', [`${REFERENCE.slice(0, -'/pubkey'.length)}/section/pubkey`]],
    ['a query', [`${REFERENCE}?attribute=otp`]],
    ['a file', ['file:///home/op/key.json']],
    ['the key field', [refOf(OTHER_VAULT, 'a1b2c3d4e5f6g7h8i9j0k1l2m3')]],
    // 1Password reads the name of a field without regard to case.
    ...['KEYPAIR', 'Keypair', 'keyPair'].map((field): [string, string[]] => [
      `the key field as ${field}`,
      [refOf(OTHER_VAULT, 'a1b2c3d4e5f6g7h8i9j0k1l2m3', field)],
    ]),
    // And any other field is not the one the probe reads.
    ...['password', 'notesPlain', 'public key', 'pubkeys'].map((
      field,
    ): [string, string[]] => [
      `the field ${field}`,
      [refOf(OTHER_VAULT, 'a1b2c3d4e5f6g7h8i9j0k1l2m3', field)],
    ]),
  ]
  for (const [name, args] of cases) {
    const { code, op, out, err } = await probe(
      args,
      () => ({ success: true }),
      {
        findOp: () => Promise.reject(new Error('op was looked for')),
      },
    )
    assertEquals(code, 2, name)
    assertEquals(op.calls.length, 0, name)
    assertEquals(out, [], name)
    assertStringIncludes(err.join('\n'), 'usage: op_env_probe.ts', name)
  }
})

Deno.test('the probe stops where the verbs stop: from the AI console, and when op is not in the path, without running op', async () => {
  const consoleContext = await probe([REFERENCE], () => ({ success: true }), {
    context: {
      env: (name) =>
        name === 'SLV_EXECUTION_CONTEXT' ? 'ai-console' : undefined,
      envNames: () => ['SLV_EXECUTION_CONTEXT'],
      exists: () => Promise.resolve(false),
      canOpenTty: () => Promise.resolve(true),
    },
  })
  assertEquals(consoleContext.code, 1)
  assertEquals(consoleContext.op.calls.length, 0)
  assertEquals(consoleContext.out, [])
  assertStringIncludes(
    consoleContext.err[0],
    'this does not run from the AI console',
  )

  const noOp = await probe([REFERENCE], () => ({ success: true }), {
    findOp: () => Promise.resolve(null),
  })
  assertEquals(noOp.code, 1)
  assertEquals(noOp.op.calls.length, 0)
  assertEquals(noOp.out, [])
  assertStringIncludes(noOp.err[0], 'op (the 1Password CLI) is not in')
})

Deno.test('the pubkey field is read whatever the case of its name', async () => {
  for (const field of ['pubkey', 'PUBKEY', 'Pubkey']) {
    const reference = refOf(OTHER_VAULT, 'a1b2c3d4e5f6g7h8i9j0k1l2m3', field)
    const { code, op, out } = await probe(
      [reference],
      () => ({ success: true, stdout: CANARY }),
    )
    assertEquals(code, 0, field)
    assertEquals(op.calls.map((call) => call.args), [['read', '-n', reference]])
    assertEquals(out, [String(CANARY_BYTES)])
  }
})
