# slv-plugins

Rust workspace for slv-flavoured plugins on top of
[anza-xyz/jetstreamer](https://github.com/anza-xyz/jetstreamer).

Each member crate is a thin extension that emits rows into a
ClickHouse schema served by [`../api/rpc-gateway`](../api/rpc-gateway).
Pair them with the gateway's extended JSON-RPC methods to serve queries
that vanilla Solana RPC can't answer.

## Crates

| Crate | Binary | Backing table | Gateway method |
|---|---|---|---|
| `slv_gtfa_plugin` | `slv-jetstreamer-gtfa` | `gtfa_tx_mentions` | `getTransactionsForAddress` |
| `slv_transfers_plugin` | `slv-jetstreamer-transfers` | `token_transfers`, `token_transfers_by_to` | `getTransfersByAddress` |

Each crate ships two artifacts:

- a **library** (`src/lib.rs`) implementing the
  [`Plugin`](https://docs.rs/jetstreamer-plugin) trait, for embedding
  alongside other plugins in a custom jetstreamer binary;
- a **binary** (`src/main.rs`) that runs the firehose with this
  plugin pre-wired, so it can drop in as the systemd
  `ExecStart` on the slv-jetstreamer host.

## Build

```bash
cd slv-plugins
cargo build --release --bins
```

Output binaries land in `target/release/`:

- `slv-jetstreamer-gtfa`
- `slv-jetstreamer-transfers`

## Schema

Tables created lazily by the plugins themselves on `on_load`.  See
the JSDoc-style headers in each `src/lib.rs` for the exact `CREATE
TABLE` statement, retention policy
(`PARTITION BY intDiv(slot, 432000)` + `TTL ... INTERVAL 61 DAY`),
and rationale.

## Run

```bash
# remote ClickHouse (= production pattern: jetstreamer host shares
# the persistent CH already provisioned for the slv-jetstreamer node)
JETSTREAMER_CLICKHOUSE_MODE=remote \
JETSTREAMER_CLICKHOUSE_DSN=http://localhost:8123 \
JETSTREAMER_THREADS=14 \
  ./target/release/slv-jetstreamer-gtfa <epoch>
```

The plugin creates its target table on first run and starts appending
rows; the gateway picks them up on the next query.

## License

Apache-2.0.  See the workspace `Cargo.toml` and the repository-level
[`LICENSE`](../LICENSE).
