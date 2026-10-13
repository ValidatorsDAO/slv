import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import {
  decidePromotionConfirmation,
  type InventoryHost,
  resolveSingleHostTarget,
} from '/lib/targetGuard.ts'
import { runAnsilbe } from '/lib/runAnsible.ts'
import {
  type PrecheckInput,
  type PrecheckResult,
  runSetIdentity,
  type SetIdentityDeps,
} from '/lib/identityPrecheck.ts'

const IDENTITY = 'Aa'.repeat(22)
const OTHER_IDENTITY = 'Bb'.repeat(22)
const VOTE = 'Cc'.repeat(22)

const makeHost = (
  name: string,
  ansibleHost: string,
  identityAccount: string,
): InventoryHost => ({
  name,
  ansibleHost,
  identityAccount,
  voteAccount: VOTE,
  ansibleConnection: '',
})

const HOSTS: InventoryHost[] = [
  makeHost('val-a', '203.0.113.10', IDENTITY),
  makeHost('val-b', '203.0.113.11', IDENTITY),
  makeHost('val-c', '203.0.113.12', OTHER_IDENTITY),
]

// --- target resolution ------------------------------------------------------

Deno.test('set:identity target: a missing -p is rejected', () => {
  for (const requested of [undefined, '', '   ']) {
    const result = resolveSingleHostTarget(
      HOSTS,
      requested,
      'mainnet_validators',
    )
    assertEquals(result.ok, false, String(requested))
    if (!result.ok) assertStringIncludes(result.error, '-p')
  }
})

Deno.test('set:identity target: a comma list is rejected', () => {
  const result = resolveSingleHostTarget(
    HOSTS,
    'val-a,val-b',
    'mainnet_validators',
  )
  assertEquals(result.ok, false)
  if (!result.ok) assertStringIncludes(result.error, 'exactly one')
})

Deno.test('set:identity target: an unknown name or an ansible pattern is rejected', () => {
  for (
    const requested of [
      'val-z',
      'val-*',
      'all',
      'mainnet_validators',
      'val-a:val-b',
      '!val-a',
    ]
  ) {
    const result = resolveSingleHostTarget(
      HOSTS,
      requested,
      'mainnet_validators',
    )
    assertEquals(result.ok, false, requested)
  }
  const unknown = resolveSingleHostTarget(HOSTS, 'val-z', 'mainnet_validators')
  if (!unknown.ok) assertStringIncludes(unknown.error, 'val-z')
})

Deno.test('set:identity target: exactly one known host is accepted', () => {
  assertEquals(resolveSingleHostTarget(HOSTS, 'val-a', 'mainnet_validators'), {
    ok: true,
    host: HOSTS[0],
  })
  assertEquals(
    resolveSingleHostTarget(HOSTS, ' val-b ', 'mainnet_validators'),
    { ok: true, host: HOSTS[1] },
  )
})

Deno.test('mainnet promotion needs a terminal; testnet does not', () => {
  assertEquals(decidePromotionConfirmation('testnet', true), 'none')
  assertEquals(decidePromotionConfirmation('testnet', false), 'none')
  assertEquals(decidePromotionConfirmation('mainnet', true), 'confirm')
  assertEquals(decidePromotionConfirmation('mainnet', false), 'refuse')
})

// --- the command flow -----------------------------------------------------

type Run = {
  playbook: string
  inventoryType: string
  limit: string
  extraVars?: Record<string, string | boolean>
}

type Harness = {
  deps: SetIdentityDeps
  runs: Run[]
  prechecks: PrecheckInput[]
  confirms: { message: string; default: boolean }[]
  info: string[]
  errors: string[]
  exitCodes: number[]
}

const harness = (
  options: {
    isTty?: boolean
    precheck?: PrecheckResult
    answer?: boolean
    runResult?: boolean
    hosts?: InventoryHost[]
  } = {},
): Harness => {
  const h: Harness = {
    deps: undefined as unknown as SetIdentityDeps,
    runs: [],
    prechecks: [],
    confirms: [],
    info: [],
    errors: [],
    exitCodes: [],
  }
  h.deps = {
    isTty: () => options.isTty ?? true,
    readHosts: () => Promise.resolve(options.hosts ?? HOSTS),
    precheck: (input) => {
      h.prechecks.push(input)
      return Promise.resolve(
        options.precheck ?? { ok: true, failures: [], notes: [] },
      )
    },
    confirm: (opts) => {
      h.confirms.push({ message: opts.message, default: opts.default })
      return Promise.resolve(options.answer ?? true)
    },
    runPlaybook: (playbook, inventoryType, limit, extraVars) => {
      h.runs.push({ playbook, inventoryType, limit, extraVars })
      return Promise.resolve(options.runResult ?? true)
    },
    templateRoot: () => '/t',
    info: (line) => h.info.push(line),
    error: (line) => h.errors.push(line),
    setExitCode: (code) => h.exitCodes.push(code),
  }
  return h
}

Deno.test('set:identity runs nothing when -p is missing, a list, or unknown', async () => {
  for (const pubkey of [undefined, 'val-a,val-b', 'val-z']) {
    const h = harness()
    const ok = await runSetIdentity({ network: 'testnet', pubkey }, h.deps)
    assertEquals(ok, false, String(pubkey))
    assertEquals(h.runs, [])
    assertEquals(h.prechecks, [])
    assertEquals(h.exitCodes, [1])
  }
})

