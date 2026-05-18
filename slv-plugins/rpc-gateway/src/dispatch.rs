//! JSON-RPC method dispatcher.
//!
//! Owns one shared `ClickHouseClient` and routes incoming methods
//! to the right handler module.  Methods that are not yet ported
//! return `METHOD_NOT_FOUND` with an explicit "handler not yet
//! ported" message so production callers see the same wire shape
//! they will eventually see for missing methods after the full
//! migration.

use std::sync::Arc;

use regex::Regex;
use std::sync::LazyLock;

use crate::clickhouse::ClickHouseClient;
use crate::handlers::jet;
use crate::jsonrpc::{error_codes, Id, Request, Response};

/// Methods in the `jet*` namespace (camelCase, prefix `jet` + uppercase
/// 4th char): `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`,
/// `jetEpochSummary`, `jetProgramStats`.  Catches typos in this
/// namespace early instead of forwarding them to the standard-RPC
/// upstream where they'd surface as a confusing "method not found"
/// from a different service.
static JET_NAMESPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^jet[A-Z]").expect("static regex compiles"));

#[derive(Clone)]
pub struct Gateway {
    pub ch: Arc<ClickHouseClient>,
}

impl Gateway {
    pub fn new(ch: ClickHouseClient) -> Self {
        Self { ch: Arc::new(ch) }
    }

    pub async fn dispatch(&self, req: Request) -> Response {
        let id = Id::or_null(req.id.clone());
        match req.method.as_str() {
            // Analytics namespace (= ClickHouse-backed, handled locally).
            "jetTopPrograms" => self.wrap(id, jet::top_programs(&self.ch, &req.params).await),
            "jetSlotStats" => self.wrap(id, jet::slot_stats(&self.ch, &req.params).await),
            "jetTpsTimeseries" => {
                self.wrap(id, jet::tps_timeseries(&self.ch, &req.params).await)
            }
            "jetEpochSummary" => {
                self.wrap(id, jet::epoch_summary(&self.ch, &req.params).await)
            }
            "jetProgramStats" => {
                self.wrap(id, jet::program_stats(&self.ch, &req.params).await)
            }
            // Address-indexed methods — ports landing in Phase 2.
            "getTransactionsForAddress" | "getTransfersByAddress" => Response::err(
                id,
                error_codes::METHOD_NOT_FOUND,
                format!("{}: handler not yet ported to Rust gateway", req.method),
            ),
            _ => {
                if JET_NAMESPACE_RE.is_match(&req.method) {
                    return Response::err(
                        id,
                        error_codes::METHOD_NOT_FOUND,
                        format!("unknown jet* method: {}", req.method),
                    );
                }
                // Pass-through proxy lands in Phase 3.
                Response::err(
                    id,
                    error_codes::METHOD_NOT_FOUND,
                    format!("{}: upstream proxy not yet ported to Rust gateway", req.method),
                )
            }
        }
    }

    fn wrap(&self, id: Id, result: Result<serde_json::Value, String>) -> Response {
        match result {
            Ok(value) => Response::ok(id, value),
            Err(message) => Response::err(id, error_codes::INVALID_PARAMS, message),
        }
    }
}
