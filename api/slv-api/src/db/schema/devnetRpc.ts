import {
  int,
  mysqlTable as table,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { nodeConfigColumns, timestampColumns } from './columns.ts'

export const DevnetRpc = table(
  'DevnetRpc',
  {
    id: int().autoincrement().primaryKey(),
    ...nodeConfigColumns(),
    rpc_type: varchar({ length: 64 }).notNull(),
    richat_version: varchar({ length: 64 }).notNull(),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('ux_devnet_rpc_name').on(t.name),
    uniqueIndex('ux_devnet_rpc_identity').on(t.identity_account),
  ],
)

export const DevnetRpcInsertSchema = createInsertSchema(DevnetRpc)
export const DevnetRpcSelectSchema = createSelectSchema(DevnetRpc)
export type DevnetRpc = typeof DevnetRpc.$inferSelect
export type DevnetRpcInsert = typeof DevnetRpc.$inferInsert
