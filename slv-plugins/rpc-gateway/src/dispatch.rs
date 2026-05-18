//! JSON-RPC method dispatcher.
//!
//! Owns one shared `ClickHouseClient`, `Of1Client`, and per-method
//! handler structs (= those that carry caches or other state).
//! Routes incoming methods to the right handler; methods not yet
//! ported return `METHOD_NOT_FOUND` with an explicit "handler not
//! yet ported" message so callers see the same wire shape they
//! will eventually see for missing methods.

use std::sync::Arc;
use std::sync::LazyLock;

use regex::Regex;

use crate::clickhouse::ClickHouseClient;
use crate::handlers::{gtfa::GtfaHandlers, jet};
use crate::jsonrpc::{error_codes, Id, Request, Response};
use crate::of1::Of1Client;

/// Methods in the `jet*` namespace (camelCase, prefix `jet` + uppercase
/// 4th char): `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`,
/// `jetEpochSummary`, `jetProgramStats`.  Catches typos in this
/// namespace early instead of forwarding them to the standard-RPC
/// upstream where they'd surface as a confusing "method not found"
/// from a different service.
static JET_NAMESPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^jet[A-Z]").expect("static regex compiles"));

pub struct Gateway {
    pub ch: Arc<ClickHouseClient>,
    pub of1: Arc<Of1Client>,
    gtfa: GtfaHandlers,
}

impl Gateway {
    pub fn new(ch: ClickHouseClient, of1: Of1Client, full_concurrency: usize) -> Self {
        let ch = Arc::new(ch);
        let of1 = Arc::new(of1);
        let gtfa = GtfaHandlers::new(ch.clone(), of1.clone(), full_concurrency);
        Self { ch, of1, gtfa }
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
            // Address-indexed methods (= ClickHouse-backed, handled locally).
            "getTransactionsForAddress" => {
                self.wrap(id, self.gtfa.handle(&req.params).await)
            }
            "getTransfersByAddress" => Response::err(
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
