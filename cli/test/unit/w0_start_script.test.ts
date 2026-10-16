import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { Command } from '@cliffy'
import type { ExtraVars, RunAnsibleOptions } from '/lib/runAnsible.ts'
import { registerSha256PatchCommands } from '/lib/sha256Patch.ts'
import {
  installAgaveBinary,
  parseNodeNetwork,
  registerSolanaBinaryCommands,
  type StartScriptDeps,
  startScriptPlay,
} from '/lib/startScript.ts'

type Call = {
  playbook: string
  inventoryType: string
  limit?: string
  extraVars?: ExtraVars
  options?: RunAnsibleOptions
}

const harness = (results: boolean[] = []) => {
  const calls: Call[] = []
  const info: string[] = []
  const errors: string[] = []
  const exitCodes: number[] = []
  const deps: Partial<StartScriptDeps> = {
    run: (playbook, inventoryType, limit, extraVars, options) => {
      calls.push({ playbook, inventoryType, limit, extraVars, options })
      return Promise.resolve(results[calls.length - 1] ?? true)
    },
    // The version floor reads ~/.slv/versions.yml; these tests do not.
    refuseBelowFloor: () => Promise.resolve(false),
    templateRoot: () => '/t',
    info: (line) => info.push(line),
    error: (line) => errors.push(line),
    setExitCode: (code) => exitCodes.push(code),
  }
  return { deps, calls, info, errors, exitCodes }
}

type Registration = (cmd: Command, deps: Partial<StartScriptDeps>) => void

const validatorBinary: Registration = (cmd, deps) =>
  registerSolanaBinaryCommands(cmd, 'validator', deps)
const rpcBinary: Registration = (cmd, deps) =>
  registerSolanaBinaryCommands(cmd, 'rpc', deps)
const validatorPatch: Registration = (cmd, deps) =>
  registerSha256PatchCommands(cmd, 'validator', 'testnet', deps)
const rpcPatch: Registration = (cmd, deps) =>
  registerSha256PatchCommands(cmd, 'rpc', 'mainnet', deps)

const run = async (
  register: Registration,
  argv: string[],
  results: boolean[] = [],
) => {
  const h = harness(results)
  const cmd = new Command().throwErrors()
  register(cmd, h.deps)
  await cmd.parse(argv)
  return h
}

type Row = {
  label: string
  register: Registration
  argv: string[]
  install: string
  render: string
  inventory: string
  limit?: string
  extraVars?: ExtraVars
  followUp: string
}

const MV = '/t/ansible/mainnet-validator'
const TV = '/t/ansible/testnet-validator'

