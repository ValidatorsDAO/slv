---
name: slv-rpc-gateway
description: A small Rust JSON-RPC + WebSocket gateway that fronts yellowstone-faithful (of1) and routes `jet*` analytics methods to ClickHouse (jetstreamer data). Standard Solana RPC methods pass straight through; new analytic methods are answered from precomputed jetstreamer aggregates.
---

# SLV RPC Gateway Skill

A unified JSON-RPC + WebSocket entry point that combines the per-call latency
of of1 (yellowstone-faithful) with the bulk-analytics speed of jetstreamer's
ClickHouse tables. Standard methods go to the underlying RPC; new methods are
answered from a custom indexer.

```
client ── POST / ─► rpc-gateway ──► standard RPC (getTransaction, …)  ── of1
                              └──► jet* (analytics)                  ── ClickHouse
                              └──► getTransactionsForAddress         ── ClickHouse + of1
                              └──► getTransfersByAddress             ── ClickHouse

client ── /ws  ──► rpc-gateway ──► transactionSubscribe              ── Yellowstone gRPC
                              └──► slotSubscribe (multi-source)      ── multiplexed pubsub
                              └──► standard pubsub                   ── upstream pubsub WS
```

## Why

| Layer | Component | Responsibility |
|---|---|---|
| Per-call (read 1 tx) | `yellowstone-faithful` (of1) | `getTransaction`, `getBlock`, `getBlockTime`, `getSignaturesForAddress` |
| Cross-epoch analytics | jetstreamer + ClickHouse | aggregations over millions of txs |
| Per-address index | `slv_gtfa_plugin` + `slv_transfers_plugin` | per-address tx / transfer lookups |
| **Unified surface** | **rpc-gateway (this skill)** | dispatch by method name, return JSON-RPC |

Without the gateway, clients have to know two endpoints and two protocols
(JSON-RPC vs ClickHouse SQL). With it, everything is one JSON-RPC endpoint.

## HTTP JSON-RPC methods

| Method | Backend | Notes |
|---|---|---|
| Standard Solana RPC | of1 | Forwarded transparently |
| `jetTopPrograms` | CH | Top-N programs by invocation count over a time window |
| `jetProgramStats` | CH | Time series for a single program (calls, errors, CU) |
| `jetSlotStats` | CH | Per-slot tx counts (single slot or range up to 100k) |
| `jetTpsTimeseries` | CH | Total + non-vote TPS in time buckets |
| `jetEpochSummary` | CH | Aggregate stats for one epoch |
| `getTransactionsForAddress` | CH (gtfa_tx_mentions) + of1 fan-out for `full` mode | Per-address transaction index, `signatures` or `full` mode |
| `getTransfersByAddress` | CH (token_transfers + by_to MV) | Per-address SPL token transfer index, direction-aware |

All `jet*` methods return JSON arrays of records (`{column: value, …}`)
following the JSON-RPC `result` envelope.

## WebSocket methods (`/ws`)

The gateway also serves an enhanced WebSocket at `/ws` (and at `/` when the
client sends an `Upgrade: websocket` header).  Clients connect once and get
both standard Solana pubsub and the enhanced `transactionSubscribe` method
through the same socket.

