//! WebSocket entry point for the gateway.
//!
//! Routed methods:
//!
//!   - standard Solana JSON-RPC pubsub methods (`accountSubscribe`,
//!     `logsSubscribe`, `programSubscribe`, `signatureSubscribe`,
//!     `slotsUpdatesSubscribe`, `blockSubscribe`, `voteSubscribe`,
//!     `rootSubscribe`) — forwarded verbatim to an upstream
//!     Solana-pubsub-compatible WebSocket
//!
//!   - `slotSubscribe` — multi-source latency-tuned fast paths
//!     (see [`slot_source`]); falls back to the standard pubsub
//!     upstream when no fast source is configured
//!
//!   - `transactionSubscribe` / `transactionUnsubscribe` — extended
//!     API backed by Yellowstone gRPC (see [`yellowstone_bridge`])
//!
//! Per-connection state stays small: one upstream WebSocket is
//! lazily opened on the first standard-pubsub method and shared by
//! every subscription that client makes; closing the inbound
//! WebSocket tears everything down.

pub mod billing;
pub mod pubsub_forward;
pub mod slot_source;
pub mod yellowstone_bridge;

#[cfg(test)]
mod ws_test;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures::stream::{SplitSink, SplitStream, StreamExt};
use futures::SinkExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::dispatch::Gateway;
use crate::jsonrpc::{error_codes, Id, Request, Response};
use crate::ws::pubsub_forward::PubsubForward;
use crate::ws::slot_source::SlotPubsubMultiplex;
use crate::ws::yellowstone_bridge::{TxSubscribeFilter, TxSubscribeOpts, YellowstoneBridge};

/// Methods Solana clients call against the validator's native
/// pubsub endpoint.  Forwarded verbatim to the upstream WebSocket
/// configured by `PUBSUB_WS_URL`.
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

/// Local-subscription ID floor.  Subscription IDs we mint for
/// gateway-side multiplex handlers always start at this number so
/// they can never collide with the upstream-pubsub IDs (which are
/// small positive ints assigned by the validator).
pub const LOCAL_SUB_ID_BASE: u64 = 1_000_000_000;

#[derive(Clone)]
pub struct WsConfig {
    /// `ws://…` upstream Solana pubsub endpoint (typically richat
    /// on the same host).  Default destination for every standard
    /// pubsub method; `slotSubscribe` may take a faster path below.
    pub pubsub_url: String,
    /// `ws://…` per-client upstream specifically for `slotSubscribe`.
    /// When set, slot subscriptions use a separate `PubsubForward`
    /// to this endpoint (typically the validator's own pubsub on
    /// `rpc-port + 1`, which is ~3 ms faster than richat).  When
    /// unset, slot subscriptions fall through to `pubsub_url`.
    pub slot_pubsub_url: Option<String>,
}

/// Axum handler for `GET /ws` (and the `/` alias when a real
/// WebSocket upgrade is requested).  Extracts the `api-key` query
/// param so the per-connection close emitter can attribute the
/// billable duration; hands the upgraded socket off to
/// `handle_socket` which owns the per-connection state.
pub async fn ws_route(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(gateway): State<Arc<Gateway>>,
) -> impl IntoResponse {
    let api_key = params.get("api-key").cloned().unwrap_or_default();
    ws.on_upgrade(move |socket| handle_socket(socket, gateway, api_key))
}

async fn handle_socket(socket: WebSocket, gateway: Arc<Gateway>, api_key: String) {
    let connection_id = uuid::Uuid::new_v4().to_string();
    let start_time = SystemTime::now();
    let (sink, stream) = socket.split();
    // mpsc gives both the inbound-message loop and the upstream
    // forwarder a way to enqueue outgoing frames without contending
    // for the sink directly.
    let (tx, rx) = mpsc::unbounded_channel::<Message>();
    let sender_task = tokio::spawn(client_sender(sink, rx));
    receive_loop(stream, tx, gateway.clone()).await;
    sender_task.abort();
    let end_time = SystemTime::now();
    // Emit the WS-duration billing record so the central metering
    // path stays consistent with what the Pingora LB used to push
    // via Redis → consumer_ws.  No-op when no billing client is
    // configured (= dev / non-production gateway) or when api_key
    // is empty (= internal probe).
    if let Some(billing) = gateway.billing.as_ref() {
        billing.emit_close(api_key, connection_id, start_time, end_time);
    }
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
    let mut state = ConnectionState::new(tx);
    while let Some(msg) = stream.next().await {
        let Ok(msg) = msg else { break };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => match std::str::from_utf8(&b) {
                Ok(s) => s.to_owned(),
                Err(_) => continue,
            },
            Message::Ping(p) => {
                let _ = state.tx.send(Message::Pong(p));
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) => break,
        };
        handle_text(&text, &mut state, &gateway).await;
    }
    state.shutdown();
}

