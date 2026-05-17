// SLV RPC Gateway — JSON-RPC 2.0 server that fronts of1 (yellowstone-faithful)
// and routes `jet*` analytics methods to ClickHouse (jetstreamer data).
// Also exposes a Helius-compatible WebSocket at `/ws` with
// `transactionSubscribe` bridged to an upstream Yellowstone gRPC endpoint
// and standard Solana pubsub forwarded to richat WS.
//
// Standard Solana RPC methods (getTransaction, getBlock, …) are forwarded
// untouched to OF1_URL. Methods starting with `jet` followed by an
// uppercase letter (jetTopPrograms, jetSlotStats, …) are answered locally
// from ClickHouse via CLICKHOUSE_URL.
//
// Configured via env:
//   PORT                  listen port (default 8889 — leaves 8888 for of1)
//   OF1_URL               upstream JSON-RPC base (default http://localhost:8888)
//   CLICKHOUSE_URL        ClickHouse HTTP base (default http://localhost:8123)
//   CLICKHOUSE_DB         database name (default default)
//   CLICKHOUSE_USER       optional Basic auth username
//   CLICKHOUSE_PASS       optional Basic auth password
//   CLICKHOUSE_TIMEOUT_MS per-query timeout (default 30000)
//   OF1_TIMEOUT_MS        per-proxy-call timeout (default 60000)
//   YELLOWSTONE_GRPC      Yellowstone gRPC host:port for transactionSubscribe
//                         (default localhost:10000 — richat daemon's
//                         apps.grpc.server.endpoint)
//   PUBSUB_WS_URL         upstream Solana pubsub WebSocket for standard
//                         methods (default ws://localhost:7111)
//   GTFA_FULL_CONCURRENCY max parallel of1 getTransaction calls when
//                         `transactionDetails: "full"` is requested
//                         (default 20)

import { Hono } from '@hono/hono'
import { ClickHouseClient } from './lib/clickhouse.ts'
import { JetHandlers } from './handlers/jet.ts'
import { GtfaHandlers } from './handlers/gtfa.ts'
import { TransfersHandlers } from './handlers/transfers.ts'
import { StandardProxy } from './handlers/proxy.ts'
import { buildWsHandler } from './handlers/ws.ts'
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
const YELLOWSTONE_GRPC = Deno.env.get('YELLOWSTONE_GRPC') ?? 'localhost:10000'
const PUBSUB_WS_URL = Deno.env.get('PUBSUB_WS_URL') ?? 'ws://localhost:7111'
// Optional override: when set, slotSubscribe notifications come from
// this dedicated Yellowstone-gRPC endpoint (typically a shred-bridge)
// instead of falling through to richat WS / validator geyser.
const SLOT_BRIDGE_GRPC = Deno.env.get('SLOT_BRIDGE_GRPC') || undefined
const GTFA_FULL_CONCURRENCY = parseInt(Deno.env.get('GTFA_FULL_CONCURRENCY') ?? '20', 10)

const ch = new ClickHouseClient({
  url: CLICKHOUSE_URL,
  database: CLICKHOUSE_DB,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASS,
  timeoutMs: CLICKHOUSE_TIMEOUT_MS,
})
const jet = new JetHandlers(ch)
const gtfa = new GtfaHandlers(ch, {
  of1Url: OF1_URL,
  of1TimeoutMs: OF1_TIMEOUT_MS,
  fullConcurrency: GTFA_FULL_CONCURRENCY,
})
const transfers = new TransfersHandlers(ch)
const proxy = new StandardProxy({ upstream: OF1_URL, timeoutMs: OF1_TIMEOUT_MS })

const log = (msg: string, extra?: Record<string, unknown>) => {
  const payload = { ts: new Date().toISOString(), msg, ...extra }
  console.log(JSON.stringify(payload))
}

// Methods in the `jet*` namespace (camelCase, prefix `jet` + uppercase
// 4th char): `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`,
// `jetEpochSummary`, `jetProgramStats`.  Any unknown name in this
// namespace is short-circuited with METHOD_NOT_FOUND below — without
// the catch, an unknown `jetFooBar` would be forwarded to of1 which
// would just confuse the client with an of1 error message.
const JET_NAMESPACE_RE = /^jet[A-Z]/

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  switch (req.method) {
    case 'jetTopPrograms':
      return jet.topPrograms(req)
    case 'jetSlotStats':
      return jet.slotStats(req)
    case 'jetTpsTimeseries':
      return jet.tpsTimeseries(req)
    case 'jetEpochSummary':
      return jet.epochSummary(req)
    case 'jetProgramStats':
      return jet.programStats(req)
    // Helius-wire-compatible address index, backed by jetstreamer's
    // gtfa_tx_mentions table (NOT proxied to of1).
    case 'getTransactionsForAddress':
      return gtfa.getTransactionsForAddress(req)
    // Helius-wire-compatible token-transfer index, backed by jetstreamer's
    // token_transfers + token_transfers_by_to (slv-transfers-plugin).
    case 'getTransfersByAddress':
      return transfers.getTransfersByAddress(req)
  }
  if (JET_NAMESPACE_RE.test(req.method)) {
    return err(
      req.id ?? null,
      ERROR_CODES.METHOD_NOT_FOUND,
      `unknown jet* method: ${req.method}`,
    )
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

// Helius-compat WebSocket (transactionSubscribe + standard pubsub forward).
// Built once and aliased on both `/ws` and `/` so the same YellowstoneBridge
// instance is shared.
const wsHandler = buildWsHandler({
  yellowstoneEndpoint: YELLOWSTONE_GRPC,
  pubsubUrl: PUBSUB_WS_URL,
  slotBridgeEndpoint: SLOT_BRIDGE_GRPC,
})
app.get('/ws', wsHandler)
// Alias for clients that hard-code `wss://<host>/?api-key=…` — historical
// default for richat-pubsub and many existing SDKs.  Only intercept GET /
// when it is a real WebSocket upgrade; otherwise keep prior 404 behaviour
// so health probes / accidental browser loads aren't surprised.
app.get('/', async (c, next) => {
  if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
    return wsHandler(c, next)
  }
  return c.notFound()
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

log('starting', {
  port: PORT,
  of1: OF1_URL,
  clickhouse: CLICKHOUSE_URL,
  yellowstone_grpc: YELLOWSTONE_GRPC,
  pubsub_ws: PUBSUB_WS_URL,
})
Deno.serve({ port: PORT }, app.fetch)
