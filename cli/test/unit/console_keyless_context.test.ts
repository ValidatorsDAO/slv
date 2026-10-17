import { assertEquals, assertStringIncludes } from '@std/assert'
import { buildCommandEnv } from '@/ai/console/toolSafety.ts'
import { checkSecretContext, type ContextDeps } from '/lib/secret/context.ts'
import { checkKey } from '/src/validator/keys/checkKey.ts'
import { genKey } from '/src/validator/keys/genKey.ts'
import { tryKey } from '/src/validator/keys/tryKey.ts'
import {
  captureIo,
  KEY_A,
  refOf,
  scriptedOp,
  scriptedTty,
  setupDeps,
} from '/test/unit/_keylessFixtures.ts'

// A command that the AI console runs gets SLV_EXECUTION_CONTEXT=ai-console, and
// the verbs that read or send a key refuse to run when they find it.

const contextOf = (env: Record<string, string>): ContextDeps => ({
  env: (name) => env[name],
  envNames: () => Object.keys(env),
  exists: () => Promise.resolve(false),
  canOpenTty: () => Promise.resolve(true),
})

Deno.test('the environment built for a command of the AI console says that the console runs it, for a command a person confirmed too, and whatever the parent says', () => {
  const parents: Record<string, string>[] = [
    { PATH: '/usr/bin' },
    { PATH: '/usr/bin', SLV_EXECUTION_CONTEXT: 'terminal' },
    { PATH: '/usr/bin', SLV_EXECUTION_CONTEXT: '' },
  ]
  for (const parent of parents) {
    for (
      const options of [undefined, {}, { humanConfirmed: false }, {
        humanConfirmed: true,
      }]
    ) {
      assertEquals(
        buildCommandEnv(parent, 'en', options).SLV_EXECUTION_CONTEXT,
        'ai-console',
        JSON.stringify([parent, options]),
      )
    }
  }
})

Deno.test('a keyless verb run with the environment of a console command is refused before op is run or a key is made, and the same verb in the environment of a terminal is not', async () => {
  const consoleEnv = buildCommandEnv(
    { PATH: '/usr/bin', HOME: '/home/op' },
    'en',
  )
  const terminalEnv = { PATH: '/usr/bin', HOME: '/home/op' }

  // The check itself, for every network.
  for (const network of ['testnet', 'devnet', 'mainnet'] as const) {
    const config = { networks: {}, identityAgent: null }
    assertEquals(
      await checkSecretContext(network, config, contextOf(consoleEnv)),
      'this does not run from the AI console',
      network,
    )
    assertEquals(
      await checkSecretContext(network, config, contextOf(terminalEnv)),
      null,
      `${network}: a terminal is not refused`,
    )
  }

  // The three verbs that resolve or make a key.
  const verbs: [
    string,
    (
      setup: ReturnType<typeof setupDeps>,
      io: ReturnType<typeof captureIo>['io'],
    ) => Promise<boolean>,
  ][] = [
    [
      'keys:check',
      (setup, io) =>
        checkKey(
          { network: 'testnet', ref: refOf(), pubkey: KEY_A.pubkey },
          { setup, io },
        ),
    ],
    [
      'keys:gen',
      (setup, io) =>
        genKey({ network: 'testnet', title: 'a key' }, {
          setup,
          io,
          tty: scriptedTty([]).tty,
        }),
    ],
    [
      'keys:try',
      (setup, io) =>
        tryKey({ network: 'testnet', host: 'node-1', ref: refOf() }, {
          setup,
          io,
          tty: scriptedTty([]).tty,
        }),
    ],
  ]
  for (const [name, run] of verbs) {
    const op = scriptedOp(() => ({ success: true }))
    const captured = captureIo()
    const result = await run(
      setupDeps(op.op, { context: contextOf(consoleEnv) }),
      captured.io,
    )
    assertEquals(result, false, name)
    assertEquals(op.calls.length, 0, `${name}: op was run`)
    assertEquals(captured.exitCode(), 1, name)
    assertStringIncludes(
      captured.error[0],
      'this does not run from the AI console',
    )
  }

  // Positive control: the same keys:check in a terminal reads the key.
  const op = scriptedOp(() => ({ success: true, stdout: KEY_A.canonical }))
  const captured = captureIo()
  assertEquals(
    await checkKey({
      network: 'testnet',
      ref: refOf(),
      pubkey: KEY_A.pubkey,
    }, {
      setup: setupDeps(op.op, { context: contextOf(terminalEnv) }),
      io: captured.io,
    }),
    true,
  )
  assertEquals(op.calls.length, 1)
})
