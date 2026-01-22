import { z, extendZodWithOpenApi } from '@hono/zod-openapi'
import { SolanaNodeTypes } from '@cmn/constants/config.ts'

extendZodWithOpenApi(z)

export const KeyDirTypeSchema = z.enum(['rpc', 'validator', 'relayer', 'shreadstream'])
export const NetworkTypeSchema = z.enum(['mainnet', 'testnet'])
export const RpcTypeSchema = z.enum(['Geyser gRPC', 'Index RPC', 'SendTx RPC'])
export const RpcTypeArray = RpcTypeSchema.options
export const ValidatorTestnetTypeSchema = z.enum(SolanaNodeTypes)
export const ValidatorMainnetTypeSchema = ValidatorTestnetTypeSchema
export const InventoryTypeSchema = z.enum(['testnet_validators', 'mainnet_validators', 'mainnet_rpcs'])

const CmnAccessListSchema = z.object({
  allowed_ssh_ips: z.array(z.string()),
  allowed_ips: z.array(z.string()),
})

const CmnSolanaCliSchema = z.object({
  solana_cli: z.string(),
})

const CmnSolanaVersionBaseSchema = z.object({
  version_agave: z.string(),
  version_jito: z.string(),
  version_firedancer: z.string(),
})

const CmnSolanaVersionWithJitoBamSchema = CmnSolanaVersionBaseSchema.extend({
  version_jito_bam: z.string(),
})

export const CmnTestnetValidatorTypeSchema = CmnSolanaCliSchema
  .merge(CmnSolanaVersionWithJitoBamSchema)
  .merge(CmnAccessListSchema)

export const CmnMainnetValidatorTypeSchema = CmnTestnetValidatorTypeSchema

export const CmnMainnetRpcTypeSchema = CmnSolanaCliSchema
  .merge(CmnSolanaVersionBaseSchema)
  .extend({
    geyser_version: z.string(),
    x_token: z.string(),
    port_rpc: z.number(),
    port_grpc: z.number(),
  })
  .merge(CmnAccessListSchema)

export const CmnTypeSchema = z.object({
  mainnet_validators: CmnMainnetValidatorTypeSchema,
  testnet_validators: CmnTestnetValidatorTypeSchema,
  mainnet_rpcs: CmnMainnetRpcTypeSchema,
})

const AnsibleHostSchema = z.object({
  ansible_host: z.string(),
  ansible_user: z.string(),
  ansible_ssh_private_key_file: z.string(),
})

const HostIdentitySchema = AnsibleHostSchema.extend({
  name: z.string(),
  identity_account: z.string(),
})

const ValidatorAccountSchema = HostIdentitySchema.extend({
  vote_account: z.string(),
  authority_account: z.string(),
})

export const ValidatorTestnetConfigSchema = ValidatorAccountSchema.extend({
  validator_type: ValidatorTestnetTypeSchema,
  username: z.string(),
  ip: z.string(),
})

export const ValidatorTestnetInventorySchema = z.record(
  z.string(),
  ValidatorTestnetConfigSchema,
)

export const ValidatorMainnetConfigSchema = ValidatorAccountSchema.extend({
  validator_type: ValidatorMainnetTypeSchema,
  commission_bps: z.number(),
  relayer_url: z.string(),
  relayer_account: z.string(),
  block_engine_region: z.string(),
  shredstream_address: z.string(),
  port_rpc: z.number(),
  limit_ledger_size: z.number(),
  staked_rpc_identity_account: z.string(),
  staked_rpc_amount: z.number(),
  snapshot_url: z.string(),
})

export const ValidatorMainnetInventorySchema = z.record(
  z.string(),
  ValidatorMainnetConfigSchema,
)

export const MainnetRpcConfigSchema = HostIdentitySchema.extend({
  region: z.string(),
  rpc_type: RpcTypeSchema,
  snapshot_url: z.string(),
  limit_ledger_size: z.number(),
  shredstream_address: z.string(),
})

export const MainnetRPCInventorySchema = z.record(z.string(), MainnetRpcConfigSchema)
