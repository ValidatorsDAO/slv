# slv-rpc-gateway (Rust)

JSON-RPC 2.0 + WebSocket gateway in Rust.  Lives in the same Cargo
workspace as the jetstreamer plugins (`slv_gtfa_plugin`,
`slv_transfers_plugin`) so the schemas they emit and the handlers
that read them ship as one binary set.

## Method surface

| Group | Methods | Backing |
|---|---|---|
| HTTP — analytics | `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`, `jetEpochSummary`, `jetProgramStats` | ClickHouse: `program_invocations`, `jetstreamer_slot_status` |
| HTTP — address index | `getTransactionsForAddress` | ClickHouse: `gtfa_tx_mentions` (= `slv_gtfa_plugin`) |
| HTTP — address index | `getTransfersByAddress` | ClickHouse: `token_transfers`, `token_transfers_by_to` (= `slv_transfers_plugin`) |
| HTTP — pass-through | every other Solana JSON-RPC method | upstream RPC node (of1) |
| WS — extended | `transactionSubscribe` / `transactionUnsubscribe` | Yellowstone gRPC |
| WS — slot fast path | `slotSubscribe` with multi-source fan-in | env-var cascade (see `src/main.rs` doc) |
| WS — standard pubsub | `account/logs/program/signature/slotsUpdates/block/vote/root Subscribe` | upstream pubsub WS |

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
  -d '{"jsonrpc":"2.0","id":1,"method":"jetTopPrograms","params":{"limit":5}}'
```

## Why Rust

- per-message overhead in the microseconds range on the WebSocket
  fast paths (no V8 GC pause contributing to tail latency)
- a tight Cargo workspace with the jetstreamer plugins — a schema
  change touches one workspace and one `cargo build`
- shared `clickhouse-rs` Row derive types between the plugins that
  *write* the rows and the handlers that *read* them
- predictable resource use for long-lived WebSocket connections

## License

Apache-2.0.  See workspace `Cargo.toml`.
