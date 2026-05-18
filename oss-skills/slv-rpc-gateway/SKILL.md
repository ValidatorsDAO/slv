---
name: slv-rpc-gateway
description: A small Deno+Hono JSON-RPC gateway that fronts yellowstone-faithful (of1) and routes `jet_*` analytics methods to ClickHouse (jetstreamer data). Standard Solana RPC methods pass straight through; new analytic methods are answered from precomputed jetstreamer aggregates.
---

# SLV RPC Gateway Skill

A unified JSON-RPC entry point that combines the per-call latency of of1
(yellowstone-faithful) with the bulk-analytics speed of jetstreamer's
ClickHouse tables. Standard methods go to the underlying RPC; new methods
are answered from a custom indexer.

```
client ── POST / ─► rpc-gateway ──► standard RPC (getTransaction, …)  ── of1
                              └──► jet_* (analytics)                  ── ClickHouse
```

## Why

| Layer | Component | Responsibility |
|---|---|---|
| Per-call (read 1 tx) | `yellowstone-faithful` (of1) | `getTransaction`, `getBlock`, `getBlockTime`, `getSignaturesForAddress` |
| Cross-epoch analytics | jetstreamer + ClickHouse | aggregations over millions of txs |
| **Unified surface** | **rpc-gateway (this skill)** | dispatch by method name, return JSON-RPC |

Without the gateway, clients have to know two endpoints and two protocols
(JSON-RPC vs ClickHouse SQL). With it, everything is one JSON-RPC endpoint.

## HTTP JSON-RPC methods

| Method | Backend | Notes |
|---|---|---|
| Standard Solana RPC | of1 | Forwarded transparently |
| `jet_topPrograms` | CH | Top-N programs by invocation count over a time window |
| `jet_programStats` | CH | Time series for a single program (calls, errors, CU) |
| `jet_slotStats` | CH | Per-slot tx counts (single slot or range up to 100k) |
| `jet_tpsTimeseries` | CH | Total + non-vote TPS in time buckets |
| `jet_epochSummary` | CH | Aggregate stats for one epoch |

All `jet_*` methods return JSON arrays of records (`{column: value, …}`)
following the JSON-RPC `result` envelope.

## WebSocket methods (`/ws`)

The gateway also serves an enhanced WebSocket at `/ws`.  Clients connect
once and get both standard Solana pubsub *and* the enhanced
`transactionSubscribe` method through the same socket.

| Method | Backend | Notes |
|---|---|---|
| `transactionSubscribe` / `transactionUnsubscribe` | upstream Yellowstone gRPC | Enhanced filter-based transaction subscription.  Filters: `vote`, `failed`, `signature`, `accountInclude`, `accountExclude`, `accountRequired`.  Options: `commitment`, `encoding`, `transactionDetails`, `showRewards`, `maxSupportedTransactionVersion`. |
| `accountSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `logsSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `programSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `signatureSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `slotSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `slotsUpdatesSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `blockSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `voteSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `rootSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |

Subscription IDs ≥ 1_000_000_000 are local (gateway-served); below that
they belong to the upstream pubsub.  Unsubscribe routes to the right
side based on this range.

### Side-by-side measurement

For a 20-second `transactionSubscribe` with
`accountInclude=[TokenkegQ…]` filter, this gateway → richat:

| Metric | Value |
|---|---:|
| Connect | 68 ms |
| Subscribe ack | 27 ms |
| First notification | 63 ms |
| 20-s notifications | 11,275 |
| Throughput | 564 tx/s |

## Source

`api/rpc-gateway/` in the slv repo:

```
api/rpc-gateway/
├── deno.json
├── README.md
└── src/
    ├── main.ts                # Hono app, env, dispatcher
    ├── jsonrpc.ts             # JSON-RPC 2.0 helpers
    ├── handlers/
    │   ├── proxy.ts           # forward standard methods to of1
    │   └── jet.ts             # jet_* implementations
    └── lib/
        └── clickhouse.ts      # minimal CH HTTP client
```

Single-file deploy: `deno run --allow-net --allow-env src/main.ts`.

## Deployment

`template/<VERSION>/ansible/cmn/install_rpc_gateway.yml` provisions
end-to-end on any node that has of1 + ClickHouse reachable:

1. Installs Deno for the `solv` user.
2. Clones the slv repo (depth=1) and rsyncs `api/rpc-gateway/` to
   `/opt/rpc-gateway/`.
3. Pre-caches deno dependencies.
4. Installs `rpc-gateway.service` systemd unit and enables/starts it.
5. Waits for `/health` to return 200.

Inventory variables: `rpc_gateway_port`, `rpc_gateway_of1_url`,
`rpc_gateway_ch_url`, `rpc_gateway_ch_db`, `rpc_gateway_ch_user`,
`rpc_gateway_ch_pass`, plus for the WebSocket bridge:
`rpc_gateway_yellowstone_grpc` (default `localhost:10000`) and
`rpc_gateway_pubsub_ws` (default `ws://localhost:7111`).

## Topology recommendations

- Co-locate the gateway with each of1 RPC node (cheap, low latency to of1).
- Point `CLICKHOUSE_URL` at the central jetstreamer node, or at a regional
  ClickHouse read replica if cross-region latency matters.
- Public-facing nodes should additionally:
  - Add a read-only ClickHouse user and bind it via `CLICKHOUSE_USER`/`PASS`.
  - Front the gateway with HTTPS termination (Caddy / nginx) and rate-limit
    `jet_*` separately from standard methods (jet_ are heavier).

## Health probes

- `GET /health` — synchronous, doesn't touch upstreams (cheap; OK to poll
  often).
- `GET /ready` — pings of1 + CH; returns 200 only if both up. 503 otherwise.
  Use sparingly.

## Adding a new `jet_*` method

1. Add a handler in `src/handlers/jet.ts`.
2. Add the dispatch arm in `src/main.ts`'s `dispatch()`.
3. Document in `api/rpc-gateway/README.md`.
4. Smoke test: `curl -X POST http://localhost:8889 -d '{"jsonrpc":"2.0",…}'`.

The handler should:
- Validate params with the local helpers in `jet.ts` (`asInt`, `asString`,
  `asBool`, `paramObj`).
- Use `quoteString()` for any literal that ends up in SQL.
- Return `ok(req.id, rows)` or `err(req.id, code, message)`.

