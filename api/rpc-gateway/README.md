# SLV RPC Gateway

A small Deno+Hono JSON-RPC gateway that fronts `yellowstone-faithful` (of1)
and routes `jet_*` analytics methods to ClickHouse (jetstreamer data).

```
client ── POST / ─► gateway ──► standard RPC (getTransaction, …)  ── of1
                          └──► jet_* (analytics)                  ── ClickHouse
```

Standard Solana JSON-RPC methods are forwarded untouched. Methods starting
with `jet_` are answered locally from ClickHouse using the schema produced
by jetstreamer.

## Run locally

```bash
PORT=8889 \
OF1_URL=http://localhost:8888 \
CLICKHOUSE_URL=http://localhost:8123 \
deno task start
```

## Methods

| Method | Backend | Params | Returns |
|---|---|---|---|
| `getTransaction`, `getBlock`, `getBlockTime`, … | of1 | (standard Solana) | (standard) |
| `jet_topPrograms` | CH | `{since?, until?, includeVotes?, limit?}` | top-N programs by invocations |
| `jet_programStats` | CH | `{programIdBase58, since?, until?, bucketSec?}` | time series for one program |
| `jet_slotStats` | CH | `{slot}` or `{fromSlot, toSlot}` | per-slot tx counts |
| `jet_tpsTimeseries` | CH | `{from, to, bucketSec?}` | TPS time series |
| `jet_epochSummary` | CH | `{epoch}` | epoch-wide aggregates |

`since` / `until` / `from` / `to` accept anything `toDateTime()` parses
(e.g. `'2026-05-09 00:00:00'` or unix timestamps).

## Examples

```bash
# Standard RPC (forwarded to of1)
curl -sX POST http://localhost:8889/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}'

# Top 10 non-vote programs
curl -sX POST http://localhost:8889/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"jet_topPrograms",
       "params":{"includeVotes":false,"limit":10}}'

# Epoch summary
curl -sX POST http://localhost:8889/ -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"jet_epochSummary","params":{"epoch":967}}'

# Batch
curl -sX POST http://localhost:8889/ -H 'Content-Type: application/json' \
  -d '[
    {"jsonrpc":"2.0","id":1,"method":"getVersion"},
    {"jsonrpc":"2.0","id":2,"method":"jet_topPrograms","params":{"limit":3}}
  ]'
```

## Health probes

- `GET /health` — cheap, doesn't touch upstreams
- `GET /ready` — pings of1 + ClickHouse, returns 200 only if both up

## Env

| Var | Default |
|---|---|
| `PORT` | `8889` |
| `OF1_URL` | `http://localhost:8888` |
| `CLICKHOUSE_URL` | `http://localhost:8123` |
| `CLICKHOUSE_DB` | `default` |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASS` | (none) |
| `CLICKHOUSE_TIMEOUT_MS` | `30000` |
| `OF1_TIMEOUT_MS` | `60000` |
