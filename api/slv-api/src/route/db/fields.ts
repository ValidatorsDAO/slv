import type { SearchFieldType } from '@/route/db/crud.ts'

export const nodeSearchFields: Record<string, SearchFieldType> = {
  ansible_user: 'string',
  ansible_host: 'string',
  ansible_ssh_private_key_file: 'string',
  name: 'string',
  identity_account: 'string',
  region: 'string',
  port_rpc: 'number',
  dynamic_port_range: 'string',
  validator_type: 'string',
  limit_ledger_size: 'number',
  shred_receiver_address: 'string',
}

export const validatorSearchFields: Record<string, SearchFieldType> = {
  vote_account: 'string',
  authority_account: 'string',
  commission_bps: 'number',
  relayer_url: 'string',
  block_engine_url: 'string',
}

export const rpcSearchFields: Record<string, SearchFieldType> = {
  rpc_type: 'string',
  richat_version: 'string',
}
