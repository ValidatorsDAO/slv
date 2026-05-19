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
use serde_json::{json, Value};

use crate::clickhouse::ClickHouseClient;
use crate::handlers::{gtfa::GtfaHandlers, jet, transfers::TransfersHandlers};
use crate::jsonrpc::{error_codes, Id, Request, Response};
use crate::of1::Of1Client;
use crate::ws::billing::BillingClient;
use crate::ws::slot_source::SlotPubsubMultiplex;
use crate::ws::WsConfig;

/// Result of inspecting the `commitment` param on a `getSlot`-like
/// JSON-RPC request.  Only the "processed-or-unset" variant is
/// safe to answer from the UDP-derived slot cache; everything else
/// (`confirmed`, `finalized`, or anything the gateway doesn't
/// recognise) falls through to the upstream so we never serve a
/// commitment-stronger answer than we can actually guarantee.
#[derive(Debug, PartialEq, Eq)]
enum CommitmentParam {
    ProcessedOrUnset,
    Other,
}

/// Solana RPC accepts `commitment` either as the only positional
/// arg (`[{"commitment": "…"}]`) or, less commonly, as a top-level
/// `params` object.  We accept both forms and treat anything else
/// (= malformed shape, unknown value) as `Other` so we err on the
/// side of forwarding upstream.
fn slot_commitment(params: &Option<Value>) -> CommitmentParam {
    let Some(params) = params.as_ref() else {
        return CommitmentParam::ProcessedOrUnset;
    };
    let obj = match params {
        Value::Array(arr) => arr.first().and_then(Value::as_object),
        Value::Object(o) => Some(o),
        _ => None,
    };
    let Some(obj) = obj else {
        // `[]` or unrecognised shape — treat as unset.
        return CommitmentParam::ProcessedOrUnset;
    };
    match obj.get("commitment").and_then(Value::as_str) {
        None | Some("processed") => CommitmentParam::ProcessedOrUnset,
        Some(_) => CommitmentParam::Other,
    }
}

/// Methods in the `jet*` namespace (camelCase, prefix `jet` + uppercase
/// 4th char): `jetTopPrograms`, `jetSlotStats`, `jetTpsTimeseries`,
/// `jetEpochSummary`, `jetProgramStats`.  Catches typos in this
/// namespace early instead of forwarding them to the standard-RPC
/// upstream where they'd surface as a confusing "method not found"
/// from a different service.
static JET_NAMESPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^jet[A-Z]").expect("static regex compiles"));

/// Methods served by a historical-archive backend (e.g.
/// `yellowstone-faithful`) — they read CAR files of past epochs and
/// answer transaction / block lookups out of those archives.  Live-
/// state methods (`getSlot`, `getBalance`, `sendTransaction`, …) must
/// NOT route here because the archive only updates when the next CAR
/// file is imported — answers would be days behind the live chain.
///
/// Match is case-sensitive and exact.  Aliases the protocol no longer
/// advertises (`getConfirmedTransaction` etc.) are included so any
/// client still using them stays archive-backed.
const HISTORICAL_METHODS: &[&str] = &[
    "getTransaction",
    "getBlock",
    "getBlocks",
    "getBlocksWithLimit",
    "getBlockTime",
    "getBlockCommitment",
    "getBlockProduction",
    "getSignaturesForAddress",
    // Pre-rename aliases for the same archive-backed lookups.
    "getConfirmedBlock",
    "getConfirmedBlocks",
    "getConfirmedBlocksWithLimit",
    "getConfirmedTransaction",
    "getConfirmedSignaturesForAddress2",
];

fn is_historical_method(method: &str) -> bool {
    HISTORICAL_METHODS.contains(&method)
}

