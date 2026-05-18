//! `slv-rpc-gateway` — JSON-RPC 2.0 gateway in Rust.
//!
//! Successor to the Deno gateway at `api/rpc-gateway/`, delivered
//! method-by-method so each port can be reviewed in isolation and
//! the Deno gateway can stay in production until the Rust gateway
//! reaches parity per method.
//!
//! ## Method roadmap
//!
//! | Phase | Methods | Status |
//! |---|---|---|
//! | 0 | dispatch shell + `/health` | merged |
//! | 1 | `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`, `jetEpochSummary`, `jetProgramStats` | merged |
//! | 2a | `getTransactionsForAddress` | merged |
//! | 2b | `getTransfersByAddress` | merged |
//! | 3 | Pass-through proxy for every other Solana JSON-RPC method | merged |
//! | 4a | WebSocket scaffold + standard pubsub passthrough | merged |
//! | 4b | `slotSubscribe` multi-source fan-in fast paths | this PR |
//! | 4c | `transactionSubscribe` / `transactionUnsubscribe` via Yellowstone gRPC | next |
//!
//! ## Workspace co-location
//!
//! The gateway lives in the same Cargo workspace as
//! `slv_gtfa_plugin` and `slv_transfers_plugin` so the schemas they
//! emit and the handlers that read them are always built against
//! the same versions of `clickhouse`, `solana-*`, and Row-derive
//! types.  Each layer can change without re-pinning the other.

pub mod clickhouse;
pub mod dispatch;
pub mod handlers;
pub mod jsonrpc;
pub mod of1;
pub mod ws;

#[cfg(test)]
mod dispatch_test;
