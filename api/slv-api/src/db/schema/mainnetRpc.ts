import {
  int,
  mysqlTable as table,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { nodeConfigColumns, timestampColumns } from './columns.ts'

export const MainnetRpc = table(
  'MainnetRpc',
  {
    id: int().autoincrement().primaryKey(),
    ...nodeConfigColumns(),
    rpc_type: varchar({ length: 64 }).notNull(),
    richat_version: varchar({ length: 64 }).notNull(),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('ux_mainnet_rpc_name').on(t.name),
    uniqueIndex('ux_mainnet_rpc_identity').on(t.identity_account),
  ],
)

export const MainnetRpcInsertSchema = createInsertSchema(MainnetRpc)
export const MainnetRpcSelectSchema = createSelectSchema(MainnetRpc)
export type MainnetRpc = typeof MainnetRpc.$inferSelect
export type MainnetRpcInsert = typeof MainnetRpc.$inferInsert
