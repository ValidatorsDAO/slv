//! `slv-rpc-gateway` — JSON-RPC 2.0 + WebSocket gateway in Rust.
//!
//! Fronts of1 (yellowstone-faithful) for standard Solana JSON-RPC
//! methods and routes the `jet*` analytics family to ClickHouse
//! tables emitted by the jetstreamer plugins in this workspace.  The
//! `/ws` endpoint multiplexes standard pubsub, multi-source
//! `slotSubscribe`, and a Yellowstone-gRPC-backed
//! `transactionSubscribe` over a single connection.
//!
//! ## Method surface
//!
//! | Group | Methods | Backend |
//! |---|---|---|
//! | HTTP — analytics | `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`, `jetEpochSummary`, `jetProgramStats` | ClickHouse |
//! | HTTP — address index | `getTransactionsForAddress`, `getTransfersByAddress` | ClickHouse + of1 fan-out |
//! | HTTP — pass-through | every other Solana JSON-RPC method | of1 |
//! | WS — standard pubsub | `account/logs/program/signature/slotsUpdates/block/vote/root Subscribe` | upstream pubsub WS |
//! | WS — slot fast path | `slotSubscribe` | env-var cascade (`SLOT_FIRST_SHRED_MULTIPLEX_URLS` → … → `PUBSUB_WS_URL`) |
//! | WS — extended | `transactionSubscribe` / `transactionUnsubscribe` | Yellowstone gRPC |
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
