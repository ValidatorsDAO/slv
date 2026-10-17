import { assert, assertEquals, assertRejects } from '@std/assert'
import { SolanaNodeTypes } from '@cmn/constants/config.ts'
import {
  MainnetRpcConfigSchema,
  ValidatorMainnetConfigSchema,
  ValidatorTestnetConfigSchema,
} from '@cmn/zod/config.ts'

const read = (relative: string) =>
  Deno.readTextFile(new URL(`../../${relative}`, import.meta.url))

const REF = 'op://vault/item/field'

const host = {
  ansible_host: '203.0.113.10',
  ansible_user: 'ubuntu',
  ansible_ssh_private_key_file: '~/.ssh/id_ed25519',
  name: 'val-a',
  identity_account: 'Aa'.repeat(22),
  vote_account: 'Cc'.repeat(22),
  authority_account: 'Dd'.repeat(22),
}

const testnetHost = {
  ...host,
  validator_type: SolanaNodeTypes[0],
  username: 'solv',
  ip: '203.0.113.10',
}

const mainnetHost = {
  ...host,
  validator_type: SolanaNodeTypes[0],
  commission_bps: 500,
  relayer_url: 'https://relayer.example',
  relayer_account: 'Ee'.repeat(22),
  block_engine_region: 'frankfurt',
  shredstream_address: '203.0.113.11:1002',
  port_rpc: 8899,
  limit_ledger_size: 50_000_000,
  staked_rpc_identity_account: 'Ff'.repeat(22),
  staked_rpc_amount: 0,
  snapshot_url: 'https://snapshots.example',
}

const rpcHost = {
  ...host,
  region: 'frankfurt',
  rpc_type: 'Index RPC',
  snapshot_url: 'https://snapshots.example',
  limit_ledger_size: 50_000_000,
  shredstream_address: '203.0.113.11:1002',
}

Deno.test('a validator host entry validates with an identity_ref, which it keeps, and without one, and the reference has to be a string', () => {
  for (
    const [network, schema, entry] of [
      ['testnet', ValidatorTestnetConfigSchema, testnetHost],
      ['mainnet', ValidatorMainnetConfigSchema, mainnetHost],
    ] as const
  ) {
    const without = schema.safeParse(entry)
    assert(without.success, `${network} without identity_ref`)
    assertEquals(without.data.identity_ref, undefined, network)

    const withRef = schema.safeParse({ ...entry, identity_ref: REF })
    assert(withRef.success, `${network} with identity_ref`)
    assertEquals(withRef.data.identity_ref, REF, network)

    assertEquals(
      schema.safeParse({ ...entry, identity_ref: 5 }).success,
      false,
      `${network}: a number is no reference`,
    )
  }
})

Deno.test('the RPC host schema takes no identity_ref: the reference is for validator hosts only', () => {
  const parsed = MainnetRpcConfigSchema.safeParse({
    ...rpcHost,
    identity_ref: REF,
  })
  assert(parsed.success)
  assertEquals('identity_ref' in parsed.data, false)
})

Deno.test('both validator deploys register the BLS key through the step that skips a host without its key file, and nothing copies the key to the node', async () => {
  for (
    const [path, network] of [
      ['src/validator/deploy/deployValidatorMainnet.ts', 'mainnet'],
      ['src/validator/deploy/deployValidatorTestnet.ts', 'testnet'],
    ] as const
  ) {
    const source = await read(path)
    assert(
      source.includes(`await registerBlsAfterDeploy('${network}', limit)`),
      `${path} does not run the step`,
    )
    assertEquals(source.includes('registerBlsPubkey'), false, path)
  }
  await assertRejects(
    () =>
      Deno.stat(
        new URL('../../src/validator/init/copyKeys.ts', import.meta.url),
      ),
    Deno.errors.NotFound,
  )
})
