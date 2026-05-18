//! WebSocket entry point for the gateway.  Phase 4a — minimal viable
//! WebSocket surface so clients that hard-code `wss://<gateway>/`
//! get the standard Solana pubsub methods working.
//!
//! Routed methods (Phase 4a):
//!
//!   - standard Solana JSON-RPC pubsub methods (`accountSubscribe`,
//!     `logsSubscribe`, `programSubscribe`, `signatureSubscribe`,
//!     `slotSubscribe`, `slotsUpdatesSubscribe`, `blockSubscribe`,
//!     `voteSubscribe`, `rootSubscribe`, etc.) — forwarded verbatim
//!     to an upstream Solana-pubsub-compatible WebSocket
//!
//!   - `transactionSubscribe` / `transactionUnsubscribe`
//!     (extended-API) — return `METHOD_NOT_FOUND` until Phase 4c
//!     ports the gRPC bridge
//!
//!   - multi-source `slotSubscribe` (= the latency-tuned variant
//!     from `api/rpc-gateway`) — also Phase 4b
//!
//! Per-connection state stays small: one upstream WebSocket is
//! lazily opened on the first standard-pubsub method and shared by
//! every subscription that client makes; closing the inbound
//! WebSocket tears everything down.

pub mod pubsub_forward;

#[cfg(test)]
mod ws_test;

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures::stream::{SplitSink, SplitStream, StreamExt};
use futures::SinkExt;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::dispatch::Gateway;
use crate::jsonrpc::{error_codes, Id, Request, Response};
use crate::ws::pubsub_forward::PubsubForward;

/// Methods Solana clients call against the validator's native
/// pubsub endpoint.  Forwarded verbatim to the upstream WebSocket
/// configured by `PUBSUB_WS_URL`.  Order matches the Deno gateway
/// for grep-ability.
const STANDARD_PUBSUB_METHODS: &[&str] = &[
    "accountSubscribe",
    "accountUnsubscribe",
    "logsSubscribe",
    "logsUnsubscribe",
    "programSubscribe",
    "programUnsubscribe",
    "signatureSubscribe",
    "signatureUnsubscribe",
    "slotSubscribe",
    "slotUnsubscribe",
    "slotsUpdatesSubscribe",
    "slotsUpdatesUnsubscribe",
    "blockSubscribe",
    "blockUnsubscribe",
    "voteSubscribe",
    "voteUnsubscribe",
    "rootSubscribe",
    "rootUnsubscribe",
];

#[derive(Clone)]
pub struct WsConfig {
    /// `ws://…` upstream Solana pubsub endpoint (typically richat
    /// on the same host).  Used as the destination for every
    /// standard pubsub method until Phase 4b adds the multi-source
    /// slot fast-path.
    pub pubsub_url: String,
}

/// Axum handler for `GET /ws` (and the `/` alias when a real
/// WebSocket upgrade is requested).  Hands the upgraded socket off
/// to `handle_socket` which owns the per-connection state.
pub async fn ws_route(
    ws: WebSocketUpgrade,
    State(gateway): State<Arc<Gateway>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, gateway))
}

async fn handle_socket(socket: WebSocket, gateway: Arc<Gateway>) {
    let (sink, stream) = socket.split();
    // mpsc gives both the inbound-message loop and the upstream
    // forwarder a way to enqueue outgoing frames without contending
    // for the sink directly.
    let (tx, rx) = mpsc::unbounded_channel::<Message>();
    let sender_task = tokio::spawn(client_sender(sink, rx));
    receive_loop(stream, tx, gateway).await;
    sender_task.abort();
}

async fn client_sender(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: mpsc::UnboundedReceiver<Message>,
) {
    while let Some(msg) = rx.recv().await {
        if sink.send(msg).await.is_err() {
            return;
        }
    }
}

async fn receive_loop(
    mut stream: SplitStream<WebSocket>,
    tx: mpsc::UnboundedSender<Message>,
    gateway: Arc<Gateway>,
) {
    let mut pubsub: Option<PubsubForward> = None;
    while let Some(msg) = stream.next().await {
        let Ok(msg) = msg else { break };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => match std::str::from_utf8(&b) {
                Ok(s) => s.to_owned(),
                Err(_) => continue,
            },
            Message::Ping(p) => {
                let _ = tx.send(Message::Pong(p));
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) => break,
        };
        handle_text(&text, &tx, &mut pubsub, &gateway).await;
    }
}

async fn handle_text(
    text: &str,
    tx: &mpsc::UnboundedSender<Message>,
    pubsub: &mut Option<PubsubForward>,
    gateway: &Arc<Gateway>,
) {
    let body: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            send_response(
                tx,
                Response::err(Id::Null, error_codes::PARSE_ERROR, "invalid JSON"),
            );
            return;
        }
    };
    let Some(req) = Request::validate(body) else {
        send_response(
            tx,
            Response::err(
                Id::Null,
                error_codes::INVALID_REQUEST,
                "invalid JSON-RPC request",
            ),
        );
        return;
    };
    let id = Id::or_null(req.id.clone());

    match req.method.as_str() {
        // Phase 4c will land the gRPC bridge that backs this; for now
        // tell the client it's unsupported so they can fall back.
        "transactionSubscribe" | "transactionUnsubscribe" => {
            send_response(
                tx,
                Response::err(
                    id,
                    error_codes::METHOD_NOT_FOUND,
                    format!("{}: handler not yet ported to Rust gateway", req.method),
                ),
            );
        }
        other if STANDARD_PUBSUB_METHODS.contains(&other) => {
            let forward = ensure_pubsub(pubsub, gateway, tx.clone());
            forward.send(text.to_owned());
        }
        _ => {
            send_response(
                tx,
                Response::err(
                    id,
                    error_codes::METHOD_NOT_FOUND,
                    format!("unsupported WS method: {}", req.method),
                ),
            );
        }
    }
}

fn ensure_pubsub<'a>(
    slot: &'a mut Option<PubsubForward>,
    gateway: &Arc<Gateway>,
    tx: mpsc::UnboundedSender<Message>,
) -> &'a PubsubForward {
    if slot.is_none() {
        *slot = Some(PubsubForward::new(gateway.ws.pubsub_url.clone(), tx));
    }
    slot.as_ref().expect("populated above")
}

fn send_response(tx: &mpsc::UnboundedSender<Message>, resp: Response) {
    let raw = match serde_json::to_string(&resp) {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = tx.send(Message::Text(raw.into()));
}
