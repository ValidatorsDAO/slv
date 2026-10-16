import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from '@std/assert'
import { stringify } from '@std/yaml'
import { getInventoryPath } from '@cmn/constants/path.ts'
import type { InventoryType } from '@cmn/types/config.ts'
import {
  type FdctlGuardDeps,
  mainnetRpcFdctlWarning,
  mainnetValidatorTypeRefusal,
  refuseFdctlMainnetCommand,
  refuseFdctlMainnetValidatorDeploy,
  refuseMainnetValidatorType,
  warnFdctlMainnetRpcCommand,
  warnFdctlMainnetRpcDeploy,
} from '/lib/fdctlMainnetGuard.ts'
import { updateMainnetInventory } from '/lib/updateMainnetInventory.ts'

// slv overhaul: Alpenglow. Alpenglow starts on mainnet with epoch 1064, and
// Firedancer and Frankendancer are not supported during the migration.

const read = (relative: string) =>
  Deno.readTextFile(new URL(`../../${relative}`, import.meta.url))

const FDCTL_TYPES = [
  'firedancer-agave',
  'firedancer-jito',
  'frankendancer',
  'firedancer',
]
const ALLOWED_TYPES = ['agave', 'jito', 'allnodes-jito']

// What every refusal tells the operator: the reason and the way out.
const REFUSAL_FACTS = [
  'Alpenglow',
  'epoch 1064',
  'not supported',
  'agave',
  'jito',
  'allnodes-jito',
  'slv v switch',
]

type Recorded = {
  deps: FdctlGuardDeps
  read: string[]
  errors: string[]
  info: string[]
  exitCodes: number[]
}

/** Guard dependencies that read the given inventory texts and record what is said. */
const recorder = (
  inventories: Partial<Record<InventoryType, string>> = {},
): Recorded => {
  const rec: Recorded = {
    read: [],
    errors: [],
    info: [],
    exitCodes: [],
    deps: {
      readInventory: (group) => {
        rec.read.push(group)
        return Promise.resolve(inventories[group] ?? null)
      },
      error: (line) => rec.errors.push(line),
      info: (line) => rec.info.push(line),
      setExitCode: (code) => rec.exitCodes.push(code),
    },
  }
  return rec
}

const inventoryText = (
  group: InventoryType,
  hosts: Record<string, string | undefined>,
): string =>
  stringify({
    [group]: {
      hosts: Object.fromEntries(
        Object.entries(hosts).map(([name, validatorType], index) => [name, {
          ansible_host: `203.0.113.${index + 1}`,
          ...(validatorType === undefined
            ? {}
            : { validator_type: validatorType }),
        }]),
      ),
    },
  })

const MAINNET_HOSTS = {
  'val-a': 'jito',
  'val-b': 'firedancer-jito',
  'val-c': 'agave',
}

Deno.test('a mainnet voting validator cannot be Firedancer or Frankendancer: the refusal gives the reason and the way out', () => {
  for (const type of [...FDCTL_TYPES, 'Firedancer-Jito ']) {
    const refusal = mainnetValidatorTypeRefusal(type)
    assert(refusal !== null, type)
    assertStringIncludes(refusal, type)
    for (const fact of REFUSAL_FACTS) assertStringIncludes(refusal, fact, type)
  }
  for (const type of [...ALLOWED_TYPES, '']) {
    assertEquals(mainnetValidatorTypeRefusal(type), null, type)
  }
})

Deno.test('slv v init stops on a refused type: an error, exit code 1, and no word for an allowed type', () => {
  const refused = recorder()
  assertEquals(
    refuseMainnetValidatorType('firedancer-jito', refused.deps),
    true,
  )
  assertEquals(refused.exitCodes, [1])
  assertEquals(refused.errors.length, 1)
  assertStringIncludes(
    refused.errors[0],
    mainnetValidatorTypeRefusal('firedancer-jito') ?? '',
  )
  for (const type of ALLOWED_TYPES) {
    const allowed = recorder()
    assertEquals(refuseMainnetValidatorType(type, allowed.deps), false, type)
    assertEquals([allowed.errors, allowed.info, allowed.exitCodes], [
      [],
      [],
      [],
    ])
  }
})

