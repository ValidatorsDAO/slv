//! `slv-rpc-gateway` binary entry point.
//!
//! Configured via env:
//!   PORT                  listen port (default 8889 — matches the
//!                         Deno gateway so a host can swap binaries
//!                         without changing the load balancer pool)
//!   CLICKHOUSE_URL        ClickHouse HTTP base (default http://localhost:8123)
//!   CLICKHOUSE_DB         database name (default `default`)
//!   CLICKHOUSE_USER       optional Basic-auth username
//!   CLICKHOUSE_PASS       optional Basic-auth password
//!   CLICKHOUSE_TIMEOUT_MS per-query timeout (default 30000)
//!   RUST_LOG              tracing-subscriber filter (default `info`)

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use slv_rpc_gateway::clickhouse::{ClickHouseClient, ClickHouseConfig};
use slv_rpc_gateway::dispatch::Gateway;
use slv_rpc_gateway::jsonrpc::{error_codes, Id, Request, Response};
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
    let gateway = Arc::new(Gateway::new(ch));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/", post(rpc_entry))
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

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "ok": true })))
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
