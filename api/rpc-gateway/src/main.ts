// SLV RPC Gateway — JSON-RPC 2.0 server that fronts of1 (yellowstone-faithful)
// and routes `jet_*` analytics methods to ClickHouse (jetstreamer data).
//
// Standard Solana RPC methods (getTransaction, getBlock, …) are forwarded
// untouched to OF1_URL. Methods starting with `jet_` are answered locally
// from ClickHouse via CLICKHOUSE_URL.
//
// Configured via env:
//   PORT              listen port (default 8889 — leaves 8888 for of1)
//   OF1_URL           upstream JSON-RPC base (default http://localhost:8888)
//   CLICKHOUSE_URL    ClickHouse HTTP base (default http://localhost:8123)
//   CLICKHOUSE_DB     database name (default default)
//   CLICKHOUSE_USER   optional Basic auth username
//   CLICKHOUSE_PASS   optional Basic auth password
//   CLICKHOUSE_TIMEOUT_MS  per-query timeout (default 30000)
//   OF1_TIMEOUT_MS         per-proxy-call timeout (default 60000)

import { Hono } from '@hono/hono'
import { ClickHouseClient } from './lib/clickhouse.ts'
import { JetHandlers } from './handlers/jet.ts'
import { StandardProxy } from './handlers/proxy.ts'
import {
  err,
  ERROR_CODES,
  isNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  validate,
} from './jsonrpc.ts'

const PORT = parseInt(Deno.env.get('PORT') ?? '8889', 10)
const OF1_URL = Deno.env.get('OF1_URL') ?? 'http://localhost:8888'
const CLICKHOUSE_URL = Deno.env.get('CLICKHOUSE_URL') ?? 'http://localhost:8123'
const CLICKHOUSE_DB = Deno.env.get('CLICKHOUSE_DB') ?? 'default'
const CLICKHOUSE_USER = Deno.env.get('CLICKHOUSE_USER') ?? undefined
const CLICKHOUSE_PASS = Deno.env.get('CLICKHOUSE_PASS') ?? undefined
const CLICKHOUSE_TIMEOUT_MS = parseInt(Deno.env.get('CLICKHOUSE_TIMEOUT_MS') ?? '30000', 10)
const OF1_TIMEOUT_MS = parseInt(Deno.env.get('OF1_TIMEOUT_MS') ?? '60000', 10)

const ch = new ClickHouseClient({
  url: CLICKHOUSE_URL,
  database: CLICKHOUSE_DB,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASS,
  timeoutMs: CLICKHOUSE_TIMEOUT_MS,
})
const jet = new JetHandlers(ch)
const proxy = new StandardProxy({ upstream: OF1_URL, timeoutMs: OF1_TIMEOUT_MS })

const log = (msg: string, extra?: Record<string, unknown>) => {
  const payload = { ts: new Date().toISOString(), msg, ...extra }
  console.log(JSON.stringify(payload))
}

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  // Whitelist of jet_* methods — any other jet_* is method-not-found.
  switch (req.method) {
    case 'jet_topPrograms':    return jet.topPrograms(req)
    case 'jet_slotStats':      return jet.slotStats(req)
    case 'jet_tpsTimeseries':  return jet.tpsTimeseries(req)
    case 'jet_epochSummary':   return jet.epochSummary(req)
    case 'jet_programStats':   return jet.programStats(req)
  }
  if (req.method.startsWith('jet_')) {
    return err(req.id ?? null, ERROR_CODES.METHOD_NOT_FOUND, `unknown jet_ method: ${req.method}`)
  }
  // Anything else → forward to of1.
  return proxy.handle(req)
}

const app = new Hono()

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
  c.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  return await next()
})

// Health probe — does NOT touch upstreams (kept cheap).
app.get('/health', (c) => c.json({ ok: true }))

// Deeper readiness — pings of1 + CH.  Use sparingly.
app.get('/ready', async (c) => {
  const checks = await Promise.allSettled([
    fetch(OF1_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }),
    }).then((r) => r.ok),
    ch.queryOne('SELECT 1 AS ok').then(() => true),
  ])
  const of1Ok = checks[0].status === 'fulfilled' && checks[0].value === true
  const chOk = checks[1].status === 'fulfilled' && checks[1].value === true
  const status = of1Ok && chOk ? 200 : 503
  return c.json({ of1: of1Ok, clickhouse: chOk }, status)
})

// JSON-RPC entry point.  Accepts a single request or a batch.
//
// Conformance notes:
// - A request whose JSON object has no `id` field is a *notification*; the
//   server MUST process it but MUST NOT respond.
// - An empty batch (`[]`) MUST be answered with a single Invalid Request
//   error, not an empty array.
// - For a batch of all-notifications, the server returns no body.
app.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(err(null, ERROR_CODES.PARSE_ERROR, 'invalid JSON'), 400)
  }

  // Returns null when the request was a notification (no response).
  const handle = async (raw: unknown): Promise<JsonRpcResponse | null> => {
    const req = validate(raw)
    if (!req) {
      // For an invalid request that *might* have been a notification we
      // still respond with INVALID_REQUEST per spec — `id` of an invalid
      // request is unknown, so we use null.
      return err(null, ERROR_CODES.INVALID_REQUEST, 'invalid JSON-RPC request')
    }
    const notification = isNotification(req)
    try {
      const resp = await dispatch(req)
      return notification ? null : resp
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('dispatch_error', { method: req.method, error: msg })
      if (notification) return null
      return err(req.id ?? null, ERROR_CODES.INTERNAL_ERROR, msg)
    }
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return c.json(err(null, ERROR_CODES.INVALID_REQUEST, 'empty batch'), 200)
    }
    const responses = (await Promise.all(body.map(handle))).filter(
      (r): r is JsonRpcResponse => r !== null,
    )
    if (responses.length === 0) return c.body(null, 204)
    return c.json(responses)
  }
  const out = await handle(body)
  if (out === null) return c.body(null, 204)
  return c.json(out)
})

log('starting', { port: PORT, of1: OF1_URL, clickhouse: CLICKHOUSE_URL })
Deno.serve({ port: PORT }, app.fetch)
