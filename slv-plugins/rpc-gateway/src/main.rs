//! `slv-rpc-gateway` binary entry point.
//!
//! Configured via env:
//!   PORT                  listen port (default 8889)
//!   CLICKHOUSE_URL        ClickHouse HTTP base (default http://localhost:8123)
//!   CLICKHOUSE_DB         database name (default `default`)
//!   CLICKHOUSE_USER       optional Basic-auth username
//!   CLICKHOUSE_PASS       optional Basic-auth password
//!   CLICKHOUSE_TIMEOUT_MS per-query timeout (default 30000)
//!   OF1_URL               upstream JSON-RPC base for the pass-through proxy
//!                         + `full` mode on `getTransactionsForAddress`
//!                         (default http://localhost:8888)
//!   OF1_TIMEOUT_MS        per-call timeout for of1 (default 60000)
//!   GTFA_FULL_CONCURRENCY max parallel of1 `getTransaction` calls when
//!                         `transactionDetails: "full"` is requested
//!                         (default 20)
//!   PUBSUB_WS_URL         upstream Solana pubsub WebSocket for
//!                         standard pubsub methods (default
//!                         `ws://localhost:7111`)
//!   SLOT_FIRST_SHRED_MULTIPLEX_URLS
//!                         comma-separated list of pubsub WebSocket
//!                         URLs.  When non-empty, `slotSubscribe`
//!                         opens `slotsUpdatesSubscribe` against
//!                         each one, dedups `firstShredReceived`
//!                         events by slot number, and re-emits
//!                         them as `slotNotification` to the client.
//!   SLOT_FIRST_SHRED_URL  single URL variant of the above
//!   SLOT_MULTIPLEX_URLS   comma-separated pubsub URLs that dedup
//!                         standard `slotSubscribe` notifications
//!                         from multiple sources (no
//!                         `firstShredReceived` filter)
//!   SLOT_GRPC_URL         jito-shredstream-proxy `SubscribeEntries`
//!                         gRPC endpoint (`http://host:port`).
//!                         When set, joins the
//!                         `SLOT_FIRST_SHRED_MULTIPLEX_URLS` dedup
//!                         window as an additional input — bypasses
//!                         the validator's TVU processing step for
//!                         slots where the proxy reports the entry
//!                         before the validator finishes shred
//!                         verification.
//!   SLOT_PUBSUB_URL       per-client `PubsubForward` URL used for
//!                         `slotSubscribe` only (the validator's
//!                         native pubsub on `rpc-port + 1` is
//!                         empirically ~3 ms faster than richat)
//!   YELLOWSTONE_GRPC      Yellowstone-gRPC endpoint for the
//!                         extended `transactionSubscribe` WS
//!                         method (default `localhost:10000`)
//!   RUST_LOG              tracing-subscriber filter (default `info`)

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use axum::http::HeaderMap;
use slv_rpc_gateway::clickhouse::{ClickHouseClient, ClickHouseConfig};
use slv_rpc_gateway::dispatch::{Gateway, GatewayBuilder};
use slv_rpc_gateway::jsonrpc::{error_codes, Id, Request, Response};
use slv_rpc_gateway::of1::{Of1Client, Of1Config};
use slv_rpc_gateway::ws::{ws_route, WsConfig};
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .json()
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8889);
    let addr: SocketAddr = SocketAddr::from(([0, 0, 0, 0], port));

    let ch_cfg = ClickHouseConfig {
        url: env_or("CLICKHOUSE_URL", "http://localhost:8123"),
        database: Some(env_or("CLICKHOUSE_DB", "default")),
        username: std::env::var("CLICKHOUSE_USER").ok(),
        password: std::env::var("CLICKHOUSE_PASS").ok(),
        timeout: Duration::from_millis(
            std::env::var("CLICKHOUSE_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000),
        ),
    };
    let ch = ClickHouseClient::new(ch_cfg)?;

    let of1_cfg = Of1Config {
        url: env_or("OF1_URL", "http://localhost:8888"),
        timeout: Duration::from_millis(
            std::env::var("OF1_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60_000),
        ),
    };
    let of1 = Of1Client::new(of1_cfg)?;
    let full_concurrency: usize = std::env::var("GTFA_FULL_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);

    let ws_cfg = WsConfig {
        pubsub_url: env_or("PUBSUB_WS_URL", "ws://localhost:7111"),
        slot_pubsub_url: std::env::var("SLOT_PUBSUB_URL")
            .ok()
            .filter(|s| !s.is_empty()),
    };
    let builder = GatewayBuilder {
        full_concurrency,
        ws: None,
        slot_first_shred_multiplex_urls: comma_list("SLOT_FIRST_SHRED_MULTIPLEX_URLS"),
        slot_first_shred_url: std::env::var("SLOT_FIRST_SHRED_URL")
            .ok()
            .filter(|s| !s.is_empty()),
        slot_multiplex_urls: comma_list("SLOT_MULTIPLEX_URLS"),
        slot_grpc_url: std::env::var("SLOT_GRPC_URL").ok().filter(|s| !s.is_empty()),
        yellowstone_endpoint: env_or("YELLOWSTONE_GRPC", "localhost:10000"),
    };
    let gateway = Arc::new(Gateway::with_slot_sources(ch, of1, ws_cfg, builder));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_route))
        // Many SDKs hard-code `wss://<host>/` (no path) for pubsub.
        // Route GET / through the WebSocket upgrade only when the
        // client actually requests one; otherwise the JSON-RPC POST
        // handler takes over via the entry below.
        .route("/", get(root_get).post(rpc_entry))
        .with_state(gateway)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(addr = %addr, "slv-rpc-gateway listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.into())
}

fn comma_list(key: &str) -> Vec<String> {
    std::env::var(key)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "ok": true })))
}

/// GET / — dispatch to the WebSocket upgrade when a real WS handshake
/// is requested, otherwise 404 so health probes and accidental
/// browser loads aren't surprised by a hijacked GET.
async fn root_get(
    headers: HeaderMap,
    ws: axum::extract::WebSocketUpgrade,
    state: State<Arc<Gateway>>,
) -> axum::response::Response {
    if headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
    {
        return ws_route(ws, state).await.into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn rpc_entry(
    State(gateway): State<Arc<Gateway>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Value::Array(items) = body {
        if items.is_empty() {
            return Json(
                serde_json::to_value(Response::err(
                    Id::Null,
                    error_codes::INVALID_REQUEST,
                    "invalid JSON-RPC request",
                ))
                .expect("error response always serialises"),
            )
            .into_response();
        }
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            if let Some(resp) = handle_one(&gateway, item).await {
                out.push(resp);
            }
        }
        if out.is_empty() {
            return StatusCode::NO_CONTENT.into_response();
        }
        Json(Value::Array(out)).into_response()
    } else if let Some(resp) = handle_one(&gateway, body).await {
        Json(resp).into_response()
    } else {
        StatusCode::NO_CONTENT.into_response()
    }
}

async fn handle_one(gateway: &Gateway, raw: Value) -> Option<Value> {
    let Some(req) = Request::validate(raw) else {
        return Some(
            serde_json::to_value(Response::err(
                Id::Null,
                error_codes::INVALID_REQUEST,
                "invalid JSON-RPC request",
            ))
            .expect("error response always serialises"),
        );
    };
    let notification = req.is_notification();
    let resp = gateway.dispatch(req).await;
    if notification {
        None
    } else {
        Some(serde_json::to_value(resp).expect("response always serialises"))
    }
}
