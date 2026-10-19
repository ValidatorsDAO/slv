import { assertEquals, assertFalse, assertStringIncludes } from '@std/assert'
import { type InventoryHost, parseInventoryHosts } from '/lib/targetGuard.ts'
import { runSetIdentity } from '/lib/identityPrecheck.ts'
import { switchValidator } from '@/validator/switch/switchValidator.ts'
import { registerBlsAfterDeploy } from '@/validator/deploy/registerBlsAfterDeploy.ts'
import { validatorSigningRefusal } from '/lib/validatorSigningPolicy.ts'
import { refOf } from '/test/unit/_keylessFixtures.ts'

const host = (
  name: string,
  extra: Partial<InventoryHost> = {},
): InventoryHost => ({
  name,
  ansibleHost: '192.0.2.10',
  identityAccount: 'Aa'.repeat(22),
  voteAccount: '',
  ansibleConnection: '',
  ...extra,
})

Deno.test('inventory parser carries bootstrap and reference guards while preserving legacy hosts', () => {
  const parsed = parseInventoryHosts(
    `testnet_validators:\n  hosts:\n    bootstrap:\n      no_voting: true\n      identity_ref: ${refOf()}\n    bad_flag:\n      no_voting: "false"\n    old: {}\n`,
    'testnet_validators',
  )
  assertEquals(parsed[0].noVoting, true)
  assertEquals(parsed[0].identityRef, refOf())
  assertEquals(parsed[1].noVoting, true)
  assertEquals(parsed[2].noVoting, undefined)
  assertEquals(validatorSigningRefusal(parsed[2]), null)
})

Deno.test('set:identity refuses bootstrap or 1Password reference before RPC, prompts or a playbook', async () => {
  for (
    const extra of [{ noVoting: true }, {
      noVoting: false,
      identityRef: refOf(),
    }]
  ) {
    const errors: string[] = []
    const result = await runSetIdentity({
      network: 'testnet',
      pubkey: 'target',
      firstActivation: true,
    }, {
      readHosts: () => Promise.resolve([host('target', extra)]),
      isTty: () => true,
      readState: () => {
        throw new Error('No RPC')
      },
      precheck: () => {
        throw new Error('No node precheck')
      },
      confirm: () => {
        throw new Error('No signing confirmation')
      },
      runPlaybook: () => {
        throw new Error('No activation')
      },
      error: (line) => errors.push(line),
      setExitCode: () => {},
    })
    assertEquals(result, false)
    assertStringIncludes(
      errors.join('\n'),
      extra.noVoting ? 'sync-only' : '1Password',
    )
  }
})

Deno.test('switch refuses either bootstrap endpoint before any source demotion or inventory swap', async () => {
  for (const blocked of ['source', 'target']) {
    for (const extra of [{ noVoting: true }, { identityRef: refOf() }]) {
      let runs = 0
      let swaps = 0
      assertEquals(
        await switchValidator('testnet_validators', 'source', 'target', {
          readHosts: () =>
            Promise.resolve([
              host('source', blocked === 'source' ? extra : {}),
              host('target', blocked === 'target' ? extra : {}),
            ]),
          run: () => {
            runs++
            return Promise.resolve(true)
          },
          swap: () => {
            swaps++
            return Promise.resolve(true)
          },
        }),
        false,
      )
      assertEquals(runs, 0)
      assertEquals(swaps, 0)
    }
  }
})

Deno.test('post-deploy BLS registration skips bootstrap hosts without inspecting a key file or signing', async () => {
  const warnings: string[] = []
  await registerBlsAfterDeploy('testnet', 'bootstrap', {
    readHosts: () =>
      Promise.resolve([
        host('bootstrap', { noVoting: true, identityRef: refOf() }),
      ]),
    keyFileExists: () => {
      throw new Error('No file signer lookup')
    },
    registerBls: () => {
      throw new Error('No BLS transaction')
    },
    warn: (message) => warnings.push(message),
  })
  assertEquals(warnings.length, 1)
  assertStringIncludes(warnings[0], 'sync-only')
  assertFalse(warnings[0].includes('No BLS transaction'))
})