const statOrNull = async (path: string) => {
  try {
    return await Deno.stat(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

Deno.test('the mainnet inventory writer rejects a Firedancer or Frankendancer validator_type before it touches the inventory file', async () => {
  const path = getInventoryPath('mainnet_validators')
  const before = await statOrNull(path)
  for (const type of FDCTL_TYPES) {
    const error = await assertRejects(
      () => updateMainnetInventory('val-a', { validator_type: type as never }),
      Error,
    )
    for (const fact of REFUSAL_FACTS) {
      assertStringIncludes(error.message, fact, type)
    }
  }
  const after = await statOrNull(path)
  assertEquals(after?.mtime?.getTime(), before?.mtime?.getTime())
  assertEquals(after === null, before === null)
})

Deno.test('slv v deploy on mainnet is refused when a host it reaches is Firedancer or Frankendancer, naming that host and the way out', async () => {
  const rec = recorder({
    mainnet_validators: inventoryText('mainnet_validators', MAINNET_HOSTS),
  })
  assertEquals(
    await refuseFdctlMainnetValidatorDeploy(undefined, rec.deps),
    true,
  )
  assertEquals(rec.read, ['mainnet_validators'])
  assertEquals(rec.exitCodes, [1])
  const message = rec.errors.join('\n')
  assertStringIncludes(message, 'val-b (firedancer-jito)')
  assertEquals(message.includes('val-a'), false)
  assertEquals(message.includes('val-c'), false)
  for (const fact of REFUSAL_FACTS) assertStringIncludes(message, fact)
  assertStringIncludes(message, 'Nothing was changed')
})

Deno.test('slv v deploy -p checks only the hosts it names', async () => {
  const inventories = {
    mainnet_validators: inventoryText('mainnet_validators', MAINNET_HOSTS),
  }
  for (const limit of ['val-a', 'val-a,val-c', ' val-c ']) {
    const rec = recorder(inventories)
    assertEquals(
      await refuseFdctlMainnetValidatorDeploy(limit, rec.deps),
      false,
      limit,
    )
    assertEquals([rec.errors, rec.exitCodes], [[], []], limit)
  }
  for (const limit of ['val-b', 'val-a,val-b']) {
    const rec = recorder(inventories)
    assertEquals(
      await refuseFdctlMainnetValidatorDeploy(limit, rec.deps),
      true,
      limit,
    )
    assertEquals(rec.exitCodes, [1], limit)
    assertStringIncludes(rec.errors.join('\n'), 'val-b (firedancer-jito)')
  }
})

Deno.test('slv v deploy with a --limit pattern checks every host of mainnet_validators and says so', async () => {
  const inventories = {
    mainnet_validators: inventoryText('mainnet_validators', MAINNET_HOSTS),
  }
  for (const limit of ['val-*', 'all:!val-b']) {
    const rec = recorder(inventories)
    assertEquals(
      await refuseFdctlMainnetValidatorDeploy(limit, rec.deps),
      true,
      limit,
    )
    assertStringIncludes(rec.errors.join('\n'), 'is a pattern', limit)
  }
})

Deno.test('slv v deploy on mainnet goes on for agave, jito and allnodes-jito hosts, an empty group and a missing inventory', async () => {
  const groups: Array<Record<string, string | undefined>> = [
    { 'val-a': 'agave', 'val-b': 'jito', 'val-c': 'allnodes-jito' },
    {},
    { 'val-d': undefined },
  ]
  for (const hosts of groups) {
    const rec = recorder({
      mainnet_validators: inventoryText('mainnet_validators', hosts),
    })
    assertEquals(
      await refuseFdctlMainnetValidatorDeploy(undefined, rec.deps),
      false,
    )
    assertEquals([rec.errors, rec.exitCodes], [[], []])
  }
  const missing = recorder()
  assertEquals(
    await refuseFdctlMainnetValidatorDeploy(undefined, missing.deps),
    false,
  )
  assertEquals(missing.read, ['mainnet_validators'])
})

Deno.test('slv v setup:firedancer and slv v update:firedancer on mainnet are refused like the deploy, and other networks go on', async () => {
  const inventories = {
    mainnet_validators: inventoryText('mainnet_validators', MAINNET_HOSTS),
  }
  for (const action of ['set up Firedancer', 'update Firedancer']) {
    const rec = recorder(inventories)
    assertEquals(
      await refuseFdctlMainnetCommand('mainnet', action, undefined, rec.deps),
      true,
      action,
    )
    assertEquals(rec.read, ['mainnet_validators'], action)
    assertEquals(rec.exitCodes, [1], action)
    const message = rec.errors.join('\n')
    assertStringIncludes(
      message,
      `Refusing to ${action} on mainnet: val-b (firedancer-jito)`,
    )
    for (const fact of REFUSAL_FACTS) {
      assertStringIncludes(message, fact, action)
    }
  }
  // -p names the hosts, as it does for the deploy.
  const scoped = recorder(inventories)
  assertEquals(
    await refuseFdctlMainnetCommand(
      'mainnet',
      'update Firedancer',
      'val-a',
      scoped.deps,
    ),
    false,
  )
  assertEquals([scoped.errors, scoped.exitCodes], [[], []])
  for (const network of ['testnet', 'devnet', 'Mainnet', undefined]) {
    const rec = recorder(inventories)
    assertEquals(
      await refuseFdctlMainnetCommand(
        network,
        'set up Firedancer',
        undefined,
        rec.deps,
      ),
      false,
      String(network),
    )
    assertEquals([rec.read, rec.errors, rec.exitCodes], [[], [], []])
  }
})

Deno.test('slv v setup:firedancer and slv v update:firedancer call the refusal before they run ansible', async () => {
  const index = await read('src/validator/index.ts')
  for (
    const [command, action] of [
      ['setup:firedancer', 'set up Firedancer'],
      ['update:firedancer', 'update Firedancer'],
    ]
  ) {
    const start = index.indexOf(`validatorCmd.command('${command}')`)
    assert(start > 0, command)
    const end = index.indexOf('validatorCmd.command(', start + 1)
    const block = index.slice(start, end)
    const refuse = block.indexOf('refuseFdctlMainnetCommand(')
    assert(refuse > 0, `${command} does not call the refusal`)
    assertStringIncludes(block, `'${action}'`)
    assert(refuse < block.indexOf('runAnsilbe('), `${command}: after ansible`)
  }
})

Deno.test('a mainnet RPC with a Frankendancer config is warned about as not supported for the migration', () => {
  for (const type of FDCTL_TYPES) {
    const warning = mainnetRpcFdctlWarning(type)
    assert(warning !== null, type)
    for (const fact of [type, 'Alpenglow', 'epoch 1064', 'not supported']) {
      assertStringIncludes(warning, fact, type)
    }
  }
  for (const type of ALLOWED_TYPES) {
    assertEquals(mainnetRpcFdctlWarning(type), null, type)
  }
})

Deno.test('slv rpc deploy on mainnet warns about the Frankendancer hosts it reaches and does not refuse', async () => {
  const rec = recorder({
    mainnet_rpcs: inventoryText('mainnet_rpcs', {
      'rpc-a': 'jito',
      'rpc-b': 'firedancer-agave',
    }),
  })
  const hosts = await warnFdctlMainnetRpcDeploy(undefined, rec.deps)
  assertEquals(hosts.map((host) => host.name), ['rpc-b'])
  assertEquals(rec.read, ['mainnet_rpcs'])
  assertEquals([rec.errors, rec.exitCodes], [[], []])
  assertEquals(rec.info.length, 1)
  assertStringIncludes(rec.info[0], 'rpc-b')
  assertStringIncludes(rec.info[0], 'not supported')
})

Deno.test('slv rpc setup:firedancer and slv rpc update:firedancer on mainnet warn like the RPC init and deploy, and never refuse', async () => {
  const inventories = {
    mainnet_rpcs: inventoryText('mainnet_rpcs', {
      'rpc-a': 'jito',
      'rpc-b': 'firedancer-agave',
    }),
  }
  const command = recorder(inventories)
  const hosts = await warnFdctlMainnetRpcCommand(
    'mainnet',
    undefined,
    command.deps,
  )
  assertEquals(hosts.map((host) => host.name), ['rpc-b'])
  assertEquals(command.read, ['mainnet_rpcs'])
  assertEquals([command.errors, command.exitCodes], [[], []])
  assertEquals(command.info.length, 1)
  assertStringIncludes(command.info[0], 'rpc-b')
  assertStringIncludes(command.info[0], 'not supported')
  // The text of the deploy, and -p names the hosts as it does there.
  const deploy = recorder(inventories)
  await warnFdctlMainnetRpcDeploy(undefined, deploy.deps)
  assertEquals(command.info, deploy.info)
  const scoped = recorder(inventories)
  assertEquals(
    await warnFdctlMainnetRpcCommand('mainnet', 'rpc-a', scoped.deps),
    [],
  )
  assertEquals([scoped.info, scoped.errors, scoped.exitCodes], [[], [], []])
  // Any other network is not looked at.
  for (const network of ['testnet', 'devnet', 'Mainnet', undefined]) {
    const rec = recorder(inventories)
    assertEquals(
      await warnFdctlMainnetRpcCommand(network, undefined, rec.deps),
      [],
      String(network),
    )
    assertEquals([rec.read, rec.info, rec.errors], [[], [], []])
  }
})

Deno.test('slv rpc setup:firedancer and slv rpc update:firedancer call the warning before they run ansible and only warn', async () => {
  const index = await read('src/rpc/index.ts')
  for (const command of ['setup:firedancer', 'update:firedancer']) {
    const start = index.indexOf(`rpcCmd.command('${command}')`)
    assert(start > 0, command)
    const ends = [
      index.indexOf('rpcCmd.command(', start + 1),
      index.indexOf('registerSolanaBinaryCommands(', start + 1),
    ].filter((end) => end > 0)
    const block = index.slice(start, Math.min(...ends))
    const warn = block.indexOf(
      '\n    await warnFdctlMainnetRpcCommand(options.network, options.pubkey)\n',
    )
    assert(warn > 0, `${command} does not call the warning as a statement`)
    assert(warn < block.indexOf('runAnsilbe('), `${command}: after ansible`)
    assertEquals(block.includes('refuseFdctl'), false, command)
  }
})

Deno.test('slv v init and slv v deploy call the refusal before they generate a key, list, ask or run ansible', async () => {
  const init = await read('src/validator/init/initMainnetConfig.ts')
  const refuseInit = init.indexOf('refuseMainnetValidatorType(validatorType)')
  assert(refuseInit > 0, 'initMainnetConfig.ts does not call the refusal')
  assert(
    refuseInit < init.indexOf('genIdentityKey()'),
    'the refusal comes after the identity key is generated',
  )
  const deploy = await read('src/validator/deploy/deployValidatorMainnet.ts')
  const refuseDeploy = deploy.indexOf(
    'refuseFdctlMainnetValidatorDeploy(limit)',
  )
  assert(
    refuseDeploy > 0,
    'deployValidatorMainnet.ts does not call the refusal',
  )
  for (const later of ['listValidators(', 'confirmDeploy(', 'runAnsilbe(']) {
    assert(
      refuseDeploy < deploy.indexOf(later),
      `the refusal comes after ${later}`,
    )
  }
})

Deno.test('the mainnet RPC init and deploy only warn about a Frankendancer config', async () => {
  const init = await read('src/rpc/init/mainnetInitRpc.ts')
  assertStringIncludes(init, 'mainnetRpcFdctlWarning(')
  assertEquals(init.includes('refuseMainnetValidatorType'), false)
  const deploy = await read('src/rpc/deploy/deployRPCMainnet.ts')
  assertStringIncludes(deploy, '\n  await warnFdctlMainnetRpcDeploy(limit)\n')
  assertEquals(deploy.includes('refuseFdctlMainnetValidatorDeploy'), false)
})

Deno.test('the testnet and devnet init and deploy modules do not use the mainnet guard', async () => {
  for (
    const path of [
      'src/validator/init/initTestnetConfig.ts',
      'src/validator/deploy/deployValidatorTestnet.ts',
      'src/rpc/init/testnetInitRpc.ts',
      'src/rpc/init/devnetInitRpc.ts',
      'src/rpc/deploy/deployRPCTestnet.ts',
      'src/rpc/deploy/deployRPCDevnet.ts',
    ]
  ) {
    assertEquals((await read(path)).includes('fdctlMainnetGuard'), false, path)
  }
})
