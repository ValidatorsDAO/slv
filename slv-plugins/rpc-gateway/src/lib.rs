//! `slv-rpc-gateway` — JSON-RPC 2.0 gateway in Rust.
//!
//! This crate is the Rust successor to the Deno gateway at
//! `api/rpc-gateway/`.  It is delivered in phases so each port can
//! be reviewed in isolation and the Deno version can remain in
//! production until the Rust version reaches feature parity per
//! method.
//!
//! ## Method roadmap
//!
//! | Phase | Methods | Notes |
//! |---|---|---|
//! | 0 (this PR) | dispatch shell + `/health` | All RPC methods return `METHOD_NOT_FOUND` |
//! | 1 | `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`, `jetEpochSummary`, `jetProgramStats` | ClickHouse client + the 5 jet* analytics handlers |
//! | 2 | `getTransactionsForAddress`, `getTransfersByAddress` | Address-indexed methods backed by jetstreamer plugin tables (`gtfa_tx_mentions`, `token_transfers`, `token_transfers_by_to`) |
//! | 3 | Pass-through proxy | Forwards every other Solana JSON-RPC method to the upstream RPC node |
//! | 4 | WebSocket | `transactionSubscribe` / `transactionUnsubscribe` (extended), `slotSubscribe` with the multi-source fan-in fast-path, all standard pubsub methods |
//!
//! ## Co-location with the jetstreamer plugins
//!
//! The gateway lives in the same Cargo workspace as
//! `slv_gtfa_plugin` and `slv_transfers_plugin` so the schemas they
//! emit and the handlers that read them are always built against
//! the same versions of `clickhouse`, `solana-*`, and the row-
//! derive types.  Each layer can be changed without re-pinning the
//! other.

pub mod dispatch;
pub mod jsonrpc;

#[cfg(test)]
mod dispatch_test;