/// Per-connection mutable bookkeeping that the receive loop and
/// every spawned helper share.  Owns the outgoing mpsc, the lazily-
/// opened upstream `PubsubForward`s, and the gateway-local
/// subscription map keyed by the locally-assigned sub_id.
struct ConnectionState {
    tx: mpsc::UnboundedSender<Message>,
    pubsub: Option<PubsubForward>,
    /// Optional second `PubsubForward` for `slotSubscribe` when
    /// `WsConfig::slot_pubsub_url` is set.
    slot_pubsub: Option<PubsubForward>,
    /// `JoinHandle`s for tasks we spawned for gateway-local
    /// subscriptions (slot multiplex listeners).  Aborted on
    /// matching `*Unsubscribe` or connection close.
    local_subs: HashMap<u64, JoinHandle<()>>,
    next_local_sub_id: u64,
}

impl ConnectionState {
    fn new(tx: mpsc::UnboundedSender<Message>) -> Self {
        Self {
            tx,
            pubsub: None,
            slot_pubsub: None,
            local_subs: HashMap::new(),
            next_local_sub_id: LOCAL_SUB_ID_BASE,
        }
    }

    fn next_sub_id(&mut self) -> u64 {
        self.next_local_sub_id += 1;
        self.next_local_sub_id
    }

    fn shutdown(&mut self) {
        for (_, handle) in self.local_subs.drain() {
            handle.abort();
        }
    }
}

async fn handle_text(
    text: &str,
    state: &mut ConnectionState,
    gateway: &Arc<Gateway>,
) {
    let body: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            send_response(
                &state.tx,
                Response::err(Id::Null, error_codes::PARSE_ERROR, "invalid JSON"),
            );
            return;
        }
    };
    let Some(req) = Request::validate(body) else {
        send_response(
            &state.tx,
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
        "transactionSubscribe" => handle_transaction_subscribe(req, id, state, gateway),
        "transactionUnsubscribe" => handle_transaction_unsubscribe(req, id, state),
        "slotSubscribe" => handle_slot_subscribe(req, id, text, state, gateway),
        "slotUnsubscribe" => handle_slot_unsubscribe(req, id, text, state, gateway),
        other if STANDARD_PUBSUB_METHODS.contains(&other) => {
            let forward = ensure_pubsub(&mut state.pubsub, gateway, state.tx.clone());
            forward.send(text.to_owned());
        }
        _ => {
            send_response(
                &state.tx,
                Response::err(
                    id,
                    error_codes::METHOD_NOT_FOUND,
                    format!("unsupported WS method: {}", req.method),
                ),
            );
        }
    }
}

/// Priority cascade for `slotSubscribe`:
///
///   slot_first_shred_multi   →   N-URL × firstShredReceived
///     ↓ when None
///   slot_first_shred         →   single URL × firstShredReceived
///     ↓ when None
///   slot_multiplex           →   N-URL × slotSubscribe (dedup)
///     ↓ when None
///   slot_pubsub_url          →   per-client PubsubForward (= different
///                                 URL than `pubsub_url`, e.g. the
///                                 validator's native pubsub)
///     ↓ when None
///   pubsub_url               →   reuse the shared standard pubsub
fn handle_slot_subscribe(
    _req: Request,
    id: Id,
    raw_text: &str,
    state: &mut ConnectionState,
    gateway: &Arc<Gateway>,
) {
    if let Some(multi) = gateway.slot_first_shred_multi.clone() {
        spawn_slot_forwarder(state, id, multi);
        return;
    }
    if let Some(multi) = gateway.slot_first_shred.clone() {
        spawn_slot_forwarder(state, id, multi);
        return;
    }
    if let Some(multi) = gateway.slot_multiplex.clone() {
        spawn_slot_forwarder(state, id, multi);
        return;
    }
    if gateway.ws.slot_pubsub_url.is_some() {
        let forward = ensure_slot_pubsub(state, gateway);
        forward.send(raw_text.to_owned());
        return;
    }
    let forward = ensure_pubsub(&mut state.pubsub, gateway, state.tx.clone());
    forward.send(raw_text.to_owned());
}

