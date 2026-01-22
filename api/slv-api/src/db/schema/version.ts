import {
  int,
  json,
  mysqlTable as table,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { timestampColumns } from './columns.ts'

export const Version = table(
  'Version',
  {
    id: int().autoincrement().primaryKey(),
    inventory_type: varchar({ length: 32 }).notNull(),
    version_agave: varchar({ length: 64 }).notNull(),
    version_firedancer: varchar({ length: 64 }).notNull(),
    version_jito: varchar({ length: 64 }).notNull(),
    version_jito_bam: varchar({ length: 64 }),
    geyser_version: varchar({ length: 64 }),
    richat_version: varchar({ length: 64 }),
    allowed_ssh_ips: json().notNull(),
    allowed_ips: json().notNull(),
    ...timestampColumns(),
  },
  (t) => [
    uniqueIndex('ux_version_inventory_type').on(t.inventory_type),
  ],
)

export const VersionInsertSchema = createInsertSchema(Version)
export const VersionSelectSchema = createSelectSchema(Version)
export type Version = typeof Version.$inferSelect
export type VersionInsert = typeof Version.$inferInsert
