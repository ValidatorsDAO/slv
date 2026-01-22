import {
  int,
  mysqlTable as table,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { nodeConfigColumns, timestampColumns } from './columns.ts'

export const TestnetRpc = table(
  'TestnetRpc',
  {
    id: int().autoincrement().primaryKey(),
    ...nodeConfigColumns(),
    rpc_type: varchar({ length: 64 }).notNull(),
    richat_version: varchar({ length: 64 }).notNull(),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('ux_testnet_rpc_name').on(t.name),
    uniqueIndex('ux_testnet_rpc_identity').on(t.identity_account),
  ],
)

export const TestnetRpcInsertSchema = createInsertSchema(TestnetRpc)
export const TestnetRpcSelectSchema = createSelectSchema(TestnetRpc)
export type TestnetRpc = typeof TestnetRpc.$inferSelect
export type TestnetRpcInsert = typeof TestnetRpc.$inferInsert