pub struct Gateway {
    pub ch: Arc<ClickHouseClient>,
    /// Historical-archive RPC backend (e.g. yellowstone-faithful).
    /// Serves transaction / block lookups out of imported CAR files.
    pub of1: Arc<Of1Client>,
    /// Optional live-state RPC backend (= an agave-validator JSON-RPC
    /// port or any live full-history RPC).  When set, every method
    /// NOT in [`HISTORICAL_METHODS`] is routed here instead of
    /// `of1` so callers get current chain state.  When `None`, all
    /// methods continue to forward to `of1` (= prior behaviour, kept
    /// for backward compat with deployments that only have an
    /// archive backend).
    pub live_rpc: Option<Arc<Of1Client>>,
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
    /// Optional UDP bind address (`host:port`) for raw shred
    /// reception — gateway reads slot directly from the shred
    /// header, skipping the gRPC proxy's decode + serialize.  Joins
    /// the `slot_first_shred_multiplex` dedup window.  Requires the
    /// upstream sender to include this address in its
    /// `--dest-ip-ports` list, and a strict nftables allowlist on
    /// the bind port (no signature verification is done in-process).
    pub slot_udp_bind: Option<String>,
    /// Optional live-state RPC URL.  When set, the gateway routes
    /// every non-historical method (see [`HISTORICAL_METHODS`]) here
    /// instead of to `of1`.  See `Gateway::live_rpc` for the rationale.
    pub live_rpc_url: Option<String>,
    /// Per-call timeout for the live RPC client (= different default
    /// from `of1_timeout` because `getTransaction` reads from CAR
    /// archive which can be slow; live RPC calls should be fast).
    pub live_rpc_timeout: Option<std::time::Duration>,
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
            || builder.slot_grpc_url.is_some()
            || builder.slot_udp_bind.is_some())
        .then(|| {
            Arc::new(SlotPubsubMultiplex::first_shred_multiplex(
                builder.slot_first_shred_multiplex_urls,
                builder.slot_grpc_url,
                builder.slot_udp_bind,
            ))
        });
        let slot_first_shred = builder
            .slot_first_shred_url
            .map(|url| Arc::new(SlotPubsubMultiplex::first_shred(url)));
        let slot_multiplex = (!builder.slot_multiplex_urls.is_empty()).then(
            || Arc::new(SlotPubsubMultiplex::slot_subscribe(builder.slot_multiplex_urls)),
        );
        // Construct an optional live-RPC client when the operator
        // wired one up.  Uses a separate `Of1Client` instance so the
        // historical and live backends can have independent timeouts
        // and connection pools without competing for the same
        // reqwest::Client's connection slots.
        let live_rpc = builder
            .live_rpc_url
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|url| {
                Arc::new(
                    Of1Client::new(crate::of1::Of1Config {
                        url: url.to_owned(),
                        timeout: builder
                            .live_rpc_timeout
                            .unwrap_or(std::time::Duration::from_secs(10)),
                    })
                    .expect("live_rpc client builds with operator-supplied URL"),
                )
            });
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
        // Eagerly warm the primary slot multiplex so the
        // HTTP-RPC `getSlot` cache works the moment the gateway
        // is up — without this, `getSlot` would only have a cached
        // value after the first WS client subscribed.
        if let Some(m) = slot_first_shred_multi.as_ref() {
            m.ensure_running();
        }
        Self {
            ch,
            of1,
            live_rpc,
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
            // Fast-path `getSlot` for the default `processed`
            // commitment: read the latest slot from the in-process
            // UDP-derived cache (sub-µs) instead of round-tripping
            // to the upstream RPC node.  `confirmed` / `finalized`
            // still fall through to the upstream because the cache
            // only tracks shred-arrival ("processed-or-newer")
            // timing, not validator consensus state.
            "getSlot" => {
                if matches!(slot_commitment(&req.params), CommitmentParam::ProcessedOrUnset) {
                    if let Some(multi) = self.slot_first_shred_multi.as_ref() {
                        if let Some(slot) = multi.latest_slot() {
                            return Response::ok(id, json!(slot));
                        }
                    }
                }
                self.forward_to_upstream(&req, id).await
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

    /// Forward a request envelope to the appropriate upstream RPC
    /// node and return its response.  Routing:
    ///
    ///   - methods in [`HISTORICAL_METHODS`] → always `self.of1`
    ///     (= the historical archive, e.g. yellowstone-faithful).
    ///   - everything else → `self.live_rpc` when configured (= an
    ///     agave-validator live RPC port), falling back to `self.of1`
    ///     when no live backend is wired up.
    ///
    /// The upstream is itself JSON-RPC 2.0 so its body should already
    /// carry `jsonrpc`/`id` and either `result` or `error`; we
    /// deserialise it directly into `Response`.  Anything malformed
    /// gets wrapped as `UPSTREAM_ERROR` so the client never sees a
    /// half-parsed envelope.
    async fn forward_to_upstream(&self, req: &Request, id: Id) -> Response {
        let envelope = match build_upstream_envelope(req) {
            Ok(v) => v,
            Err(msg) => {
                return Response::err(id, error_codes::INTERNAL_ERROR, msg);
            }
        };
        let backend: &Arc<Of1Client> = if is_historical_method(&req.method) {
            &self.of1
        } else {
            self.live_rpc.as_ref().unwrap_or(&self.of1)
        };
        match backend.forward(&envelope).await {
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

#[cfg(test)]
mod commitment_tests {
    use super::*;

    fn p(v: Value) -> Option<Value> {
        Some(v)
    }

    #[test]
    fn unset_params_means_processed_or_unset() {
        assert_eq!(slot_commitment(&None), CommitmentParam::ProcessedOrUnset);
        assert_eq!(slot_commitment(&p(json!([]))), CommitmentParam::ProcessedOrUnset);
    }

    #[test]
    fn processed_explicit_means_processed_or_unset() {
        assert_eq!(
            slot_commitment(&p(json!([{"commitment": "processed"}]))),
            CommitmentParam::ProcessedOrUnset,
        );
    }

    #[test]
    fn confirmed_and_finalized_fall_through() {
        for c in ["confirmed", "finalized", "single", "max"] {
            assert_eq!(
                slot_commitment(&p(json!([{"commitment": c}]))),
                CommitmentParam::Other,
                "commitment={c} should fall through to upstream",
            );
        }
    }

    #[test]
    fn object_form_also_parsed() {
        // Some SDKs send `{"commitment": …}` as the top-level
        // params object instead of wrapping in an array.
        assert_eq!(
            slot_commitment(&p(json!({"commitment": "processed"}))),
            CommitmentParam::ProcessedOrUnset,
        );
        assert_eq!(
            slot_commitment(&p(json!({"commitment": "confirmed"}))),
            CommitmentParam::Other,
        );
    }

    #[test]
    fn historical_method_classification() {
        // Historical archive lookups.
        for m in [
            "getTransaction",
            "getBlock",
            "getBlocks",
            "getBlocksWithLimit",
            "getBlockTime",
            "getBlockCommitment",
            "getBlockProduction",
            "getSignaturesForAddress",
            "getConfirmedBlock",
            "getConfirmedTransaction",
            "getConfirmedSignaturesForAddress2",
        ] {
            assert!(
                is_historical_method(m),
                "{m} must be classified as historical (= archive-backed)",
            );
        }
        // Live-state methods.
        for m in [
            "getSlot",
            "getBlockHeight",
            "getLatestBlockhash",
            "getEpochInfo",
            "getBalance",
            "getAccountInfo",
            "sendTransaction",
            "simulateTransaction",
            "getRecentPrioritizationFees",
            "getVoteAccounts",
            "getHealth",
        ] {
            assert!(
                !is_historical_method(m),
                "{m} must NOT be classified as historical (= needs live state)",
            );
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
