import { defineConfig } from 'drizzle-kit'
import { LOCAL_DB_URL } from '@cmn/constants/config.ts'

const host = LOCAL_DB_URL?.split('@')[1].split(':')[0] || 'localhost'
const user = LOCAL_DB_URL?.split('//')[1].split(':')[0] || 'root'
const password = LOCAL_DB_URL?.split(':')[2].split('@')[0] || ''
const port = parseInt(LOCAL_DB_URL?.split(':')[2].split('/')[0] || '4000', 10)
const DB_NAME = LOCAL_DB_URL?.split('/')[3] || 'slv_db'
export default defineConfig({
  out: './src/db/migrations',
  schema: './src/db/schema/*',
  dialect: 'mysql',
  dbCredentials: {
    host,
    port,
    user,
    password,
    database: DB_NAME,
  },
})
