import { int, mysqlTable as table, uniqueIndex } from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { nodeConfigColumns, timestampColumns, validatorColumns } from './columns.ts'

export const TestnetValidator = table(
  'TestnetValidator',
  {
    id: int().autoincrement().primaryKey(),
    ...nodeConfigColumns(),
    ...validatorColumns(),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('ux_testnet_validator_name').on(t.name),
    uniqueIndex('ux_testnet_validator_identity').on(t.identity_account),
  ],
)

export const TestnetValidatorInsertSchema = createInsertSchema(TestnetValidator)
export const TestnetValidatorSelectSchema = createSelectSchema(TestnetValidator)
export type TestnetValidator = typeof TestnetValidator.$inferSelect
export type TestnetValidatorInsert = typeof TestnetValidator.$inferInsert