fn handle_slot_unsubscribe(
    req: Request,
    id: Id,
    raw_text: &str,
    state: &mut ConnectionState,
    gateway: &Arc<Gateway>,
) {
    // Local subscription? -> abort the forwarder task.
    let params = req.params.as_ref().and_then(|v| v.as_array()).cloned();
    let local_sub_id = params
        .as_ref()
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_u64());
    if let Some(sub_id) = local_sub_id {
        if sub_id >= LOCAL_SUB_ID_BASE {
            if let Some(handle) = state.local_subs.remove(&sub_id) {
                handle.abort();
                send_response(&state.tx, Response::ok(id, Value::Bool(true)));
                return;
            }
            send_response(&state.tx, Response::ok(id, Value::Bool(false)));
            return;
        }
    }
    // Otherwise forward to the same upstream as slotSubscribe took.
    if gateway.ws.slot_pubsub_url.is_some() {
        let forward = ensure_slot_pubsub(state, gateway);
        forward.send(raw_text.to_owned());
        return;
    }
    let forward = ensure_pubsub(&mut state.pubsub, gateway, state.tx.clone());
    forward.send(raw_text.to_owned());
}

fn spawn_slot_forwarder(
    state: &mut ConnectionState,
    id: Id,
    multi: Arc<SlotPubsubMultiplex>,
) {
    let sub_id = state.next_sub_id();
    let mut subscription = multi.subscribe();
    let tx = state.tx.clone();
    let handle = tokio::spawn(async move {
        while let Some(update) = subscription.rx.recv().await {
            let frame = json!({
                "jsonrpc": "2.0",
                "method": "slotNotification",
                "params": {
                    "result": {
                        "slot": update.slot,
                        "parent": update.parent,
                        "root": update.root,
                    },
                    "subscription": sub_id,
                },
            });
            let raw = match serde_json::to_string(&frame) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if tx.send(Message::Text(raw.into())).is_err() {
                break;
            }
        }
    });
    state.local_subs.insert(sub_id, handle);
    send_response(&state.tx, Response::ok(id, Value::from(sub_id)));
}

fn handle_transaction_subscribe(
    req: Request,
    id: Id,
    state: &mut ConnectionState,
    gateway: &Arc<Gateway>,
) {
    let params = req.params.as_ref().and_then(|v| v.as_array()).cloned();
    let filter: TxSubscribeFilter = match params.as_ref().and_then(|p| p.first()) {
        None | Some(Value::Null) => TxSubscribeFilter::default(),
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(f) => f,
            Err(e) => {
                send_response(
                    &state.tx,
                    Response::err(
                        id,
                        error_codes::INVALID_PARAMS,
                        format!("invalid filter: {e}"),
                    ),
                );
                return;
            }
        },
    };
    let opts: TxSubscribeOpts = match params.as_ref().and_then(|p| p.get(1)) {
        None | Some(Value::Null) => TxSubscribeOpts::default(),
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(o) => o,
            Err(e) => {
                send_response(
                    &state.tx,
                    Response::err(
                        id,
                        error_codes::INVALID_PARAMS,
                        format!("invalid opts: {e}"),
                    ),
                );
                return;
            }
        },
    };

    let sub_id = state.next_sub_id();
    let bridge = YellowstoneBridge::new(gateway.yellowstone_endpoint.clone());
    let tx = state.tx.clone();
    let handle = tokio::spawn(async move {
        let send_for_each = move |notification: Value| -> bool {
            let raw = match serde_json::to_string(&notification) {
                Ok(s) => s,
                Err(_) => return true,
            };
            tx.send(Message::Text(raw.into())).is_ok()
        };
        if let Err(e) = bridge.run_subscribe(sub_id, filter, opts, send_for_each).await {
            tracing::warn!(sub_id, error = %e, "transactionSubscribe stream ended");
        }
    });
    state.local_subs.insert(sub_id, handle);
    send_response(&state.tx, Response::ok(id, Value::from(sub_id)));
}

fn handle_transaction_unsubscribe(req: Request, id: Id, state: &mut ConnectionState) {
    let sub_id = req
        .params
        .as_ref()
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_u64());
    if let Some(sub_id) = sub_id {
        if let Some(handle) = state.local_subs.remove(&sub_id) {
            handle.abort();
            send_response(&state.tx, Response::ok(id, Value::Bool(true)));
            return;
        }
    }
    send_response(&state.tx, Response::ok(id, Value::Bool(false)));
}

fn ensure_slot_pubsub<'a>(
    state: &'a mut ConnectionState,
    gateway: &Arc<Gateway>,
) -> &'a PubsubForward {
    if state.slot_pubsub.is_none() {
        let url = gateway
            .ws
            .slot_pubsub_url
            .clone()
            .expect("caller checks slot_pubsub_url is set");
        state.slot_pubsub = Some(PubsubForward::new(url, state.tx.clone()));
    }
    state.slot_pubsub.as_ref().expect("populated above")
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
