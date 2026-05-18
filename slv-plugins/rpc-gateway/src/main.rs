//! `slv-rpc-gateway` binary entry point.
//!
//! Scaffold scope: bind an HTTP server, serve `/health`, and accept
//! JSON-RPC 2.0 requests on `/` (single or batch).  The dispatcher
//! returns `METHOD_NOT_FOUND` for every method until handlers land
//! in follow-up PRs — see `lib.rs` for the per-phase roadmap.
//!
//! Configured via env:
//!   PORT                  listen port (default 8889 — matches the
//!                         Deno gateway so a host can swap binaries
//!                         without changing the load balancer pool)
//!   RUST_LOG              tracing-subscriber filter (default `info`)

use std::net::SocketAddr;

use axum::extract::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use slv_rpc_gateway::dispatch::dispatch;
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

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/", post(rpc_entry))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(addr = %addr, "slv-rpc-gateway listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "ok": true })))
}

/// JSON-RPC entry point.  Accepts a single request or a batch.
///
/// - A request without `id` is a notification — process but do not
///   respond.  A batch consisting only of notifications returns no
///   body (HTTP 204).
/// - An empty batch (`[]`) is answered with a single
///   `INVALID_REQUEST` error per spec.
async fn rpc_entry(Json(body): Json<Value>) -> impl IntoResponse {
    if let Value::Array(items) = body {
        if items.is_empty() {
            return Json(serde_json::to_value(Response::err(
                Id::Null,
                error_codes::INVALID_REQUEST,
                "invalid JSON-RPC request",
            )).expect("error response always serialises")).into_response();
        }
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            if let Some(resp) = handle_one(item).await {
                out.push(resp);
            }
        }
        if out.is_empty() {
            return StatusCode::NO_CONTENT.into_response();
        }
        Json(Value::Array(out)).into_response()
    } else {
        if let Some(resp) = handle_one(body).await {
            Json(resp).into_response()
        } else {
            StatusCode::NO_CONTENT.into_response()
        }
    }
}

async fn handle_one(raw: Value) -> Option<Value> {
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
    let resp = dispatch(req).await;
    if notification {
        None
    } else {
        Some(serde_json::to_value(resp).expect("response always serialises"))
    }
}
