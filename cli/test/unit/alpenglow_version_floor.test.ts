import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import type { CmnType } from '@cmn/types/config.ts'
import { defaultVersionsObject } from '/lib/config/defaultVersionsYml.ts'
import {
  ALPENGLOW_FLOORS,
  compareClientVersions,
  findBelowFloorPins,
  type FloorDeps,
  isBelowFloor,
  noticeBelowFloorPins,
  refuseBelowFloorPins,
} from '/lib/versionFloor.ts'

// slv overhaul: Alpenglow. Alpenglow starts on mainnet with epoch 1064, and
// testnet and devnet already run it. A pin in ~/.slv/versions.yml below the floor
// of its network cannot follow it.

const read = (relative: string) =>
  Deno.readTextFile(new URL(`../../${relative}`, import.meta.url))

// The defaults before the Alpenglow update: what an operator who installed an
// earlier slv has pinned in versions.yml.
const OLD_DEFAULTS = {
  mainnet_validators: {
    version_agave: '4.3.0',
    version_jito: '4.3.0-jito.0',
    version_allnodes_jito: '4.3.0-allnodes.1',
    version_firedancer: '0.814.30108',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  testnet_validators: {
    version_agave: '4.0.0-beta.2',
    version_jito: '4.0.0-beta.2-jito',
    version_allnodes_jito: '3.1.14',
    version_firedancer: '0.814.30108',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  mainnet_rpcs: {
    version_agave: '3.1.10',
    version_jito: '3.1.10-jito',
    version_firedancer: '0.814.30108',
    richat_version: 'richat-v8.2.2',
    geyser_version: 'v10.1.2-rc3+solana.3.1.10',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  testnet_rpcs: {
    version_agave: '4.0.0-beta.2',
    version_jito: '4.0.0-beta.2-jito',
    version_firedancer: '0.814.30108',
    richat_version: 'richat-v8.2.2',
    geyser_version: 'v10.1.1+solana.3.1.1-rc',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
  devnet_rpcs: {
    version_agave: '3.1.10',
    version_jito: '3.1.10-jito',
    version_firedancer: '0.814.30108',
    richat_version: 'richat-v8.2.2',
    geyser_version: 'v10.0.1+solana.3.0.6',
    allowed_ssh_ips: [],
    allowed_ips: [],
  },
}

// What the old defaults hold below the floor of their network, and the default
// to set instead.
const OLD_PINS_BELOW_FLOOR = [
  ['testnet_validators', 'version_agave', '4.0.0-beta.2', '4.4.0-beta.1'],
  [
    'testnet_validators',
    'version_jito',
    '4.0.0-beta.2-jito',
    '4.4.0-beta.1-jito',
  ],
  [
    'testnet_validators',
    'version_allnodes_jito',
    '3.1.14',
    '4.4.0-beta.1-allnodes',
  ],
  ['mainnet_rpcs', 'version_agave', '3.1.10', '4.3.2'],
  ['mainnet_rpcs', 'version_jito', '3.1.10-jito', '4.3.2-jito'],
  ['testnet_rpcs', 'version_agave', '4.0.0-beta.2', '4.4.0-beta.0'],
  ['testnet_rpcs', 'version_jito', '4.0.0-beta.2-jito', '4.4.0-beta.0-jito'],
  ['devnet_rpcs', 'version_agave', '3.1.10', '4.4.0-beta.0'],
  ['devnet_rpcs', 'version_jito', '3.1.10-jito', '4.4.0-beta.0-jito'],
]

type Recorded = {
  deps: FloorDeps
  read: number
  info: string[]
  errors: string[]
  exitCodes: number[]
}

/** Floor dependencies that serve these pins (null for no versions.yml) and record what is said. */
const recorder = (versions: unknown | null): Recorded => {
  const rec: Recorded = {
    read: 0,
    info: [],
    errors: [],
    exitCodes: [],
    deps: {
      readVersions: () => {
        rec.read++
        return Promise.resolve(versions)
      },
      defaults: defaultVersionsObject,
      info: (line) => rec.info.push(line),
      error: (line) => rec.errors.push(line),
      setExitCode: (code) => rec.exitCodes.push(code),
    },
  }
  return rec
}

Deno.test('the floors are 4.3.0 on mainnet and 4.4.0-beta.0 on testnet and devnet', () => {
  assertEquals(ALPENGLOW_FLOORS, {
    mainnet: '4.3.0',
    testnet: '4.4.0-beta.0',
    devnet: '4.4.0-beta.0',
  })
})

Deno.test('a version is compared by its release and pre-release; the jito and allnodes tags do not change the release', () => {
  const belowMainnet = [
    '3.1.10',
    '3.1.10-jito',
    '3.1.14',
    '4.0.0-beta.2',
    '4.0.0-beta.2-jito',
    '4.2.2',
    '4.2.2-jito.1',
    '4.3.0-beta.3',
    '4.3.0-rc.1-jito',
  ]
  const fromMainnet = [
    '4.3.0',
    '4.3.0-jito.0',
    '4.3.0-jito.1',
    '4.3.0-allnodes.1',
    '4.3.1-jito',
    '4.3.2',
    '4.3.2-jito',
    '4.3.2-allnodes',
    '4.4.0-beta.0',
    '4.4.0-beta.1-jito',
    '4.4.0-beta.1-allnodes',
    'v4.3.2',
    '5.0.0',
  ]
  const belowTestnet = [
    '3.1.14',
    '4.0.0-beta.2-jito',
    '4.3.2',
    '4.3.2-jito',
    '4.3.2-allnodes',
    '4.4.0-alpha.5',
    '4.4.0-alpha.5-jito',
  ]
  const fromTestnet = [
    '4.4.0-beta.0',
    '4.4.0-beta.0-jito',
    '4.4.0-beta.1',
    '4.4.0-beta.1-jito',
    '4.4.0-beta.1-allnodes',
    '4.4.0-rc.1',
    '4.4.0',
    '4.4.1-jito',
    '4.5.0',
  ]
  for (const version of belowMainnet) {
    assert(isBelowFloor(version, ALPENGLOW_FLOORS.mainnet), version)
  }
  for (const version of fromMainnet) {
    assertEquals(
      isBelowFloor(version, ALPENGLOW_FLOORS.mainnet),
      false,
      version,
    )
  }
  for (const version of belowTestnet) {
    assert(isBelowFloor(version, ALPENGLOW_FLOORS.testnet), version)
  }
  for (const version of fromTestnet) {
    assertEquals(
      isBelowFloor(version, ALPENGLOW_FLOORS.testnet),
      false,
      version,
    )
  }
  // The order of a release and its pre-releases, and tags that change nothing.
  assertEquals(compareClientVersions('4.4.0-beta.0', '4.4.0-beta.1'), -1)
  assertEquals(compareClientVersions('4.4.0-beta.1', '4.4.0-rc.1'), -1)
  assertEquals(compareClientVersions('4.4.0-rc.1', '4.4.0'), -1)
  assertEquals(compareClientVersions('4.3.2-jito', '4.3.2'), 0)
  assertEquals(compareClientVersions('4.3.0-jito.0', '4.3.0-allnodes.1'), 0)
  assertEquals(compareClientVersions('4.4.0-beta.1-jito', '4.4.0-beta.1'), 0)
})

Deno.test('a version this cannot read is never reported as below the floor', () => {
  for (const version of ['latest', '', '4.3', 'master', '4.3.1-patched']) {
    assertEquals(compareClientVersions(version, '4.3.0'), null, version)
    assertEquals(
      isBelowFloor(version, ALPENGLOW_FLOORS.mainnet),
      false,
      version,
    )
  }
  const odd = {
    mainnet_rpcs: { version_agave: 4.3, version_jito: 'custom-fork' },
    testnet_rpcs: { version_agave: undefined },
  }
  assertEquals(findBelowFloorPins(odd), [])
})

Deno.test('the defaults are not below the floor of their network', () => {
  assertEquals(findBelowFloorPins(defaultVersionsObject()), [])
})

Deno.test('every agave, jito and allnodes pin below the floor of its network is named with the default to set', () => {
  const found = findBelowFloorPins(OLD_DEFAULTS as unknown as CmnType)
  assertEquals(
    found.map((pin) => [pin.section, pin.key, pin.pinned, pin.suggested]),
    OLD_PINS_BELOW_FLOOR,
  )
  assertEquals(
    found.map((pin) => pin.floor),
    found.map((pin) => ALPENGLOW_FLOORS[pin.network]),
  )
})

Deno.test('a command that installs a client is refused on a pin below the floor, naming the key to change and the default to set', async () => {
  const rec = recorder(OLD_DEFAULTS)
  assertEquals(await refuseBelowFloorPins('mainnet', 'rpc', rec.deps), true)
  assertEquals(rec.exitCodes, [1])
  assertEquals(rec.info, [])
  const message = rec.errors.join('\n')
  assertStringIncludes(message, '~/.slv/versions.yml')
  assertStringIncludes(message, 'epoch 1064')
  assertStringIncludes(message, '4.3.0')
  assertStringIncludes(message, 'mainnet_rpcs.version_agave: 3.1.10 -> 4.3.2')
  assertStringIncludes(
    message,
    'mainnet_rpcs.version_jito: 3.1.10-jito -> 4.3.2-jito',
  )
  assertStringIncludes(message, 'Nothing was changed')
  // Only the keys of its own section.
  assertEquals(message.includes('testnet'), false)
  assertEquals(message.includes('devnet'), false)
})

Deno.test('each network and role is refused on its own section only, and testnet and devnet on 4.4.0-beta.0', async () => {
  const cases: Array<[string, 'validator' | 'rpc', string[]]> = [
    ['mainnet', 'validator', []],
    ['mainnet', 'rpc', ['mainnet_rpcs']],
    ['testnet', 'validator', ['testnet_validators']],
    ['testnet', 'rpc', ['testnet_rpcs']],
    ['devnet', 'rpc', ['devnet_rpcs']],
  ]
  for (const [network, role, sections] of cases) {
    const rec = recorder(OLD_DEFAULTS)
    const refused = await refuseBelowFloorPins(network, role, rec.deps)
    assertEquals(refused, sections.length > 0, `${network} ${role}`)
    assertEquals(rec.exitCodes, refused ? [1] : [], `${network} ${role}`)
    const named = [
      ...new Set(
        rec.errors.join('\n').match(/\b\w+_(?:validators|rpcs)(?=\.)/g) ?? [],
      ),
    ]
    assertEquals(named, sections, `${network} ${role}`)
    if (refused && network !== 'mainnet') {
      assertStringIncludes(rec.errors.join('\n'), '4.4.0-beta.0')
      assertStringIncludes(rec.errors.join('\n'), `${network} already runs`)
    }
  }
})

Deno.test('nothing is refused without a versions.yml, for pins at or above the floor, or for a network the role does not have', async () => {
  const missing = recorder(null)
  assertEquals(
    await refuseBelowFloorPins('mainnet', 'rpc', missing.deps),
    false,
  )
  assertEquals(missing.read, 1)
  const current = recorder(defaultVersionsObject())
  for (
    const [network, role] of [
      ['mainnet', 'validator'],
      ['mainnet', 'rpc'],
      ['testnet', 'validator'],
      ['testnet', 'rpc'],
      ['devnet', 'rpc'],
    ] as const
  ) {
    assertEquals(
      await refuseBelowFloorPins(network, role, current.deps),
      false,
      `${network} ${role}`,
    )
  }
  assertEquals([current.errors, current.exitCodes], [[], []])
  const none = recorder(OLD_DEFAULTS)
  for (const network of ['devnet', 'localnet', 'Mainnet', undefined]) {
    assertEquals(
      await refuseBelowFloorPins(network, 'validator', none.deps),
      false,
      String(network),
    )
  }
  assertEquals([none.read, none.errors, none.exitCodes], [0, [], []])
})

Deno.test('slv upgrade prints one line for every pin below the floor and fails nothing', async () => {
  const rec = recorder(OLD_DEFAULTS)
  const pins = await noticeBelowFloorPins(rec.deps)
  assertEquals(pins.length, OLD_PINS_BELOW_FLOOR.length)
  assertEquals(rec.info.length, OLD_PINS_BELOW_FLOOR.length)
  for (
    const [index, [section, key, pinned, suggested]] of OLD_PINS_BELOW_FLOOR
      .entries()
  ) {
    const line = rec.info[index]
    assertEquals(line.includes('\n'), false)
    for (const part of [`${section}.${key}`, pinned, suggested]) {
      assertStringIncludes(line, part)
    }
  }
  assertStringIncludes(rec.info[3], 'below 4.3.0')
  assertStringIncludes(rec.info[0], 'below 4.4.0-beta.0')
  assertEquals([rec.errors, rec.exitCodes], [[], []])

  const quiet = recorder(defaultVersionsObject())
  assertEquals(await noticeBelowFloorPins(quiet.deps), [])
  assertEquals(quiet.info, [])
  assertEquals(await noticeBelowFloorPins(recorder(null).deps), [])
  const broken = recorder(null)
  broken.deps.readVersions = () => Promise.reject(new Error('cannot read'))
  assertEquals(await noticeBelowFloorPins(broken.deps), [])
  assertEquals([broken.info, broken.errors, broken.exitCodes], [[], [], []])
})

const indexOfCall = (source: string, call: string, label: string): number => {
  const index = source.indexOf(call)
  assert(index > 0, `${label}: no ${call}`)
  return index
}

Deno.test('every deploy, init and switch entry calls the version floor before it does anything else', async () => {
  const entries: Array<[string, string, string[]]> = [
    [
      'src/validator/deploy/deployValidatorMainnet.ts',
      "refuseBelowFloorPins('mainnet', 'validator')",
      ['listValidators(', 'confirmDeploy(', 'runAnsilbe('],
    ],
    [
      'src/validator/deploy/deployValidatorTestnet.ts',
      "refuseBelowFloorPins('testnet', 'validator')",
      ['listValidators(', 'confirmDeploy(', 'runAnsilbe('],
    ],
    [
      'src/rpc/deploy/deployRPCMainnet.ts',
      "refuseBelowFloorPins('mainnet', 'rpc')",
      ['listRPCs(', 'confirmDeploy(', 'runAnsilbe('],
    ],
    [
      'src/rpc/deploy/deployRPCTestnet.ts',
      "refuseBelowFloorPins('testnet', 'rpc')",
      ['listRPCs(', 'confirmDeploy(', 'runAnsilbe('],
    ],
    [
      'src/rpc/deploy/deployRPCDevnet.ts',
      "refuseBelowFloorPins('devnet', 'rpc')",
      ['listRPCs(', 'confirmDeploy(', 'runAnsilbe('],
    ],
    [
      'src/validator/init/init.ts',
      "refuseBelowFloorPins(validator.network, 'validator')",
      ['genPasswordYml(', 'checkSSHConnection(', 'initTestnetConfig('],
    ],
    [
      'src/rpc/init.ts',
      "refuseBelowFloorPins(network, 'rpc')",
      ['checkSSHConnection(', 'testnetInitRpc(', 'mainnetInitRpc('],
    ],
  ]
  for (const [path, guard, later] of entries) {
    const source = await read(path)
    const at = indexOfCall(source, guard, path)
    for (const call of later) {
      assert(
        at < indexOfCall(source, call, path),
        `${path}: the floor comes after ${call}`,
      )
    }
  }
  const index = await read('src/validator/index.ts')
  const switchBlock = index.slice(
    index.indexOf("validatorCmd.command('switch')"),
  )
  const at = indexOfCall(
    switchBlock,
    "refuseBelowFloorPins(network, 'validator')",
    'switch',
  )
  for (const call of ['From Validator Name', 'switchValidator(']) {
    assert(
      at < indexOfCall(switchBlock, call, 'switch'),
      `switch: after ${call}`,
    )
  }
})

Deno.test('slv upgrade:settings prints the notice after it migrates versions.yml and copies the templates', async () => {
  const source = await read('src/index.ts')
  const action = source.slice(source.indexOf("command('upgrade:settings')"))
  const migrate = indexOfCall(
    action,
    'migrateVersionsYml()',
    'upgrade:settings',
  )
  const copy = indexOfCall(action, 'copyTemplateDirs()', 'upgrade:settings')
  const notice = indexOfCall(
    action,
    'noticeBelowFloorPins()',
    'upgrade:settings',
  )
  assert(migrate < notice && copy < notice, 'the notice comes before a step')
})
