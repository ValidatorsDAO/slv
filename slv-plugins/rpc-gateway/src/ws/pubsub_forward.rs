//! Per-client WebSocket bridge to an upstream Solana JSON-RPC
//! pubsub endpoint.  One outbound connection per client; lazily
//! opened on the first standard pubsub method the client sends.
//!
//! Inbound (`PubsubForward::send`) → upstream; upstream → inbound
//! mpsc channel that feeds the client sender task.  Buffered until
//! the upstream handshake completes.

use std::sync::Arc;

use axum::extract::ws::Message;
use futures::stream::StreamExt;
use futures::SinkExt;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

pub struct PubsubForward {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
}

enum State {
    Connecting { buffered: Vec<String> },
    Open { tx: mpsc::UnboundedSender<String> },
    Closed,
}

impl PubsubForward {
    pub fn new(upstream_url: String, client_tx: mpsc::UnboundedSender<Message>) -> Self {
        let inner = Arc::new(Inner {
            state: Mutex::new(State::Connecting { buffered: Vec::new() }),
        });
        tokio::spawn(connect_loop(upstream_url, inner.clone(), client_tx));
        Self { inner }
    }

    /// Forward one frame to the upstream.  Buffers if upstream isn't
    /// open yet.  Silently drops once the upstream is closed.
    pub fn send(&self, raw: String) {
        let mut guard = self.inner.state.lock();
        match &mut *guard {
            State::Connecting { buffered } => buffered.push(raw),
            State::Open { tx } => {
                if tx.send(raw).is_err() {
                    *guard = State::Closed;
                }
            }
            State::Closed => {}
        }
    }
}

async fn connect_loop(
    upstream_url: String,
    inner: Arc<Inner>,
    client_tx: mpsc::UnboundedSender<Message>,
) {
    let connect_result = tokio_tungstenite::connect_async(&upstream_url).await;
    let (mut sink, mut stream) = match connect_result {
        Ok((ws, _resp)) => ws.split(),
        Err(e) => {
            tracing::error!(
                error = %e,
                url = %upstream_url,
                "pubsub_upstream_connect_failed",
            );
            *inner.state.lock() = State::Closed;
            return;
        }
    };

    // Drain anything the client queued while we were handshaking, then
    // transition to Open so subsequent `send`s go straight through.
    let (up_tx, mut up_rx) = mpsc::unbounded_channel::<String>();
    {
        let mut guard = inner.state.lock();
        if let State::Connecting { buffered } = std::mem::replace(
            &mut *guard,
            State::Open { tx: up_tx.clone() },
        ) {
            for raw in buffered {
                if up_tx.send(raw).is_err() {
                    *guard = State::Closed;
                    return;
                }
            }
        }
    }

    let writer = async move {
        while let Some(raw) = up_rx.recv().await {
            if sink.send(TungsteniteMessage::Text(raw.into())).await.is_err() {
                break;
            }
        }
    };
    let reader = async move {
        while let Some(msg) = stream.next().await {
            let Ok(msg) = msg else { break };
            let frame = match msg {
                TungsteniteMessage::Text(t) => Message::Text(t.to_string().into()),
                TungsteniteMessage::Binary(b) => Message::Binary(b.to_vec().into()),
                TungsteniteMessage::Ping(p) => Message::Ping(p.to_vec().into()),
                TungsteniteMessage::Pong(p) => Message::Pong(p.to_vec().into()),
                TungsteniteMessage::Close(_) => break,
                TungsteniteMessage::Frame(_) => continue,
            };
            if client_tx.send(frame).is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = writer => {},
        _ = reader => {},
    }
    *inner.state.lock() = State::Closed;
}