const ROWS: Row[] = [
  {
    label: 'v build:solana -n mainnet -p val-a',
    register: validatorBinary,
    argv: ['build:solana', '-n', 'mainnet', '-p', 'val-a'],
    install: `${MV}/install_solana.yml`,
    render: `${MV}/update_startup_config.yml`,
    inventory: 'mainnet_validators',
    limit: 'val-a',
    followUp: 'slv v update:script -n mainnet -p val-a',
  },
  {
    label: 'v build:solana -n testnet, no host named',
    register: validatorBinary,
    argv: ['build:solana', '-n', 'testnet'],
    install: `${TV}/install_solana.yml`,
    render: `${TV}/update_startup_config.yml`,
    inventory: 'testnet_validators',
    followUp: 'slv v update:script -n testnet',
  },
  {
    label: 'v build:solana, default network',
    register: validatorBinary,
    argv: ['build:solana', '-p', 'val-a'],
    install: `${TV}/install_solana.yml`,
    render: `${TV}/update_startup_config.yml`,
    inventory: 'testnet_validators',
    limit: 'val-a',
    followUp: 'slv v update:script -n testnet -p val-a',
  },
  {
    label: 'v build:solana-cli -n mainnet -p val-a',
    register: validatorBinary,
    argv: ['build:solana-cli', '-n', 'mainnet', '-p', 'val-a'],
    install: `${MV}/install_solana.yml`,
    render: `${MV}/update_startup_config.yml`,
    inventory: 'mainnet_validators',
    limit: 'val-a',
    followUp: 'slv v update:script -n mainnet -p val-a',
  },
  {
    label: 'v install:solana -n mainnet -p val-a -v 4.3.0',
    register: validatorBinary,
    argv: ['install:solana', '-n', 'mainnet', '-p', 'val-a', '-v', '4.3.0'],
    install: '/t/ansible/cmn/install_solana.yml',
    render: `${MV}/update_startup_config.yml`,
    inventory: 'mainnet_validators',
    limit: 'val-a',
    extraVars: { version: '4.3.0' },
    followUp: 'slv v update:script -n mainnet -p val-a',
  },
  {
    label: 'v install:solana, default network, no host named',
    register: validatorBinary,
    argv: ['install:solana'],
    install: '/t/ansible/cmn/install_solana.yml',
    render: `${MV}/update_startup_config.yml`,
    inventory: 'mainnet_validators',
    followUp: 'slv v update:script -n mainnet',
  },
  {
    label: 'v install:solana -n testnet -p val-a',
    register: validatorBinary,
    argv: ['install:solana', '-n', 'testnet', '-p', 'val-a'],
    install: '/t/ansible/cmn/install_solana.yml',
    render: `${TV}/update_startup_config.yml`,
    inventory: 'testnet_validators',
    limit: 'val-a',
    followUp: 'slv v update:script -n testnet -p val-a',
  },
  {
    label: 'v patch:sha256 -n mainnet -p val-a',
    register: validatorPatch,
    argv: [
      'patch:sha256',
      '-n',
      'mainnet',
      '-p',
      'val-a',
      '--solana-version',
      'v3.1.10',
    ],
    install: '/t/ansible/cmn/patch_sha256.yml',
    render: `${MV}/update_startup_config.yml`,
    inventory: 'mainnet_validators',
    limit: 'val-a',
    extraVars: { solana_version: 'v3.1.10' },
    followUp: 'slv v update:script -n mainnet -p val-a',
  },
  {
    label: 'rpc build:solana -n mainnet -p rpc-a',
    register: rpcBinary,
    argv: ['build:solana', '-n', 'mainnet', '-p', 'rpc-a'],
    install: '/t/ansible/mainnet-rpc/install_solana.yml',
    render: '/t/ansible/mainnet-rpc/update_startup_config.yml',
    inventory: 'mainnet_rpcs',
    limit: 'rpc-a',
    followUp: 'slv rpc update:script -n mainnet -p rpc-a',
  },
  {
    label: 'rpc build:solana -n devnet, no host named',
    register: rpcBinary,
    argv: ['build:solana', '-n', 'devnet'],
    install: '/t/ansible/devnet-rpc/install_solana.yml',
    render: '/t/ansible/devnet-rpc/update_startup_config.yml',
    inventory: 'devnet_rpcs',
    followUp: 'slv rpc update:script -n devnet',
  },
  {
    label: 'rpc build:solana-cli, default network',
    register: rpcBinary,
    argv: ['build:solana-cli', '-p', 'rpc-a'],
    install: '/t/ansible/mainnet-rpc/install_solana.yml',
    render: '/t/ansible/mainnet-rpc/update_startup_config.yml',
    inventory: 'mainnet_rpcs',
    limit: 'rpc-a',
    followUp: 'slv rpc update:script -n mainnet -p rpc-a',
  },
  {
    label: 'rpc install:solana -n testnet -p rpc-a -v 3.1.10',
    register: rpcBinary,
    argv: ['install:solana', '-n', 'testnet', '-p', 'rpc-a', '-v', '3.1.10'],
    install: '/t/ansible/cmn/install_solana.yml',
    render: '/t/ansible/testnet-rpc/update_startup_config.yml',
    inventory: 'testnet_rpcs',
    limit: 'rpc-a',
    extraVars: { version: '3.1.10' },
    followUp: 'slv rpc update:script -n testnet -p rpc-a',
  },
  {
    label: 'rpc install:solana -n devnet, no host named',
    register: rpcBinary,
    argv: ['install:solana', '-n', 'devnet'],
    install: '/t/ansible/cmn/install_solana.yml',
    render: '/t/ansible/devnet-rpc/update_startup_config.yml',
    inventory: 'devnet_rpcs',
    followUp: 'slv rpc update:script -n devnet',
  },
  {
    label: 'rpc patch:sha256 -n testnet -p rpc-a',
    register: rpcPatch,
    argv: [
      'patch:sha256',
      '-n',
      'testnet',
      '-p',
      'rpc-a',
      '--solana-version',
      '3.1.10',
    ],
    install: '/t/ansible/cmn/patch_sha256.yml',
    render: '/t/ansible/testnet-rpc/update_startup_config.yml',
    inventory: 'testnet_rpcs',
    limit: 'rpc-a',
    extraVars: { solana_version: 'v3.1.10' },
    followUp: 'slv rpc update:script -n testnet -p rpc-a',
  },
]

Deno.test('every command that installs, builds or patches the agave binary runs the start-script play after it, with the same limit', async () => {
  for (const row of ROWS) {
    const h = await run(row.register, row.argv)
    assertEquals(h.calls.length, 2, row.label)
    const [install, render] = h.calls
    assertEquals(install.playbook, row.install, row.label)
    assertEquals(render.playbook, row.render, row.label)
    assertEquals(install.inventoryType, row.inventory, row.label)
    assertEquals(render.inventoryType, row.inventory, row.label)
    assertEquals(install.limit, row.limit, row.label)
    assertEquals(render.limit, install.limit, row.label)
    assertEquals(install.extraVars, row.extraVars, row.label)
    assertEquals(render.extraVars, undefined, row.label)
    assertEquals(h.exitCodes, [], row.label)
    assertEquals(h.errors, [], row.label)
  }
})

