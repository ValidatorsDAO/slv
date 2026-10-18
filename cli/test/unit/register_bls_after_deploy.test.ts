import { assertEquals, assertStringIncludes } from '@std/assert'
import type { InventoryType } from '@cmn/types/config.ts'
import type { InventoryHost } from '/lib/targetGuard.ts'
import {
  keyFileOnThisMachine,
  registerBlsAfterDeploy,
  type RegisterBlsAfterDeployDeps,
} from '/src/validator/deploy/registerBlsAfterDeploy.ts'

const IDENTITY_A = 'Aa'.repeat(22)
const IDENTITY_B = 'Bb'.repeat(22)

const host = (name: string, identityAccount: string): InventoryHost => ({
  name,
  ansibleHost: '203.0.113.10',
  identityAccount,
  voteAccount: 'Cc'.repeat(22),
  ansibleConnection: '',
})

const HOSTS = [host('val-a', IDENTITY_A), host('val-b', IDENTITY_B)]

type Calls = {
  read: InventoryType[]
  registered: [string, string | undefined][]
  warnings: string[]
}

/** Deps whose controller holds the key files of `present`, and that record what they are asked. */
const world = (
  present: string[],
  hosts: InventoryHost[] = HOSTS,
): { deps: RegisterBlsAfterDeployDeps; calls: Calls } => {
  const calls: Calls = { read: [], registered: [], warnings: [] }
  return {
    calls,
    deps: {
      readHosts: (inventoryType) => {
        calls.read.push(inventoryType)
        return Promise.resolve(hosts)
      },
      keyFileExists: (identity) => Promise.resolve(present.includes(identity)),
      registerBls: (network, limit) => {
        calls.registered.push([network, limit])
        return Promise.resolve(true)
      },
      warn: (line) => calls.warnings.push(line),
    },
  }
}

Deno.test('deploy registers the BLS key as before for hosts whose identity key file is on this machine', async () => {
  const one = world([IDENTITY_A, IDENTITY_B])
  await registerBlsAfterDeploy('testnet', 'val-a', one.deps)
  assertEquals(one.calls.registered, [['testnet', 'val-a']])
  assertEquals(one.calls.read, ['testnet_validators'])
  assertEquals(one.calls.warnings, [])

  const all = world([IDENTITY_A, IDENTITY_B])
  await registerBlsAfterDeploy('mainnet', undefined, all.deps)
  assertEquals(all.calls.registered, [['mainnet', undefined]])
  assertEquals(all.calls.read, ['mainnet_validators'])
  assertEquals(all.calls.warnings, [])
})

Deno.test('deploy skips the BLS registration of a host whose identity key file is not on this machine, prints the command to run later, and does not fail', async () => {
  for (
    const [network, limit] of [['testnet', 'val-a'], [
      'mainnet',
      undefined,
    ]] as const
  ) {
    const w = world([])
    await registerBlsAfterDeploy(network, limit, w.deps)
    assertEquals(w.calls.registered, [], `${network} ${limit}`)
    const text = w.calls.warnings.join('\n')
    assertStringIncludes(text, `slv v register:bls -n ${network} -p val-a`)
    assertStringIncludes(text, `~/.slv/keys/${IDENTITY_A}.json`)
  }
})

Deno.test('deploy registers only the hosts whose key file is here, and names the command for the others', async () => {
  const w = world([IDENTITY_B])
  await registerBlsAfterDeploy('testnet', undefined, w.deps)
  assertEquals(w.calls.registered, [['testnet', 'val-b']])
  const text = w.calls.warnings.join('\n')
  assertStringIncludes(text, 'slv v register:bls -n testnet -p val-a')
  assertEquals(text.includes('-p val-b'), false)

  const named = world([IDENTITY_A])
  await registerBlsAfterDeploy('testnet', 'val-a, val-b', named.deps)
  assertEquals(named.calls.registered, [['testnet', 'val-a']])
  assertStringIncludes(
    named.calls.warnings.join('\n'),
    'slv v register:bls -n testnet -p val-b',
  )
})

Deno.test('a host the inventory does not have, or an inventory that cannot be read, is left to the registration, which says so', async () => {
  const unknown = world([])
  await registerBlsAfterDeploy('testnet', 'val-z', unknown.deps)
  assertEquals(unknown.calls.registered, [['testnet', 'val-z']])
  assertEquals(unknown.calls.warnings, [])

  const unreadable = world([])
  unreadable.deps.readHosts = () => Promise.reject(new Error('no inventory'))
  await registerBlsAfterDeploy('mainnet', undefined, unreadable.deps)
  assertEquals(unreadable.calls.registered, [['mainnet', undefined]])
  assertEquals(unreadable.calls.warnings, [])
})

Deno.test('a registration that throws is a warning and never fails the deploy', async () => {
  const w = world([IDENTITY_A])
  w.deps.registerBls = () => Promise.reject(new Error('solana is too old'))
  await registerBlsAfterDeploy('testnet', 'val-a', w.deps)
  assertEquals(w.calls.warnings, [
    '⚠️ BLS pubkey registration skipped: solana is too old',
  ])
})

Deno.test('the key file check looks for ~/.slv/keys/<identity>.json: a file is there, a missing one is not', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'bls-keys-' })
  try {
    await Deno.writeTextFile(`${dir}/${IDENTITY_A}.json`, '[]')
    assertEquals(await keyFileOnThisMachine(IDENTITY_A, dir), true)
    assertEquals(await keyFileOnThisMachine(IDENTITY_B, dir), false)
    // A directory of that name is no key file.
    await Deno.mkdir(`${dir}/${IDENTITY_B}.json`)
    assertEquals(await keyFileOnThisMachine(IDENTITY_B, dir), false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
