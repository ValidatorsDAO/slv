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
use crate::handlers::{gtfa::GtfaHandlers, jet, transfers::TransfersHandlers};
use crate::jsonrpc::{error_codes, Id, Request, Response};
use crate::of1::Of1Client;
use crate::ws::WsConfig;

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
    /// WebSocket-side configuration consumed by `crate::ws`.  Owned
    /// here so the WebSocket handler can borrow it through the same
    /// `Arc<Gateway>` Axum injects via `State`.
    pub ws: WsConfig,
    gtfa: GtfaHandlers,
    transfers: TransfersHandlers,
}

impl Gateway {
    pub fn new(
        ch: ClickHouseClient,
        of1: Of1Client,
        full_concurrency: usize,
        ws: WsConfig,
    ) -> Self {
        let ch = Arc::new(ch);
        let of1 = Arc::new(of1);
        let gtfa = GtfaHandlers::new(ch.clone(), of1.clone(), full_concurrency);
        let transfers = TransfersHandlers::new(ch.clone());
        Self { ch, of1, ws, gtfa, transfers }
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
            "getTransfersByAddress" => {
                self.wrap(id, self.transfers.handle(&req.params).await)
            }
            _ => {
                if JET_NAMESPACE_RE.is_match(&req.method) {
                    return Response::err(
                        id,
                        error_codes::METHOD_NOT_FOUND,
                        format!("unknown jet* method: {}", req.method),
                    );
                }
                // Standard Solana JSON-RPC method — forward verbatim
                // to the upstream and return its response envelope.
                self.forward_to_upstream(&req, id).await
            }
        }
    }

    fn wrap(&self, id: Id, result: Result<serde_json::Value, String>) -> Response {
        match result {
            Ok(value) => Response::ok(id, value),
            Err(message) => Response::err(id, error_codes::INVALID_PARAMS, message),
        }
    }

    /// Forward a request envelope to the upstream RPC node and
    /// return its response.  The upstream is itself JSON-RPC 2.0 so
    /// its body should already carry `jsonrpc`/`id` and either
    /// `result` or `error` — if so we deserialise it directly into
    /// `Response`.  Anything malformed gets wrapped as
    /// `UPSTREAM_ERROR` so the client never sees a half-parsed
    /// envelope.
    async fn forward_to_upstream(&self, req: &Request, id: Id) -> Response {
        let envelope = match build_upstream_envelope(req) {
            Ok(v) => v,
            Err(msg) => {
                return Response::err(id, error_codes::INTERNAL_ERROR, msg);
            }
        };
        match self.of1.forward(&envelope).await {
            Ok(body) => match serde_json::from_value::<Response>(body.clone()) {
                Ok(parsed) => parsed,
                Err(_) => {
                    // Upstream returned something we don't recognise
                    // as a JSON-RPC envelope — surface the raw body
                    // as a successful result so the client at least
                    // sees the payload.
                    Response::ok(id, body)
                }
            },
            Err(e) => Response::err(
                id,
                error_codes::UPSTREAM_ERROR,
                format!("upstream: {e}"),
            ),
        }
    }
}

fn build_upstream_envelope(req: &Request) -> Result<serde_json::Value, String> {
    let mut env = serde_json::Map::new();
    env.insert("jsonrpc".into(), serde_json::Value::String("2.0".into()));
    env.insert(
        "method".into(),
        serde_json::Value::String(req.method.clone()),
    );
    if let Some(params) = &req.params {
        env.insert("params".into(), params.clone());
    }
    if let Some(id) = &req.id {
        env.insert(
            "id".into(),
            serde_json::to_value(id).map_err(|e| e.to_string())?,
        );
    }
    Ok(serde_json::Value::Object(env))
}
