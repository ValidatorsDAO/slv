import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { confirmDeploy, parseDeployNetwork } from '/lib/targetGuard.ts'

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

Deno.test('the deploy confirmation defaults to no and returns the answer', async () => {
  const seen: { message: string; default: boolean }[] = []
  const answer =
    (value: boolean) => (opts: { message: string; default: false }) => {
      seen.push({ message: opts.message, default: opts.default })
      return Promise.resolve(value)
    }
  assertEquals(await confirmDeploy(answer(false)), false)
  assertEquals(await confirmDeploy(answer(true)), true)
  assertEquals(seen.length, 2)
  assertEquals(seen.every((s) => s.default === false), true)
  assertStringIncludes(seen[0].message, 'continue')
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
