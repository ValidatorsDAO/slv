//! JSON-RPC method dispatcher — the spine of the gateway.
//!
//! Scaffold scope: switch shell that recognises the slv-extended
//! method namespaces but returns `METHOD_NOT_FOUND` for everything
//! until handlers land in follow-up PRs.  See the module-level doc
//! in `lib.rs` for the full method roadmap.

use crate::jsonrpc::{error_codes, Id, Request, Response};
use regex::Regex;
use std::sync::LazyLock;

/// Methods in the `jet*` namespace (camelCase, prefix `jet` + uppercase
/// 4th char): `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`,
/// `jetEpochSummary`, `jetProgramStats`.  Catches typos in this
/// namespace early instead of forwarding them to the standard-RPC
/// upstream where they'd surface as a confusing "method not found"
/// from a different service.
static JET_NAMESPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^jet[A-Z]").expect("static regex compiles"));

pub async fn dispatch(req: Request) -> Response {
    let id = Id::or_null(req.id.clone());
    match req.method.as_str() {
        // Analytics namespace (= ClickHouse-backed, handled locally).
        "jetTopPrograms" | "jetSlotStats" | "jetTpsTimeseries"
        | "jetEpochSummary" | "jetProgramStats" => {
            Response::err(id, error_codes::METHOD_NOT_FOUND, format!(
                "{}: handler not yet ported to Rust gateway", req.method,
            ))
        }
        // Address-indexed methods (= ClickHouse-backed, handled locally).
        "getTransactionsForAddress" | "getTransfersByAddress" => {
            Response::err(id, error_codes::METHOD_NOT_FOUND, format!(
                "{}: handler not yet ported to Rust gateway", req.method,
            ))
        }
        _ => {
            // Unknown `jet*` namespace member — short-circuit so it
            // doesn't get forwarded to the standard-RPC upstream.
            if JET_NAMESPACE_RE.is_match(&req.method) {
                return Response::err(id, error_codes::METHOD_NOT_FOUND, format!(
                    "unknown jet* method: {}", req.method,
                ));
            }
            // Everything else → would be forwarded to the standard
            // Solana RPC upstream once the proxy lands; until then
            // return method-not-found to keep behaviour explicit.
            Response::err(id, error_codes::METHOD_NOT_FOUND, format!(
                "{}: upstream proxy not yet ported to Rust gateway", req.method,
            ))
        }
    }
}
