import { assertEquals, assertRejects } from '@std/assert'
import { prepareSecretSetup, SecretRefusal } from '/lib/secret/setup.ts'
import { parseKeylessConfig } from '/lib/secret/vaultPolicy.ts'
import {
  OP_PATH,
  PARENT_ENV,
  scriptedOp,
  setupDeps,
  TOKEN,
  VAULT,
} from '/test/unit/_keylessFixtures.ts'

const TOKEN_FILE = '/home/op/.slv/testnet.token'
const withTokenFile = parseKeylessConfig(
  `networks:\n  testnet:\n    vault_id: ${VAULT}\n    service_account_token_file: ${TOKEN_FILE}\n`,
)

/** The steps of a setup, in the order they were taken. */
const traced = (overrides: Parameters<typeof setupDeps>[1] = {}) => {
  const steps: string[] = []
  const op = scriptedOp(() => ({ success: true }))
  const deps = setupDeps(op.op, {
    readConfig: () => {
      steps.push('config')
      return Promise.resolve(withTokenFile)
    },
    context: {
      env: () => undefined,
      envNames: () => [],
      exists: () => Promise.resolve(false),
      canOpenTty: () => {
        steps.push('context')
        return Promise.resolve(true)
      },
    },
    policy: {
      lstat: () => {
        steps.push('token file')
        return Promise.resolve({
          isFile: true,
          isSymlink: false,
          mode: 0o100600,
          uid: 1000,
        })
      },
      readText: () => Promise.resolve(`${TOKEN}\n`),
      uid: () => 1000,
    },
    findOp: () => {
      steps.push('op')
      return Promise.resolve(OP_PATH)
    },
    ...overrides,
  })
  return { steps, deps, op }
}

Deno.test('a setup reads keyless.yml, checks where it runs, reads the token file and finds op, in that order, and hands the resolver the token and the absolute path of op', async () => {
  const { steps, deps, op } = traced()
  const setup = await prepareSecretSetup('testnet', deps)
  assertEquals(steps, ['config', 'context', 'token file', 'op'])
  assertEquals(setup.token, TOKEN)
  assertEquals(setup.policy, { vaultId: VAULT, tokenFile: TOKEN_FILE })
  assertEquals(setup.resolve.opPath, OP_PATH)
  assertEquals(setup.resolve.token, TOKEN)
  assertEquals(setup.resolve.op, op.op)
  assertEquals(setup.resolve.parentEnv('HOME'), PARENT_ENV.HOME)
  assertEquals(op.calls.length, 0)

  // Without a service account there is no token, and nothing is read for one.
  const human = traced({
    readConfig: () =>
      Promise.resolve(
        parseKeylessConfig(`networks:\n  testnet:\n    vault_id: ${VAULT}\n`),
      ),
  })
  const bare = await prepareSecretSetup('testnet', human.deps)
  assertEquals(bare.token, null)
  assertEquals(human.steps, ['context', 'op'])
})

Deno.test('a keyless.yml that is wrong, a place where keys are not resolved, a token file that is wrong, and a missing op each stop the setup with a refusal, before the steps after them', async () => {
  // keyless.yml with an unknown key.
  const broken = traced({
    readConfig: () =>
      Promise.resolve(parseKeylessConfig('networks: { prod: {} }')),
  })
  await assertRejects(
    () => prepareSecretSetup('testnet', broken.deps),
    SecretRefusal,
    'not a network',
  )
  assertEquals(broken.steps, [])

  // A keyless.yml that cannot be read at all.
  const unreadable = traced({
    readConfig: () => Promise.reject(new Error('disk')),
  })
  await assertRejects(
    () => prepareSecretSetup('testnet', unreadable.deps),
    Error,
    'disk',
  )

  // No terminal: stops before the token file is looked at.
  const noTty = traced({
    context: {
      env: () => undefined,
      envNames: () => [],
      exists: () => Promise.resolve(false),
      canOpenTty: () => Promise.resolve(false),
    },
  })
  await assertRejects(
    () => prepareSecretSetup('testnet', noTty.deps),
    SecretRefusal,
    'no terminal',
  )
  assertEquals(noTty.steps, ['config'])

  // A token file that others can read: stops before op is looked for.
  const loose = traced({
    policy: {
      lstat: () =>
        Promise.resolve({
          isFile: true,
          isSymlink: false,
          mode: 0o100644,
          uid: 1000,
        }),
      readText: () => Promise.resolve(`${TOKEN}\n`),
      uid: () => 1000,
    },
  })
  const mode = await assertRejects(
    () => prepareSecretSetup('testnet', loose.deps),
    SecretRefusal,
    '0600',
  )
  assertEquals(mode.message.includes(TOKEN), false)
  assertEquals(loose.steps.includes('op'), false)

  // op is nowhere in PATH.
  const missing = traced({ findOp: () => Promise.resolve(null) })
  await assertRejects(
    () => prepareSecretSetup('testnet', missing.deps),
    SecretRefusal,
    'op (the 1Password CLI) is not in an absolute directory of PATH',
  )
})
