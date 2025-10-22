export type KeyDirType = 'rpc' | 'validator' | 'relayer' | 'shreadstream'

export type NetworkType = 'mainnet' | 'devnet' | 'testnet'
export type RpcType = 'Geyser gRPC' | 'Index RPC' | 'SendTx RPC' | 'Index RPC + gRPC'
export type ValidatorTestnetType = 'firedancer' | 'agave'
export type ValidatorMainnetType = 'jito' | 'firedancer'
export type InventoryType =
  'testnet_validators' |
  'mainnet_validators' |
  'mainnet_rpcs' |
  'devnet_rpcs' |
  'testnet_rpcs'

export type SolanaNodeType = 'agave' | 'jito' | 'firedancer-agave' | 'firedancer-jito'

export interface ValidatorTestnetConfig {
  ansible_user: string
  ansible_host: string
  ansible_ssh_private_key_file: string
  name: string
  identity_account: string
  vote_account: string
  authority_account: string
  validator_type: SolanaNodeType
}

export type InventoryTestnetValidatorType = {
  testnet_validators: TestnetData
}

export interface TestnetData {
  hosts: Record<string, ValidatorTestnetConfig>
}

export interface MainnetData {
  hosts: Record<string, ValidatorMainnetConfig>
}

export interface RpcData {
  hosts: Record<string, RpcConfig>
}

export type Inventory = Record<'testnet_validators', TestnetData>
export type InventoryMainnet = Record<'mainnet_validators', MainnetData>
export type InventoryRPC = Record<'mainnet_rpcs', RpcData>
export type InventoryDevnetRPC = Record<'devnet_rpcs', RpcData>
export type InventoryTestnetRPC = Record<'testnet_rpcs', RpcData>

export interface CmnType {
  mainnet_validators: CmnMainnetValidatorType
  testnet_validators: CmnTestnetValidatorType
  mainnet_rpcs: CmnMainnetRpcType
  devnet_rpcs: CmnMainnetRpcType
  testnet_rpcs: CmnMainnetRpcType
}

export interface CmnTestnetValidatorType {
  version_firedancer: string
  version_jito: string
  version_agave: string
  allowed_ssh_ips: string[]
  allowed_ips: string[]
}

export interface CmnMainnetValidatorType {
  version_agave: string
  version_firedancer: string
  version_jito: string
  allowed_ssh_ips: string[]
  allowed_ips: string[]
}

export interface CmnMainnetRpcType {
  version_agave: string
  version_jito: string
  version_firedancer: string
  geyser_version: string
  allowed_ssh_ips: string[]
  allowed_ips: string[]
}

export interface RpcConfig {
  ansible_host: string
  ansible_user: string
  ansible_ssh_private_key_file: string
  identity_account: string
  name: string
  region: string
  rpc_type: RpcType
  validator_type: SolanaNodeType
  limit_ledger_size: number
  shred_receiver_address: string
}

export interface ValidatorMainnetConfig {
  name: string
  ansible_host: string
  ansible_user: string
  ansible_ssh_private_key_file: string
  identity_account: string
  vote_account: string
  authority_account: string
  validator_type: SolanaNodeType
  commission_bps: number
  relayer_url: string
  block_engine_url: string
  shred_receiver_address: string
  port_rpc: number
  dynamic_port_range: string
  limit_ledger_size: number
  staked_rpc_identity_account: string
  staked_rpc_amount: number
}