Deno.test('set:identity rejects a network other than mainnet or testnet', async () => {
  for (const network of ['devnet', 'Mainnet', '', undefined]) {
    const h = harness()
    const ok = await runSetIdentity({ network, pubkey: 'val-a' }, h.deps)
    assertEquals(ok, false, String(network))
    assertEquals(h.runs, [])
    assertEquals(h.prechecks, [])
    assertEquals(h.exitCodes, [1])
  }
})

Deno.test('set:identity on mainnet without a terminal is refused before any check runs', async () => {
  const h = harness({ isTty: false })
  const ok = await runSetIdentity(
    { network: 'mainnet', pubkey: 'val-a' },
    h.deps,
  )
  assertEquals(ok, false)
  assertEquals(h.prechecks, [])
  assertEquals(h.runs, [])
  assertEquals(h.exitCodes, [1])
})

Deno.test('set:identity does not run the playbook when the precheck fails, and prints why', async () => {
  const h = harness({
    precheck: {
      ok: false,
      failures: ['identity is already in gossip at 198.51.100.7'],
      notes: [],
    },
  })
  const ok = await runSetIdentity(
    { network: 'testnet', pubkey: 'val-a' },
    h.deps,
  )
  assertEquals(ok, false)
  assertEquals(h.runs, [])
  assertEquals(h.exitCodes, [1])
  assertStringIncludes(h.errors.join('\n'), '198.51.100.7')
})

Deno.test('set:identity promotes exactly the named host on testnet', async () => {
  const h = harness()
  const ok = await runSetIdentity(
    { network: 'testnet', pubkey: 'val-a' },
    h.deps,
  )
  assertEquals(ok, true)
  assertEquals(h.runs, [{
    playbook: '/t/ansible/testnet-validator/set_identity_key.yml',
    inventoryType: 'testnet_validators',
    limit: 'val-a',
    extraVars: undefined,
  }])
  assertEquals(h.prechecks.length, 1)
  assertEquals(h.prechecks[0].network, 'testnet')
  assertEquals(h.prechecks[0].target.name, 'val-a')
  assertEquals(h.prechecks[0].peerDownConfirmed, false)
  assertEquals(h.confirms, [])
  assertEquals(h.exitCodes, [])
})

Deno.test('set:identity asks once on mainnet with the default set to no, then promotes', async () => {
  const h = harness({ answer: true })
  const ok = await runSetIdentity(
    { network: 'mainnet', pubkey: 'val-b' },
    h.deps,
  )
  assertEquals(ok, true)
  assertEquals(h.confirms.length, 1)
  assertEquals(h.confirms[0].default, false)
  assertStringIncludes(h.confirms[0].message, 'val-b')
  assertEquals(h.runs.length, 1)
  assertEquals(
    h.runs[0].playbook,
    '/t/ansible/mainnet-validator/set_identity_key.yml',
  )
  assertEquals(h.runs[0].inventoryType, 'mainnet_validators')
  assertEquals(h.runs[0].limit, 'val-b')
})

Deno.test('set:identity on mainnet does nothing when the user answers no', async () => {
  const h = harness({ answer: false })
  const ok = await runSetIdentity(
    { network: 'mainnet', pubkey: 'val-a' },
    h.deps,
  )
  assertEquals(ok, false)
  assertEquals(h.runs, [])
  assertEquals(h.prechecks.length, 1)
})

Deno.test('set:identity passes first_activation and the peer-down flag through', async () => {
  const h = harness()
  const ok = await runSetIdentity({
    network: 'testnet',
    pubkey: 'val-a',
    firstActivation: true,
    peerDownConfirmed: true,
  }, h.deps)
  assert(ok)
  assertEquals(h.runs[0].extraVars, { first_activation: true })
  assertEquals(h.prechecks[0].peerDownConfirmed, true)

  const plain = harness()
  await runSetIdentity({ network: 'testnet', pubkey: 'val-a' }, plain.deps)
  assertEquals(plain.runs[0].extraVars, undefined)
})

Deno.test('set:identity limits the playbook to one host even when peers share the identity', async () => {
  const h = harness()
  await runSetIdentity({ network: 'testnet', pubkey: 'val-a' }, h.deps)
  assertEquals(h.runs.length, 1)
  assertEquals(h.runs[0].limit, 'val-a')
  // val-b holds the same identity_account; it is the precheck's concern, not a run target.
  assertEquals(h.prechecks[0].hosts.map((x) => x.name), [
    'val-a',
    'val-b',
    'val-c',
  ])
})

Deno.test('set:identity hands ansible exactly one host and a boolean first_activation', async () => {
  const argv: string[][] = []
  const h = harness()
  h.deps.runPlaybook = (playbook, inventoryType, limit, extraVars) =>
    runAnsilbe(playbook, inventoryType, limit, extraVars, {
      // The all-hosts guard checks the named host against the inventory.
      guard: {
        isTty: () => false,
        getEnv: () => undefined,
        readHosts: () => Promise.resolve(HOSTS),
      },
      spawn: (args) => {
        argv.push(args)
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        })
      },
    })
  const ok = await runSetIdentity({
    network: 'testnet',
    pubkey: 'val-a',
    firstActivation: true,
  }, h.deps)
  assertEquals(ok, true)
  assertEquals(argv.length, 1)
  // argv: -i <inventory> <playbook> --limit <host> --extra-vars <json>
  assertEquals(argv[0].slice(3), [
    '--limit',
    'val-a',
    '--extra-vars',
    '{"first_activation":true}',
  ])
  assertEquals(argv[0][2], '/t/ansible/testnet-validator/set_identity_key.yml')
})
