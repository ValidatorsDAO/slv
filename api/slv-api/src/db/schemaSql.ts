import { SQL, is } from 'drizzle-orm'
import { CasingCache } from 'drizzle-orm/casing'
import { MySqlDialect, getTableConfig } from 'drizzle-orm/mysql-core'
import type { MySqlTable } from 'drizzle-orm/mysql-core'
import { DevnetRpc } from './schema/devnetRpc.ts'
import { MainnetRpc } from './schema/mainnetRpc.ts'
import { MainnetValidator } from './schema/mainnetValidator.ts'
import { TestnetRpc } from './schema/testnetRpc.ts'
import { TestnetValidator } from './schema/testnetValidator.ts'
import { Version } from './schema/version.ts'

type ColumnInfo = {
  name: string
  notNull: boolean
  hasDefault: boolean
  default?: unknown
  primary: boolean
  isUnique: boolean
  autoIncrement?: boolean
  hasOnUpdateNow?: boolean
  getSQLType?: () => string
}

type IndexConfig = {
  name?: string
  unique?: boolean
  columns: Array<{ name: string }>
}

const dialect = new MySqlDialect()
const casing = new CasingCache()

const toSqlString = (value: SQL) => {
  return value.toQuery({
    casing,
    escapeName: dialect.escapeName,
    escapeParam: dialect.escapeParam,
    escapeString: dialect.escapeString,
    inlineParams: true,
  }).sql
}

const escapeName = (name: string) => dialect.escapeName(name)

const normalizeDefault = (column: ColumnInfo): string | null => {
  if (!column.hasDefault) {
    return null
  }
  if (column.default === null) {
    return 'NULL'
  }
  if (typeof column.default === 'number' || typeof column.default === 'boolean') {
    return String(column.default)
  }
  if (typeof column.default === 'string') {
    return dialect.escapeString(column.default)
  }
  if (column.default && is(column.default, SQL)) {
    const raw = toSqlString(column.default)
    if (/now\(\)/i.test(raw)) {
      return 'CURRENT_TIMESTAMP'
    }
    return raw
  }
  if (column.hasOnUpdateNow) {
    return 'CURRENT_TIMESTAMP'
  }
  return null
}

const buildColumnSql = (column: ColumnInfo, includePrimaryKey: boolean) => {
  if (!column.getSQLType) {
    throw new Error(`Column ${column.name} is missing getSQLType()`)
  }
  const parts: string[] = [
    escapeName(column.name),
    column.getSQLType(),
  ]
  if (column.notNull) {
    parts.push('NOT NULL')
  }
  if (column.autoIncrement) {
    parts.push('AUTO_INCREMENT')
  }
  if (includePrimaryKey && column.primary) {
    parts.push('PRIMARY KEY')
  }
  if (column.isUnique) {
    parts.push('UNIQUE')
  }
  const defaultValue = normalizeDefault(column)
  if (defaultValue) {
    parts.push(`DEFAULT ${defaultValue}`)
  }
  if (column.hasOnUpdateNow) {
    parts.push('ON UPDATE CURRENT_TIMESTAMP')
  }
  return parts.join(' ')
}

const buildIndexSql = (index: IndexConfig, tableName: string) => {
  const name = index.name ??
    `${tableName}_${index.columns.map((col) => col.name).join('_')}_idx`
  const columns = index.columns.map((col) => escapeName(col.name)).join(', ')
  const keyword = index.unique ? 'UNIQUE KEY' : 'KEY'
  return `${keyword} ${escapeName(name)} (${columns})`
}

const buildPrimaryKeySql = (columns: Array<{ name: string }>) => {
  const cols = columns.map((col) => escapeName(col.name)).join(', ')
  return `PRIMARY KEY (${cols})`
}

const buildTableSql = (table: MySqlTable) => {
  const config = getTableConfig(table)
  const hasPrimaryKeyConfig = config.primaryKeys.length > 0
  const columnLines = config.columns.map((column) =>
    `  ${buildColumnSql(column as ColumnInfo, !hasPrimaryKeyConfig)}`
  )
  const indexLines = config.indexes.map((index) =>
    `  ${buildIndexSql(index.config as IndexConfig, config.name)}`
  )
  const uniqueLines = config.uniqueConstraints.map((unique) => {
    const columns = unique.columns.map((col) => escapeName(col.name)).join(', ')
    const nameFromConstraint = unique.getName?.() ?? unique.name
    const name = nameFromConstraint ??
      `${config.name}_${unique.columns.map((col) => col.name).join('_')}_unique`
    return `  UNIQUE KEY ${escapeName(name)} (${columns})`
  })
  const primaryLines = hasPrimaryKeyConfig
    ? config.primaryKeys.map((pk) =>
      `  ${buildPrimaryKeySql(pk.columns)}`
    )
    : []
  const lines = [
    ...columnLines,
    ...primaryLines,
    ...indexLines,
    ...uniqueLines,
  ]
  return `CREATE TABLE IF NOT EXISTS ${escapeName(config.name)} (\n${
    lines.join(',\n')
  }\n);`
}

const schemaTables = [
  DevnetRpc,
  MainnetRpc,
  TestnetRpc,
  MainnetValidator,
  TestnetValidator,
  Version,
]

export const schemaSql = schemaTables.map(buildTableSql).join('\n\n')
