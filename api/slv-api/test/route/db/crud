import { OpenAPIHono } from '@hono/zod-openapi'
import { assertEquals } from '@std/assert'
import { createCrudRouter } from '@/route/db/crud.ts'
import type { AppContext } from '@/index.ts'
import { int, json, mysqlTable as table, varchar } from 'drizzle-orm/mysql-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

const TestCrud = table('TestCrud', {
  id: int().autoincrement().primaryKey(),
  name: varchar({ length: 64 }).notNull(),
  allowed_ips: json().notNull(),
})

const TestCrudInsertSchema = createInsertSchema(TestCrud)
const TestCrudSelectSchema = createSelectSchema(TestCrud)

const testRouter = createCrudRouter({
  table: TestCrud,
  name: 'TestCrud',
  tags: ['TestCrud'],
  selectSchema: TestCrudSelectSchema,
  insertSchema: TestCrudInsertSchema,
  searchFields: {
    name: 'string',
    allowed_ips: 'json',
  },
})

type Row = {
  id: number
  [key: string]: unknown
}

class MockSelect {
  private rows: Row[]

  constructor(rows: Row[]) {
    this.rows = rows
  }

  from(_table: unknown) {
    return this
  }

  where(_cond: unknown) {
    return this
  }

  orderBy(_cond: unknown) {
    return this
  }

  limit(value: number) {
    return Promise.resolve(this.rows.slice(0, value))
  }
}

class MockUpdate {
  private rows: Row[]
  private payload: Record<string, unknown> = {}

  constructor(rows: Row[]) {
    this.rows = rows
  }

  set(payload: Record<string, unknown>) {
    this.payload = payload
    return this
  }

  where(_cond: unknown) {
    if (this.rows[0]) {
      Object.assign(this.rows[0], this.payload)
    }
    return Promise.resolve({ affectedRows: this.rows.length > 0 ? 1 : 0 })
  }
}

class MockDelete {
  private rows: Row[]
  private deleteCount: number

  constructor(rows: Row[], deleteCount: number) {
    this.rows = rows
    this.deleteCount = deleteCount
  }

  where(_cond: unknown) {
    if (this.deleteCount > 0) {
      this.rows.shift()
    }
    return Promise.resolve({ affectedRows: this.deleteCount })
  }
}

class MockDb {
  private rows: Row[]
  private nextId: number
  private deleteCount: number

  constructor(rows: Row[] = [], deleteCount = 1) {
    this.rows = rows
    this.nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
    this.deleteCount = deleteCount
  }

  insert(_table: unknown) {
    return {
      values: (payload: Record<string, unknown>) => {
        const row = { id: this.nextId++, ...payload }
        this.rows.push(row)
        return Promise.resolve([{ insertId: row.id }])
      },
    }
  }

  select() {
    return new MockSelect(this.rows)
  }

  update(_table: unknown) {
    return new MockUpdate(this.rows)
  }

  delete(_table: unknown) {
    return new MockDelete(this.rows, this.deleteCount)
  }
}

const buildApp = (db: MockDb) => {
  const app = new OpenAPIHono<AppContext>()
  app.use('*', (c, next) => {
    c.set('db', db as unknown as AppContext['Variables']['db'])
    return next()
  })
  app.route('/crud', testRouter)
  return app
}

Deno.test('CRUD create returns inserted row', async () => {
  const db = new MockDb()
  const app = buildApp(db)
  const payload = {
    name: 'node-1',
    allowed_ips: ['127.0.0.1'],
  }
  const res = await app.request('http://localhost/crud/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json() as {
    success: boolean
    data: { id: number; name: string }
  }

  assertEquals(res.status, 200)
  assertEquals(body.success, true)
  assertEquals(body.data.id, 1)
  assertEquals(body.data.name, payload.name)
})

Deno.test('CRUD get returns 404 when missing', async () => {
  const db = new MockDb([])
  const app = buildApp(db)
  const res = await app.request('http://localhost/crud/get/99')
  const body = await res.json() as { success: boolean }

  assertEquals(res.status, 404)
  assertEquals(body.success, false)
})

Deno.test('CRUD search returns cursor pagination', async () => {
  const rows = [
    { id: 1, name: 'node-1', allowed_ips: ['1.1.1.1'] },
    { id: 2, name: 'node-2', allowed_ips: ['1.1.1.2'] },
    { id: 3, name: 'node-3', allowed_ips: ['1.1.1.3'] },
  ]
  const db = new MockDb(rows)
  const app = buildApp(db)
  const res = await app.request('http://localhost/crud/search?limit=2')
  const body = await res.json() as {
    success: boolean
    items: Array<{ id: number }>
    hasMore: boolean
    nextCursor: number | null
  }

  assertEquals(res.status, 200)
  assertEquals(body.success, true)
  assertEquals(body.items.length, 2)
  assertEquals(body.hasMore, true)
  assertEquals(body.nextCursor, 2)
})

Deno.test('CRUD search rejects invalid JSON filters', async () => {
  const db = new MockDb([])
  const app = buildApp(db)
  const res = await app.request(
    'http://localhost/crud/search?allowed_ips={oops',
  )
  const body = await res.json() as { success: boolean }

  assertEquals(res.status, 400)
  assertEquals(body.success, false)
})

Deno.test('CRUD update rejects empty payload', async () => {
  const db = new MockDb([{ id: 1, name: 'node-1', allowed_ips: [] }])
  const app = buildApp(db)
  const res = await app.request('http://localhost/crud/update/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const body = await res.json() as { success: boolean }

  assertEquals(res.status, 400)
  assertEquals(body.success, false)
})

Deno.test('CRUD delete returns 404 when missing', async () => {
  const db = new MockDb([], 0)
  const app = buildApp(db)
  const res = await app.request('http://localhost/crud/delete/1', {
    method: 'DELETE',
  })
  const body = await res.json() as { success: boolean }

  assertEquals(res.status, 404)
  assertEquals(body.success, false)
})
