import { int, timestamp, varchar } from 'drizzle-orm/mysql-core'

export const nodeConfigColumns = () => ({
  ansible_user: varchar({ length: 64 }).notNull(),
  ansible_host: varchar({ length: 255 }).notNull(),
  ansible_ssh_private_key_file: varchar({ length: 512 }).notNull(),
  name: varchar({ length: 191 }).notNull(),
  identity_account: varchar({ length: 64 }).notNull(),
  region: varchar({ length: 64 }).notNull(),
  port_rpc: int().notNull(),
  dynamic_port_range: varchar({ length: 32 }).notNull(),
  validator_type: varchar({ length: 32 }).notNull(),
  limit_ledger_size: int().notNull().default(2000000),
  shred_receiver_address: varchar({ length: 64 }).notNull(),
})

export const validatorColumns = () => ({
  vote_account: varchar({ length: 64 }).notNull(),
  authority_account: varchar({ length: 64 }).notNull(),
  commission_bps: int().notNull(),
  relayer_url: varchar({ length: 512 }).notNull(),
  block_engine_url: varchar({ length: 512 }).notNull(),
})

export const timestampColumns = () => ({
  created_at: timestamp().notNull().defaultNow(),
  updated_at: timestamp().notNull().defaultNow().onUpdateNow(),
})
