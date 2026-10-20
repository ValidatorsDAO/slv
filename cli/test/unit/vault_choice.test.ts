import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { chooseVault, OpRefusal } from '/lib/secret/opItems.ts'
import { prepareSecretSetup } from '/lib/secret/setup.ts'
import {
  OTHER_VAULT,
  scriptedOp,
  scriptedTty,
  setupDeps,
  VAULT,
} from '/test/unit/_keylessFixtures.ts'

const THIRD = 'mnopqrstuvwxyzabcdefghijkl'

type Policy = Record<string, { vaultId: string | null; tokenFile: null }>

/** The setup of a verb on `network`, with the vaults that keyless.yml has, and an op that lists three vaults. */
const setupOf = (network: 'testnet' | 'devnet' | 'mainnet', vaults: Policy) => {
  const op = scriptedOp(() => ({
    success: true,
    stdout: JSON.stringify([
      { id: VAULT, name: 'Mainnet' },
      { id: OTHER_VAULT, name: 'Testnet' },
      { id: THIRD, name: 'Spare' },
    ]),
  }))
  return prepareSecretSetup(
    network,
    setupDeps(op.op, {
      readConfig: () =>
        Promise.resolve({
          networks: {
            testnet: { vaultId: null, tokenFile: null },
            ...vaults,
          },
          identityAgent: null,
        }),
    }),
  )
}

Deno.test('the vault of mainnet is not offered for testnet or devnet, nor are the vaults of testnet and devnet for mainnet, and typing one is refused by what it is', async () => {
  for (const network of ['testnet', 'devnet'] as const) {
    const setup = await setupOf(network, {
      mainnet: { vaultId: VAULT, tokenFile: null },
    })
    const terminal = scriptedTty([THIRD])
    const chosen = await chooseVault(network, setup, terminal.tty)
    assertEquals(chosen, { vaultId: THIRD, confirmed: true }, network)
    // The list on the terminal has the other vaults, and not the vault of mainnet.
    assertEquals(terminal.said[0].includes(VAULT), false, network)
    assertStringIncludes(terminal.said[0], '1. Testnet')
    assertStringIncludes(terminal.said[0], '2. Spare')

    // The person types it all the same.
    const typed = scriptedTty([VAULT])
    const error = await assertRejects(
      () => chooseVault(network, setup, typed.tty),
      OpRefusal,
    )
    assertStringIncludes(error.message, 'that is the vault of mainnet')
  }

  const mainnet = await setupOf('mainnet', {
    testnet: { vaultId: OTHER_VAULT, tokenFile: null },
    devnet: { vaultId: THIRD, tokenFile: null },
  })
  const terminal = scriptedTty([VAULT])
  assertEquals(await chooseVault('mainnet', mainnet, terminal.tty), {
    vaultId: VAULT,
    confirmed: true,
  })
  assertEquals(terminal.said[0].includes(OTHER_VAULT), false)
  assertEquals(terminal.said[0].includes(THIRD), false)
  assertStringIncludes(terminal.said[0], '1. Mainnet')
  const taken = await assertRejects(
    () => chooseVault('mainnet', mainnet, scriptedTty([OTHER_VAULT]).tty),
    OpRefusal,
  )
  assertStringIncludes(taken.message, 'that is the vault of testnet')

  // Testnet and devnet may share one: the vault of testnet is offered for devnet.
  const devnet = await setupOf('devnet', {
    testnet: { vaultId: OTHER_VAULT, tokenFile: null },
    mainnet: { vaultId: VAULT, tokenFile: null },
  })
  assertEquals(
    await chooseVault('devnet', devnet, scriptedTty([OTHER_VAULT]).tty),
    { vaultId: OTHER_VAULT, confirmed: true },
  )
})

Deno.test('a vault that keyless.yml has set is used as it is, and a list of nothing but the vaults of the other networks is a refusal', async () => {
  const set = await setupOf('testnet', {
    testnet: { vaultId: OTHER_VAULT, tokenFile: null },
    mainnet: { vaultId: VAULT, tokenFile: null },
  })
  assertEquals(
    await chooseVault('testnet', set, scriptedTty([]).tty),
    { vaultId: OTHER_VAULT, confirmed: false },
  )

  const op = scriptedOp(() => ({
    success: true,
    stdout: JSON.stringify([{ id: VAULT, name: 'Mainnet' }]),
  }))
  const setup = await prepareSecretSetup(
    'testnet',
    setupDeps(op.op, {
      readConfig: () =>
        Promise.resolve({
          networks: {
            testnet: { vaultId: null, tokenFile: null },
            mainnet: { vaultId: VAULT, tokenFile: null },
          },
          identityAgent: null,
        }),
    }),
  )
  const terminal = scriptedTty([VAULT])
  const error = await assertRejects(
    () => chooseVault('testnet', setup, terminal.tty),
    OpRefusal,
  )
  assertStringIncludes(
    error.message,
    'besides the vaults of the other networks',
  )
  assertEquals(terminal.asked, [])
})

Deno.test('vault selection accepts a number and Enter only when exactly one allowed vault remains', async () => {
  const setup = await setupOf('testnet', {
    mainnet: { vaultId: VAULT, tokenFile: null },
  })
  assertEquals(await chooseVault('testnet', setup, scriptedTty(['2']).tty), {
    vaultId: THIRD,
    confirmed: true,
  })
  await assertRejects(
    () => chooseVault('testnet', setup, scriptedTty(['']).tty),
    OpRefusal,
  )
  const only = await setupOf('mainnet', {
    testnet: { vaultId: OTHER_VAULT, tokenFile: null },
    devnet: { vaultId: THIRD, tokenFile: null },
  })
  assertEquals(await chooseVault('mainnet', only, scriptedTty(['']).tty), {
    vaultId: VAULT,
    confirmed: true,
  })
})