Deno.test('the start-script play is told that the hosts were approved for the install play', async () => {
  for (const row of ROWS) {
    const h = await run(row.register, row.argv)
    assertEquals(h.calls[0].options, undefined, row.label)
    assertEquals(h.calls[1].options, { allHostsConfirmed: true }, row.label)
  }
})

Deno.test('a failing start-script play exits non-zero and says the node must not be restarted until update:script succeeds', async () => {
  for (const row of ROWS) {
    const h = await run(row.register, row.argv, [true, false])
    assertEquals(h.calls.length, 2, row.label)
    assertEquals(h.exitCodes, [1], row.label)
    const message = h.errors.join('\n')
    assertStringIncludes(message, 'installed', row.label)
    assertStringIncludes(message, 'start script was not updated', row.label)
    assertStringIncludes(message, 'Do not restart the node', row.label)
    assertStringIncludes(message, `\`${row.followUp}\``, row.label)
  }
})

Deno.test('the start-script play does not run when the install play did not succeed', async () => {
  for (const row of ROWS) {
    const h = await run(row.register, row.argv, [false])
    assertEquals(h.calls.length, 1, row.label)
    assertEquals(h.calls[0].playbook, row.install, row.label)
    assertEquals(h.errors, [], row.label)
    assertEquals(h.exitCodes, [], row.label)
  }
})

Deno.test('every command that installs, builds or patches the agave binary stops before any play when the pins of its network and role are below what Alpenglow runs on', async () => {
  for (const row of ROWS) {
    const h = harness()
    const asked: string[] = []
    h.deps.refuseBelowFloor = (network, role) => {
      asked.push(`${network} ${role}`)
      return Promise.resolve(true)
    }
    const cmd = new Command().throwErrors()
    row.register(cmd, h.deps)
    await cmd.parse(row.argv)
    const [network, kind] = row.inventory.split('_')
    assertEquals(
      asked,
      [`${network} ${kind === 'validators' ? 'validator' : 'rpc'}`],
      row.label,
    )
    assertEquals(h.calls, [], row.label)
  }
})

Deno.test('a network the node role does not have runs nothing and exits non-zero', async () => {
  const cases: [Registration, string[]][] = [
    [validatorBinary, ['build:solana', '-n', 'devnet']],
    [validatorBinary, ['build:solana-cli', '-n', 'Mainnet']],
    [validatorBinary, ['install:solana', '-n', 'devnet']],
    [rpcBinary, ['build:solana', '-n', 'localnet']],
    [rpcBinary, ['install:solana', '-n', 'main']],
  ]
  for (const [register, argv] of cases) {
    const h = await run(register, argv)
    assertEquals(h.calls, [], argv.join(' '))
    assertEquals(h.exitCodes, [1], argv.join(' '))
    assertStringIncludes(h.errors.join('\n'), `"${argv[2]}"`, argv.join(' '))
  }
})

Deno.test('a host pattern is quoted in the update:script command the message names', async () => {
  const h = await run(validatorBinary, [
    'install:solana',
    '-n',
    'mainnet',
    '-p',
    'val-*',
  ], [true, false])
  assertStringIncludes(
    h.errors.join('\n'),
    "`slv v update:script -n mainnet -p 'val-*'`",
  )
})

Deno.test('installAgaveBinary reports success only when both plays succeeded', async () => {
  for (
    const [results, expected] of [
      [[true, true], true],
      [[true, false], false],
      [[false], false],
    ] as [boolean[], boolean][]
  ) {
    const h = harness(results)
    const ok = await installAgaveBinary({
      role: 'rpc',
      network: 'mainnet',
      play: () => 'cmn/install_solana.yml',
      limit: 'rpc-a',
    }, h.deps)
    assertEquals(ok, expected, JSON.stringify(results))
  }
})

Deno.test('the start-script play is the one update:script runs, for every network and role', () => {
  assertEquals(
    startScriptPlay('validator', 'mainnet'),
    'mainnet-validator/update_startup_config.yml',
  )
  assertEquals(
    startScriptPlay('validator', 'testnet'),
    'testnet-validator/update_startup_config.yml',
  )
  for (const network of ['mainnet', 'testnet', 'devnet']) {
    assertEquals(
      startScriptPlay('rpc', network),
      `${network}-rpc/update_startup_config.yml`,
    )
  }
  assertEquals(parseNodeNetwork('validator', 'devnet').ok, false)
  assertEquals(parseNodeNetwork('rpc', 'devnet').ok, true)
})

Deno.test('the validator and rpc commands are the shared ones and no longer start an install play themselves', async () => {
  for (
    const [path, role] of [
      ['src/validator/index.ts', 'validator'],
      ['src/rpc/index.ts', 'rpc'],
    ]
  ) {
    const source = await Deno.readTextFile(
      new URL(`../../${path}`, import.meta.url),
    )
    assertStringIncludes(
      source,
      `registerSolanaBinaryCommands(${role}Cmd, '${role}')`,
      path,
    )
    assertEquals(source.includes('install_solana.yml'), false, path)
    assert(source.includes('registerSha256PatchCommands('), path)
  }
})
