import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert'
import {
  NODE_FACTS_PROBE,
  type NodeFacts,
  parseNodeFacts,
  recommendXdp,
} from '/src/validator/init/nodeFacts.ts'
import { defaultSshIdentity } from '/src/validator/init/setupPlan.ts'
import { verifyInitOnePassword } from '/src/validator/init/onePasswordReady.ts'
import { defaultOpSpawn } from '/lib/secret/opCli.ts'
import { scriptedOp, setupDeps, VAULT } from '/test/unit/_keylessFixtures.ts'

const facts = (): NodeFacts => ({
  kernel: '6.14.0-generic',
  routeDevices: ['enp1s0'],
  validatorRunning: false,
  interfaces: [{
    name: 'enp1s0',
    driver: 'mlx5_core',
    physical: true,
    up: true,
    bond: false,
    bridge: false,
    slaves: [],
  }],
  cpus: [0, 1, 2, 3, 4, 5, 6, 7].map((cpu) => ({
    cpu,
    package: 0,
    core: cpu % 4,
  })),
})
Deno.test('automatic XDP uses physical CPU topology and keeps zero-copy off', () => {
  const f = facts()
  assertEquals(recommendXdp(f).config.xdp_poh_pinned_cpu_core, 2)
  // The second logical CPU is a sibling, not a different physical core.
  f.cpus = [
    { cpu: 0, package: 0, core: 0 },
    { cpu: 1, package: 0, core: 0 },
    { cpu: 2, package: 0, core: 1 },
    { cpu: 3, package: 0, core: 2 },
    { cpu: 4, package: 0, core: 3 },
  ]
  const result = recommendXdp(parseNodeFacts(JSON.stringify(f)))
  assertEquals(result.config, {
    xdp_enabled: true,
    xdp_interface: 'enp1s0',
    xdp_cpu_cores: 1,
    xdp_zero_copy: false,
    xdp_poh_pinned_cpu_core: 2,
  })
  for (const driver of ['ice', 'bnxt_en']) {
    f.interfaces[0].driver = driver
    assertEquals(recommendXdp(f).config.xdp_zero_copy, false)
  }
})
Deno.test('ambiguous or unsupported hardware never gets automatic XDP', () => {
  const cases: Array<(f: NodeFacts) => void> = [
    (f) => {
      f.kernel = '6.5.0'
    },
    (f) => {
      f.routeDevices = []
    },
    (f) => {
      f.routeDevices = ['enp1s0', 'enp2s0']
    },
    (f) => {
      f.interfaces[0].bond = true
    },
    (f) => {
      f.interfaces[0].bridge = true
    },
    (f) => {
      f.interfaces[0].physical = false
    },
    (f) => {
      f.interfaces[0].up = false
    },
    (f) => {
      f.interfaces[0].driver = 'unknown'
    },
    (f) => {
      f.interfaces[0].driver = 'igb'
      f.kernel = '6.8.0'
    },
    (f) => {
      f.cpus = []
    },
    (f) => {
      f.cpus = f.cpus.filter((c) => c.cpu !== 1)
    },
    (f) => {
      f.cpus = f.cpus.filter((c) => c.cpu !== 0)
    },
    (f) => {
      f.cpus = f.cpus.map((c) => ({ ...c, core: 0 }))
    },
  ]
  for (const alter of cases) {
    const f = facts()
    alter(f)
    assertEquals(recommendXdp(f).config, { xdp_enabled: false })
  }
  assertEquals(recommendXdp(null).config, { xdp_enabled: false })
})
Deno.test('node metadata rejects shell syntax, wrong types and duplicate topology entries', () => {
  for (
    const alter of [
      (f: NodeFacts) => {
        f.routeDevices = ['eth0;reboot']
      },
      (f: NodeFacts) => {
        f.interfaces[0].name = 'eth0\n'
      },
      (f: NodeFacts) => {
        f.cpus.push(f.cpus[0])
      },
      (f: NodeFacts) => {
        f.interfaces.push(f.interfaces[0])
      },
      (f: NodeFacts) => {
        f.cpus[0].cpu = -1
      },
    ]
  ) {
    const f = facts()
    alter(f)
    assertThrows(() => parseNodeFacts(JSON.stringify(f)))
  }
  const f = JSON.parse(JSON.stringify(facts()))
  f.interfaces[0].name = 42
  assertThrows(() => parseNodeFacts(JSON.stringify(f)))
  assertStringIncludes(NODE_FACTS_PROBE, "'route', 'get'")
  assertEquals(NODE_FACTS_PROBE.includes('sudo'), false)
})
Deno.test('SSH defaults choose a single public selector and do not invent a missing private key', async () => {
  const dir = await Deno.makeTempDir()
  try {
    assertEquals(await defaultSshIdentity(dir), undefined)
    await Deno.mkdir(`${dir}/.ssh`)
    await Deno.writeTextFile(`${dir}/.ssh/example.pub`, 'public fixture')
    assertEquals(await defaultSshIdentity(dir), `${dir}/.ssh/example.pub`)
    await Deno.writeTextFile(
      `${dir}/.ssh/example`,
      'synthetic file-key fixture',
    )
    assertEquals(await defaultSshIdentity(dir), `${dir}/.ssh/example`)
    await Deno.writeTextFile(`${dir}/.ssh/another.pub`, 'public fixture')
    assertEquals(await defaultSshIdentity(dir), undefined)
    await Deno.writeTextFile(`${dir}/.ssh/id_ed25519.pub`, 'public fixture')
    assertEquals(await defaultSshIdentity(dir), `${dir}/.ssh/id_ed25519.pub`)
    await Deno.writeTextFile(
      `${dir}/.ssh/id_ed25519`,
      'synthetic file-key fixture',
    )
    assertEquals(await defaultSshIdentity(dir), `${dir}/.ssh/id_ed25519`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
Deno.test('missing 1Password account stops before a vault call can open manual signup', async () => {
  const op = scriptedOp(() => ({ success: true, stdout: '[]' }))
  const error = await assertRejects(
    () => verifyInitOnePassword('testnet', setupDeps(op.op)),
    Error,
  )
  assertStringIncludes(error.message, 'Integrate with 1Password CLI')
  assertEquals(op.calls.map((c) => c.args), [[
    'account',
    'list',
    '--format',
    'json',
  ]])
})
Deno.test('readiness checks account and vault metadata without reading secret fields', async () => {
  const op = scriptedOp((args) => ({
    success: true,
    stdout: JSON.stringify(
      args.args[0] === 'account'
        ? [{ url: 'example.1password.com' }]
        : [{ id: VAULT, name: 'Example' }],
    ),
  }))
  await verifyInitOnePassword('testnet', setupDeps(op.op))
  assertEquals(op.calls.map((c) => c.args), [[
    'account',
    'list',
    '--format',
    'json',
  ], ['vault', 'list', '--format', 'json']])
  for (const c of op.calls) {
    assertEquals(c.stdin, null)
    assertEquals(c.env.OP_CACHE, 'false')
  }
})
Deno.test('failed metadata authentication reports setup guidance without echoing provider output', async () => {
  const op = scriptedOp(() => ({
    success: false,
    stdout: 'not-json',
    stderr: 'PRIVATE-CANARY',
  }))
  const error = await assertRejects(
    () => verifyInitOnePassword('testnet', setupDeps(op.op)),
    Error,
  )
  assertEquals(error.message.includes('PRIVATE-CANARY'), false)
})
Deno.test('metadata timeout ends a hung child and returns no partial output', async () => {
  const result = await defaultOpSpawn(Deno.execPath(), [
    'eval',
    'console.log("PRIVATE-CANARY"); setInterval(()=>{},1000)',
  ], { env: {}, stdin: null, timeoutMs: 100 })
  assertEquals(result.success, false)
  assertEquals(result.stdout.length, 0)
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    'did not respond in time',
  )
})

Deno.test('malformed or missing vault metadata fails readiness before server setup', async () => {
  for (const body of ['[]', '[{}]', '[null]', 'not JSON']) {
    const op = scriptedOp((call) => ({
      success: true,
      stdout: call.args[0] === 'account'
        ? '[{"url":"example.1password.com"}]'
        : body,
    }))
    await assertRejects(
      () => verifyInitOnePassword('testnet', setupDeps(op.op)),
      Error,
      'vault access is not ready',
    )
    assertEquals(op.calls.every((call) => call.args[1] === 'list'), true)
  }
})
