export type KeyDirType = 'rpc' | 'validator' | 'relayer' | 'shreadstream'

export type NetworkType = 'mainnet' | 'devnet' | 'testnet'
export type RpcType = 'Geyser gRPC' | 'Index RPC' | 'SendTx RPC' | 'Index RPC + gRPC'
export type ValidatorTestnetType = 'firedancer' | 'agave'
export type InventoryType =
  'testnet_validators' |
  'mainnet_validators' |
  'mainnet_rpcs' |
  'devnet_rpcs' |
  'testnet_rpcs'

export type SolanaNodeType =
  | 'agave'
  | 'jito'
  | 'jito-bam'
  | 'firedancer-agave'
  | 'firedancer-jito'

export const SolanaNodeTypes = [
  'agave',
  'jito',
  'jito-bam',
  'firedancer-agave',
  'firedancer-jito',
] as const

export interface AnsibleHostConfig {
  ansible_user: string
  ansible_host: string
  ansible_ssh_private_key_file: string
}

export interface NodeConfigBase extends AnsibleHostConfig {
  name: string
  identity_account: string
  region: string
  port_rpc: number
  dynamic_port_range: string
  validator_type: SolanaNodeType
  shred_receiver_address: string
}

export interface ValidatorConfigBase extends NodeConfigBase {
  vote_account: string
  authority_account: string
  commission_bps: number
  relayer_url: string
  block_engine_url: string
  snapshot_url: string
}

export interface ValidatorTestnetConfig extends ValidatorConfigBase {}

export interface HostsData<T> {
  hosts: Record<string, T>
}

export type TestnetData = HostsData<ValidatorTestnetConfig>
export type MainnetData = HostsData<ValidatorMainnetConfig>
export type RpcData = HostsData<RpcConfig>

type InventoryRecord<K extends InventoryType, V> = Record<K, V>

export type InventoryTestnetValidatorType = InventoryRecord<'testnet_validators', TestnetData>
export type Inventory = InventoryRecord<'testnet_validators', TestnetData>
export type InventoryMainnet = InventoryRecord<'mainnet_validators', MainnetData>
export type InventoryRPC = InventoryRecord<'mainnet_rpcs', RpcData>
export type InventoryDevnetRPC = InventoryRecord<'devnet_rpcs', RpcData>
export type InventoryTestnetRPC = InventoryRecord<'testnet_rpcs', RpcData>

export interface CmnType {
  mainnet_validators: CmnMainnetValidatorType
  testnet_validators: CmnTestnetValidatorType
  mainnet_rpcs: CmnMainnetRpcType
  devnet_rpcs: CmnMainnetRpcType
  testnet_rpcs: CmnMainnetRpcType
}

interface CmnAccessList {
  allowed_ssh_ips: string[]
  allowed_ips: string[]
}

interface CmnSolanaVersionBase {
  version_agave: string
  version_firedancer: string
  version_jito: string
}

interface CmnSolanaVersionWithJitoBam extends CmnSolanaVersionBase {
  version_jito_bam: string
}

export interface CmnTestnetValidatorType
  extends CmnSolanaVersionWithJitoBam,
    CmnAccessList {}

export interface CmnMainnetValidatorType
  extends CmnSolanaVersionWithJitoBam,
    CmnAccessList {}

export interface CmnMainnetRpcType extends CmnSolanaVersionBase, CmnAccessList {
  geyser_version: string
  richat_version: string
}

export interface RpcConfig extends NodeConfigBase {
  rpc_type: RpcType
  limit_ledger_size: number
  richat_version: string
  snapshot_url: string
}

export interface ValidatorMainnetConfig extends ValidatorConfigBase {
  limit_ledger_size: number
  staked_rpc_identity_account: string
  staked_rpc_amount: number
}
