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
use crate::ws::billing::BillingClient;
use crate::ws::slot_source::SlotPubsubMultiplex;
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
    pub ws: WsConfig,
    /// Optional `slotSubscribe` upstream singletons, owned per-
    /// process so multiple WS clients share one set of outbound
    /// connections.  Cascade priority (highest first) is enforced
    /// in `ws::receive_loop`.
    pub slot_first_shred_multi: Option<Arc<SlotPubsubMultiplex>>,
    pub slot_first_shred: Option<Arc<SlotPubsubMultiplex>>,
    pub slot_multiplex: Option<Arc<SlotPubsubMultiplex>>,
    /// Yellowstone-gRPC endpoint used by the extended
    /// `transactionSubscribe` WS method.  Stored as a plain string
    /// (host:port or full URL) — the bridge does scheme coercion.
    pub yellowstone_endpoint: String,
    /// Optional WS-duration billing emitter.  When configured (=
    /// `RPC_METRICS_API_URL` env set), posts a connection log to
    /// `{base}/ws-connection-log` on WS close so the central
    /// metering path stays consistent with what the Pingora LB used
    /// to push.  When `None`, WS close is a no-op for billing —
    /// useful for dev / non-production gateways.
    pub billing: Option<Arc<BillingClient>>,
    gtfa: GtfaHandlers,
    transfers: TransfersHandlers,
}

#[derive(Default)]
pub struct GatewayBuilder {
    pub full_concurrency: usize,
    pub ws: Option<WsConfig>,
    pub slot_first_shred_multiplex_urls: Vec<String>,
    pub slot_first_shred_url: Option<String>,
    pub slot_multiplex_urls: Vec<String>,
    /// jito-shredstream-proxy `ShredstreamProxy.SubscribeEntries`
    /// endpoint (`http://host:port`).  When set, it joins the
    /// `slot_first_shred_multiplex` dedup window as an additional
    /// input — see [`crate::ws::slot_source`].  Has no effect when
    /// `slot_first_shred_multiplex_urls` is empty AND this is
    /// `None`; when only this is set, the multiplex runs with the
    /// gRPC source alone.
    pub slot_grpc_url: Option<String>,
    pub yellowstone_endpoint: String,
    /// Operator-supplied WS-duration billing config.  When all
    /// three are non-empty, an [`crate::ws::billing::BillingClient`]
    /// is constructed and used by the WS handler on close.
    pub metrics_api_url: Option<String>,
    pub metrics_api_bearer: Option<String>,
    pub metrics_upstream_ip: Option<String>,
}

impl Gateway {
    pub fn new(
        ch: ClickHouseClient,
        of1: Of1Client,
        full_concurrency: usize,
        ws: WsConfig,
    ) -> Self {
        Self::with_slot_sources(ch, of1, ws, GatewayBuilder {
            full_concurrency,
            ws: None,
            yellowstone_endpoint: "localhost:10000".into(),
            ..GatewayBuilder::default()
        })
    }

    pub fn with_slot_sources(
        ch: ClickHouseClient,
        of1: Of1Client,
        ws: WsConfig,
        builder: GatewayBuilder,
    ) -> Self {
        let ch = Arc::new(ch);
        let of1 = Arc::new(of1);
        let gtfa = GtfaHandlers::new(ch.clone(), of1.clone(), builder.full_concurrency.max(1));
        let transfers = TransfersHandlers::new(ch.clone());
        let slot_first_shred_multi = (!builder
            .slot_first_shred_multiplex_urls
            .is_empty()
            || builder.slot_grpc_url.is_some())
        .then(|| {
            Arc::new(SlotPubsubMultiplex::first_shred_multiplex(
                builder.slot_first_shred_multiplex_urls,
                builder.slot_grpc_url,
            ))
        });
        let slot_first_shred = builder
            .slot_first_shred_url
            .map(|url| Arc::new(SlotPubsubMultiplex::first_shred(url)));
        let slot_multiplex = (!builder.slot_multiplex_urls.is_empty()).then(
            || Arc::new(SlotPubsubMultiplex::slot_subscribe(builder.slot_multiplex_urls)),
        );
        let billing = match (
            builder.metrics_api_url.as_deref().filter(|s| !s.is_empty()),
            builder.metrics_api_bearer.as_deref().filter(|s| !s.is_empty()),
        ) {
            (Some(url), Some(bearer)) => Some(Arc::new(BillingClient::new(
                url.to_owned(),
                bearer.to_owned(),
                builder.metrics_upstream_ip.unwrap_or_default(),
            ))),
            _ => None,
        };
        Self {
            ch,
            of1,
            ws,
            slot_first_shred_multi,
            slot_first_shred,
            slot_multiplex,
            yellowstone_endpoint: if builder.yellowstone_endpoint.is_empty() {
                "localhost:10000".into()
            } else {
                builder.yellowstone_endpoint
            },
            billing,
            gtfa,
            transfers,
        }
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
