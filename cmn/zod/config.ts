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

export const CmnTestnetValidatorTypeSchema = z.object({
  solana_cli: z.string(),
  version_firedancer: z.string(),
  version_jito: z.string(),
  version_jito_bam: z.string(),
  version_agave: z.string(),
  allowed_ssh_ips: z.array(z.string()),
  allowed_ips: z.array(z.string()),
})

export const CmnMainnetValidatorTypeSchema = CmnTestnetValidatorTypeSchema

export const CmnMainnetRpcTypeSchema = z.object({
  solana_cli: z.string(),
  version_agave: z.string(),
  version_jito: z.string(),
  version_firedancer: z.string(),
  geyser_version: z.string(),
  x_token: z.string(),
  port_rpc: z.number(),
  port_grpc: z.number(),
  allowed_ssh_ips: z.array(z.string()),
  allowed_ips: z.array(z.string()),
})

export const CmnTypeSchema = z.object({
  mainnet_validators: CmnMainnetValidatorTypeSchema,
  testnet_validators: CmnTestnetValidatorTypeSchema,
  mainnet_rpcs: CmnMainnetRpcTypeSchema,
})

export const ValidatorTestnetConfigSchema = z.object({
  name: z.string(),
  ansible_user: z.string(),
  ansible_host: z.string(),
  ansible_ssh_private_key_file: z.string(),
  identity_account: z.string(),
  vote_account: z.string(),
  authority_account: z.string(),
  username: z.string(),
  ip: z.string(),
  validator_type: ValidatorTestnetTypeSchema,
})

export const ValidatorTestnetInventorySchema = z.record(
  z.string(),
  ValidatorTestnetConfigSchema,
)

export const ValidatorMainnetConfigSchema = z.object({
  name: z.string(),
  ansible_host: z.string(),
  ansible_user: z.string(),
  ansible_ssh_private_key_file: z.string(),
  identity_account: z.string(),
  vote_account: z.string(),
  authority_account: z.string(),
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

export const MainnetRpcConfigSchema = z.object({
  ansible_host: z.string(),
  ansible_user: z.string(),
  ansible_ssh_private_key_file: z.string(),
  identity_account: z.string(),
  name: z.string(),
  region: z.string(),
  rpc_type: RpcTypeSchema,
  snapshot_url: z.string(),
  limit_ledger_size: z.number(),
  shredstream_address: z.string(),
})

export const MainnetRPCInventorySchema = z.record(z.string(), MainnetRpcConfigSchema)
