# slv-rpc-gateway (Rust)

JSON-RPC 2.0 gateway in Rust.  Successor to the Deno gateway at
[`../../api/rpc-gateway`](../../api/rpc-gateway).  Lives in the same
workspace as the jetstreamer plugins (`slv_gtfa_plugin`,
`slv_transfers_plugin`) so the schemas they emit and the handlers
that read them ship as one binary set.

## Phase 0 — scaffold (this directory today)

- `tokio` + `axum` HTTP server
- JSON-RPC 2.0 envelope parsing (`src/jsonrpc.rs`)
- Dispatcher shell (`src/dispatch.rs`) — recognises the slv-extended
  method names and returns `METHOD_NOT_FOUND` for everything
- `/health` endpoint returning `{ok: true}`
- Listens on `PORT` (default 8889 — matches the Deno gateway, so the
  load balancer pool can swap binaries without reconfiguration)
- Structured logging via `tracing-subscriber` with JSON output

## Method roadmap

| Phase | Methods | Backing |
|---|---|---|
| 0 (this PR) | dispatch shell + `/health` | — |
| 1 | `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`, `jetEpochSummary`, `jetProgramStats` | ClickHouse: `program_invocations`, `jetstreamer_slot_status` |
| 2 | `getTransactionsForAddress` | ClickHouse: `gtfa_tx_mentions` (= `slv_gtfa_plugin`) |
| 2 | `getTransfersByAddress` | ClickHouse: `token_transfers`, `token_transfers_by_to` (= `slv_transfers_plugin`) |
| 3 | Pass-through proxy for every other Solana JSON-RPC method | Upstream RPC node |
| 4 | WebSocket: `transactionSubscribe`/`Unsubscribe`, `slotSubscribe` with the multi-source fan-in, all standard pubsub methods | Yellowstone gRPC + Solana pubsub WS |

## Build

```bash
cd slv-plugins
cargo build --release -p slv-rpc-gateway
./target/release/slv-rpc-gateway
```

## Run

```bash
PORT=8889 RUST_LOG=info ./target/release/slv-rpc-gateway
```

```bash
curl -fsS http://127.0.0.1:8889/health
# → {"ok":true}

curl -sS http://127.0.0.1:8889/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"jetTopPrograms"}'
# → {"jsonrpc":"2.0","error":{"code":-32601,"message":"jetTopPrograms: handler not yet ported to Rust gateway"},"id":1}
```

## Why a Rust rewrite

The Deno gateway is the right shape for business logic but adds
~0.1–0.5 ms of per-message overhead on the WebSocket fast paths
where the multiplexed slot stream wins or loses by single-digit
milliseconds.  Porting the gateway to native gives us:

- per-message overhead in the microseconds range (no V8 GC pause
  contributing to tail latency)
- a tighter Cargo workspace with the jetstreamer plugins so a
  schema change touches one workspace and one `cargo build`
- shared `clickhouse-rs` Row derive types between the plugins that
  *write* the rows and the handlers that *read* them
- predictable resource use (no V8 heap growth) for long-lived
  WebSocket connections

The Deno gateway stays in production until each method is ported
and individually cut over via load-balancer routing.

## License

Apache-2.0. See workspace `Cargo.toml`.