| Method | Backend | Notes |
|---|---|---|
| `transactionSubscribe` / `transactionUnsubscribe` | upstream Yellowstone gRPC | Filter-based transaction subscription.  Filters: `vote`, `failed`, `signature`, `accountInclude`, `accountExclude`, `accountRequired`.  Options: `commitment`, `encoding`, `transactionDetails`, `showRewards`, `maxSupportedTransactionVersion`. |
| `slotSubscribe` / `slotUnsubscribe` | multi-source cascade (see below) | Lowest-latency path picked based on env vars |
| `accountSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `logsSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `programSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `signatureSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `slotsUpdatesSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `blockSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `voteSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |
| `rootSubscribe` / `Unsubscribe` | upstream pubsub WS | Forwarded |

Subscription IDs ≥ 1_000_000_000 are local (gateway-served); below that they
belong to the upstream pubsub.  Unsubscribe routes to the right side based on
this range.

### `slotSubscribe` priority cascade

Picked by env-var presence, highest first:

```
SLOT_FIRST_SHRED_MULTIPLEX_URLS  → N upstreams × slotsUpdatesSubscribe × firstShredReceived filter
  (+ optional SLOT_GRPC_URL       → jito-shredstream-proxy SubscribeEntries, joins the same dedup window
                                    and bypasses the validator's TVU processing step)
  (+ optional SLOT_UDP_BIND       → raw shred UDP listener, reads slot from shred header directly
                                    (skips the gRPC proxy's decode round-trip, ~150-450 µs per slot))
  → SLOT_FIRST_SHRED_URL          → single URL  × firstShredReceived filter
  → SLOT_MULTIPLEX_URLS           → N upstreams × standard slotSubscribe (dedup only)
  → SLOT_PUBSUB_URL               → per-client PubsubForward to a slot-only upstream
  → PUBSUB_WS_URL                 → same upstream as every other standard pubsub
```

The first-shred variants emit `slotNotification` at first-shred-received time
(= before the bank for that slot is frozen), trading consistency for
latency.  Clients that need bank state after the tick should fetch via
`getAccountInfo`.

## Source

`slv-plugins/rpc-gateway/` in the slv repo (= Cargo workspace member,
sibling of the jetstreamer plugins that emit the backing ClickHouse rows):

```
slv-plugins/rpc-gateway/
├── Cargo.toml
├── README.md
└── src/
    ├── main.rs                         # axum bind + env load
    ├── lib.rs                          # roadmap doc
    ├── jsonrpc.rs                      # Request/Response types
    ├── clickhouse.rs                   # HTTP client
    ├── of1.rs                          # upstream JSON-RPC client
    ├── dispatch.rs                     # Gateway struct + method routing
    ├── handlers/
    │   ├── jet.rs                      # jetTopPrograms, jetSlotStats, …
    │   ├── gtfa.rs                     # getTransactionsForAddress
    │   └── transfers.rs                # getTransfersByAddress
    └── ws/
        ├── mod.rs                      # WS entry + slot priority cascade
        ├── pubsub_forward.rs           # per-client upstream WS bridge
        ├── slot_source.rs              # 3 slot multiplex variants
        └── yellowstone_bridge.rs       # transactionSubscribe via gRPC
```

Build: `cargo build --release -p slv-rpc-gateway` (inside `slv-plugins/`).

## Deployment

`template/<VERSION>/ansible/cmn/install_rpc_gateway.yml` provisions
end-to-end on any node that has of1 + ClickHouse reachable:

1. Installs build deps (`clang`, `libclang-dev`, `build-essential`, …) and
   rustup (idempotent for the `solv` user).
2. Clones the slv repo (depth=1) to `/opt/slv-build/slv`.
3. `cargo build --release -p slv-rpc-gateway` and installs the binary to
   `/opt/rpc-gateway-rust/slv-rpc-gateway`.
4. Optionally builds a persistent SSH tunnel for ClickHouse when the CH
   host binds loopback only (`rpc_gateway_ch_tunnel_via` inventory var).
5. Installs `rpc-gateway.service` systemd unit and enables/starts it.
6. Waits for `/health` to return 200.

Inventory variables: `rpc_gateway_port`, `rpc_gateway_of1_url`,
`rpc_gateway_ch_url`, `rpc_gateway_ch_db`, `rpc_gateway_ch_user`,
`rpc_gateway_ch_pass`, `rpc_gateway_yellowstone_grpc` (default
`localhost:10000`), `rpc_gateway_pubsub_ws` (default
`ws://localhost:7111`), and the slot-source env vars listed in the cascade
table above.

### Companion: local shred relay (= jito UDP fast path)

To feed the gateway's `SLOT_UDP_BIND` listener with shreds from a
jito block-engine, a separate `jito-shredstream-proxy` instance
needs to run on the same host:

```
[ jito block-engine ] ──UDP─► [ shredstream-local :<src_port> ]
                                       └─UDP─► [ gateway :<udp_bind_port> ]
```

`template/<VERSION>/ansible/cmn/install_local_shred_relay.yml`
provisions this relay end-to-end:

1. Downloads the upstream jito-shredstream-proxy release binary.
2. Copies the operator-supplied keypair (controller → host, 600
   perms, never logged).
3. Renders `shredstream-local.service` with the chosen src bind
   port and dest (defaults to forwarding `127.0.0.1:20000`, which
   matches the gateway's recommended `SLOT_UDP_BIND=0.0.0.0:20000`).
4. Enables + starts the systemd unit, waits for the jito heartbeat
   handshake, fails the play if the unit is not active.

Operator-side prerequisites (NOT done by the play):
- nftables / firewall must accept inbound UDP on the src bind port
  from jito's known shred-source IPs (currently observed:
  `64.130.40.0/24` — confirm per region).
- The jito tier on the keypair must allow as many concurrent
  region heartbeats as `local_shred_relay_desired_regions` lists.

Required inventory vars:
`local_shred_relay_block_engine_url`,
`local_shred_relay_desired_regions`,
`local_shred_relay_auth_keypair_src` (path on controller).

## Topology recommendations

- Co-locate the gateway with each of1 RPC node (cheap, low latency to of1).
- Point `CLICKHOUSE_URL` at the central jetstreamer node, or at a regional
  ClickHouse read replica if cross-region latency matters.  When CH binds
  loopback only, use the tunnel mode above.
- Public-facing nodes should additionally:
  - Add a read-only ClickHouse user and bind it via `CLICKHOUSE_USER`/`PASS`.
  - Front the gateway with HTTPS termination (Caddy / nginx / pingora) and
    rate-limit `jet*` separately from standard methods (`jet*` are heavier).

## Health probes

- `GET /health` — synchronous, doesn't touch upstreams (cheap; OK to poll
  often).

## Adding a new `jet*` method

1. Add a handler function in `slv-plugins/rpc-gateway/src/handlers/jet.rs`.
2. Add the dispatch arm in `src/dispatch.rs`'s `Gateway::dispatch`.
3. Update the per-phase roadmap table in `src/lib.rs`.
4. Add a unit test in the same file's `#[cfg(test)]` module.
5. Smoke test: `curl -X POST http://localhost:8889 -d '{"jsonrpc":"2.0",…}'`.

The handler should:
- Validate params with the local helpers in `handlers/mod.rs` (`as_int`,
  `as_string`, `as_bool_or`, `as_date_string`, `param_obj`).
- Use `quote_string()` from `clickhouse.rs` for any literal that ends up in
  SQL.
- Return `Result<serde_json::Value, String>`; the dispatcher wraps it into a
  JSON-RPC envelope via `ok` / `err`.
