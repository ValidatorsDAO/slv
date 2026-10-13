import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import {
  confirmDeploy,
  type ConfirmEnv,
  defaultConfirmEnv,
  parseDeployNetwork,
} from '/lib/targetGuard.ts'

const read = (relative: string) =>
  Deno.readTextFile(new URL(`../../${relative}`, import.meta.url))

const DEPLOY_MODULES = [
  'src/validator/deploy/deployValidatorMainnet.ts',
  'src/validator/deploy/deployValidatorTestnet.ts',
  'src/rpc/deploy/deployRPCMainnet.ts',
  'src/rpc/deploy/deployRPCTestnet.ts',
  'src/rpc/deploy/deployRPCDevnet.ts',
]

const RPC_DEPLOY_MODULES = DEPLOY_MODULES.filter((p) => p.includes('/rpc/'))

const HERMES_PYTHNET_MODULES = [
  'src/hermes/deploy/deployHermesMainnet.ts',
  'src/pythnet/deploy/deployPythnetMainnet.ts',
]

const assertAsksOnceThroughConfirmDeploy = async (path: string) => {
  const source = await read(path)
  assertStringIncludes(source, 'confirmDeploy(', path)
  assertEquals(
    /default:\s*true/.test(source),
    false,
    `${path} keeps a default-yes prompt`,
  )
  assertEquals(
    /type:\s*Confirm\b/.test(source) || source.includes('Confirm,'),
    false,
    `${path} still builds its own Confirm`,
  )
  assertStringIncludes(source, 'allHostsConfirmed: true', path)
}

Deno.test('validator deploy accepts exactly testnet and mainnet', () => {
  assertEquals(parseDeployNetwork('validator', 'testnet'), {
    ok: true,
    network: 'testnet',
  })
  assertEquals(parseDeployNetwork('validator', 'mainnet'), {
    ok: true,
    network: 'mainnet',
  })
  for (
    const value of [
      'devnet',
      'Mainnet',
      'MAINNET',
      ' mainnet',
      'mainnet ',
      'main',
      '',
      undefined,
    ]
  ) {
    const result = parseDeployNetwork('validator', value)
    assertEquals(result.ok, false, String(value))
  }
})

Deno.test('rpc deploy accepts exactly mainnet, testnet and devnet', () => {
  for (const network of ['mainnet', 'testnet', 'devnet'] as const) {
    assertEquals(parseDeployNetwork('rpc', network), { ok: true, network })
  }
  for (const value of ['localnet', 'Devnet', 'mainnet-beta', '', undefined]) {
    assertEquals(parseDeployNetwork('rpc', value).ok, false, String(value))
  }
})

Deno.test('a rejected deploy network names the value and the accepted ones', () => {
  const result = parseDeployNetwork('validator', 'devnet')
  assert(!result.ok)
  assertStringIncludes(result.error, 'devnet')
  assertStringIncludes(result.error, 'testnet')
  assertStringIncludes(result.error, 'mainnet')
})

type Asked = { message: string; default: boolean }

const confirmEnv = (
  options: { isTty: boolean; env?: Record<string, string>; answer?: boolean },
) => {
  const asked: Asked[] = []
  const info: string[] = []
  const errors: string[] = []
  const exitCodes: number[] = []
  const env: Partial<ConfirmEnv> = {
    isTty: () => options.isTty,
    getEnv: (name) => options.env?.[name],
    // Reaching the prompt without a terminal would wait for input that cannot
    // come, so it fails the test at once instead.
    prompt: (opts) => {
      asked.push({ message: opts.message, default: opts.default })
      return options.isTty
        ? Promise.resolve(options.answer ?? false)
        : Promise.reject(new Error('the prompt was reached without a terminal'))
    },
    info: (line) => info.push(line),
    error: (line) => errors.push(line),
    setExitCode: (code) => exitCodes.push(code),
  }
  return { env, asked, info, errors, exitCodes }
}

Deno.test('on a terminal the deploy confirmation defaults to no and returns the answer', async () => {
  const declined = confirmEnv({ isTty: true, answer: false })
  assertEquals(await confirmDeploy(declined.env), false)
  const accepted = confirmEnv({ isTty: true, answer: true })
  assertEquals(await confirmDeploy(accepted.env), true)
  for (const rec of [declined, accepted]) {
    assertEquals(rec.asked.length, 1)
    assertEquals(rec.asked[0].default, false)
    assertStringIncludes(rec.asked[0].message, 'continue')
    assertEquals(rec.exitCodes, [])
  }
})

Deno.test('the deploy confirmation answers no with a message, and does not wait, when stdin is not a terminal', async () => {
  const rec = confirmEnv({ isTty: false })
  assertEquals(await confirmDeploy(rec.env), false)
  assertEquals(rec.asked, [])
  assertEquals(rec.exitCodes, [1])
  const message = rec.errors.join('\n')
  assertStringIncludes(message, 'stdin is not a terminal')
  assertStringIncludes(message, 'SLV_ALLOW_ALL_HOSTS=1')
})

Deno.test({
  name:
    'the deploy confirmation treats an environment it is not permitted to read as not set',
  permissions: { env: false },
  fn: async () => {
    // Control: the permission really is denied inside this test.
    assertThrows(() => Deno.env.get('SLV_ALLOW_ALL_HOSTS'))
    const rec = confirmEnv({ isTty: false })
    const env = { ...rec.env, getEnv: defaultConfirmEnv().getEnv }
    assertEquals(await confirmDeploy(env), false)
    assertEquals(rec.asked, [])
    assertEquals(rec.exitCodes, [1])
  },
})

Deno.test('SLV_ALLOW_ALL_HOSTS=1 lets a deploy confirmation without a terminal go ahead; any other value does not', async () => {
  const allowed = confirmEnv({
    isTty: false,
    env: { SLV_ALLOW_ALL_HOSTS: '1' },
  })
  assertEquals(await confirmDeploy(allowed.env), true)
  assertEquals(allowed.asked, [])
  assertEquals(allowed.exitCodes, [])
  assertStringIncludes(allowed.info.join('\n'), 'SLV_ALLOW_ALL_HOSTS=1')

  for (const value of ['true', 'yes', '0', '', '1 ']) {
    const rec = confirmEnv({
      isTty: false,
      env: { SLV_ALLOW_ALL_HOSTS: value },
    })
    assertEquals(await confirmDeploy(rec.env), false, JSON.stringify(value))
    assertEquals(rec.exitCodes, [1])
  }
})

Deno.test('every deploy module asks through the shared confirmation and tells the runner it already did', async () => {
  for (const path of DEPLOY_MODULES) {
    await assertAsksOnceThroughConfirmDeploy(path)
  }
})

Deno.test('the Hermes and Pythnet deploy modules ask once, with the default set to no, and tell the runner', async () => {
  for (const path of HERMES_PYTHNET_MODULES) {
    await assertAsksOnceThroughConfirmDeploy(path)
  }
})

Deno.test('no RPC deploy module imports or calls runSha256Patch, and patch:sha256 stays an explicit command', async () => {
  for (const path of RPC_DEPLOY_MODULES) {
    const source = await read(path)
    assertEquals(source.includes('runSha256Patch'), false, path)
    assertEquals(source.includes('sha256Patch'), false, path)
  }
  const rpcIndex = await read('src/rpc/index.ts')
  assertStringIncludes(rpcIndex, "registerSha256PatchCommands(rpcCmd, 'rpc'")
  const validatorIndex = await read('src/validator/index.ts')
  assertStringIncludes(
    validatorIndex,
    "registerSha256PatchCommands(validatorCmd, 'validator'",
  )
})
