import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { DevnetRpc } from './schema/devnetRpc.ts'
import { MainnetRpc } from './schema/mainnetRpc.ts'
import { MainnetValidator } from './schema/mainnetValidator.ts'
import { TestnetRpc } from './schema/testnetRpc.ts'
import { TestnetValidator } from './schema/testnetValidator.ts'
import { Version } from './schema/version.ts'
import { LOCAL_DB_URL } from '@cmn/constants/config.ts'

const dbUrl = LOCAL_DB_URL
if (!dbUrl) {
  console.error(
    'Database URL is not set. Please check your environment variables.',
  )
  Deno.exit(1)
}

export const schema = {
  DevnetRpc,
  MainnetRpc,
  MainnetValidator,
  TestnetRpc,
  TestnetValidator,
  Version,
}

export const connection = await mysql.createConnection({
  uri: dbUrl,
})

export const db = drizzle(connection, {
  casing: 'camelCase',
  schema,
  mode: 'default',
})
