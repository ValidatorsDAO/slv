import {
  int,
  mysqlTable as table,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import {
  nodeConfigColumns,
  timestampColumns,
  validatorColumns,
} from './columns.ts'

export const MainnetValidator = table(
  'MainnetValidator',
  {
    id: int().autoincrement().primaryKey(),
    ...nodeConfigColumns(),
    ...validatorColumns(),
    staked_rpc_identity_account: varchar({ length: 64 }).notNull(),
    staked_rpc_amount: int().notNull(),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('ux_mainnet_validator_name').on(t.name),
    uniqueIndex('ux_mainnet_validator_identity').on(t.identity_account),
  ],
)

export const MainnetValidatorInsertSchema = createInsertSchema(MainnetValidator)
export const MainnetValidatorSelectSchema = createSelectSchema(MainnetValidator)
export type MainnetValidator = typeof MainnetValidator.$inferSelect
export type MainnetValidatorInsert = typeof MainnetValidator.$inferInsert
