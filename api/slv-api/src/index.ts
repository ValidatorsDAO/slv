import type { MySql2Database } from 'drizzle-orm/mysql2'
import { OpenAPIHono } from '@hono/zod-openapi'
import { db, type schema } from './db/db.ts'
import { Scalar } from '@scalar/hono-api-reference'
import denoJson from '../deno.json' with { type: 'json' }
import { ansibleRouter } from '@/route/ansible/index.ts'
import { dbRouter } from '@/route/db/index.ts'

export type Env = {
  SLV_ENV: string
}

const port = parseInt(Deno.env.get('PORT') ?? '42000', 10)
const SLV_ENV = Deno.env.get('SLV_ENV') ?? 'development'

// === watchdog用 ===
let lastActivity = Date.now()
const WATCHDOG_MS = 90 * 60 * 1000 // 90分

setInterval(() => {
  if (Date.now() - lastActivity > WATCHDOG_MS) {
    console.error(`[watchdog] no activity > ${WATCHDOG_MS}ms, exiting`)
    Deno.exit(1)
  }
}, 60_000) // 1 min per check

export type CustomContext = {
  db: MySql2Database<typeof schema>
}

export type AppContext = {
  Variables: CustomContext
  Bindings: Env
}

export const app = new OpenAPIHono<AppContext>()

// CORS
app.use('*', (c, next) => {
  lastActivity = Date.now() // 活動時間を更新
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Headers', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  return next()
})

// Return ok for /favicon.ico
app.get('/favicon.ico', (c) => {
  return c.json({ message: 'favicon' })
})

// Auth
app.use('*', async (c, next) => {
  try {
    const reqUrl = c.req.url
    c.set('db', db)
    if (SLV_ENV === 'development') {
      return await next()
    }
    const urlSplit = reqUrl.split('/')
    const urlPath = urlSplit.slice(3).join('/')
    const whiteListPaths = [
      '/llms.txt',
      '/doc',
      '/ui',
      '/ui-v2',
    ]
    if (whiteListPaths.includes('/' + urlPath)) {
      return await next()
    }
    let auth = c.req.header('Authorization')
    auth = auth?.toLocaleLowerCase()
    if (!auth?.startsWith('bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const token = auth.split(' ')[1]
    if (token !== 'solv') {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return await next()
  } catch (error) {
    console.error('Error in middleware:', error)
    c.status(500)
    return c.json({ error: 'Internal Server Error' })
  }
})

app.doc('/doc', {
  openapi: '3.1.0',
  info: {
    version: denoJson.version,
    title: 'SLV API',
    description: 'SLV API',
  },
})

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
})

app.get(
  '/ui-v2',
  Scalar({ url: '/doc', pageTitle: 'SLV API', theme: 'bluePlanet' }),
)

app.route('/ansible', ansibleRouter)
app.route('/db', dbRouter)

app.all('*', (c) => {
  return c.json({ message: 'Not Found' }, { status: 404 })
})

Deno.serve({ port }, app.fetch)
