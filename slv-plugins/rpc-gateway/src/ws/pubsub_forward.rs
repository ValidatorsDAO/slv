//! Per-client WebSocket bridge to an upstream Solana JSON-RPC
//! pubsub endpoint.  One outbound connection per client; lazily
//! opened on the first standard pubsub method the client sends.
//!
//! Inbound (`PubsubForward::send`) → upstream; upstream → inbound
//! mpsc channel that feeds the client sender task.  Buffered until
//! the upstream handshake completes.
//!
//! The upstream socket's lifetime is tied to this struct: dropping it
//! (= the client connection ended) drops `_closed`, which resolves the
//! paired receiver inside `connect_loop` and tears the socket down.
//! Without that link the task can block forever — `writer` waits on a
//! channel whose senders `connect_loop` itself still owns, and `reader`
//! waits on an upstream that never speaks again for a client that
//! subscribed to something quiet.

use std::sync::Arc;

use axum::extract::ws::Message;
use futures::stream::StreamExt;
use futures::SinkExt;
use parking_lot::Mutex;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

pub struct PubsubForward {
    inner: Arc<Inner>,
    /// Dropped together with this struct when the client connection
    /// ends.  `connect_loop` selects on the paired receiver, so the
    /// drop is what closes the upstream socket.
    _closed: oneshot::Sender<()>,
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
        let (closed_tx, closed_rx) = oneshot::channel::<()>();
        tokio::spawn(connect_loop(
            upstream_url,
            inner.clone(),
            client_tx,
            closed_rx,
        ));
        Self {
            inner,
            _closed: closed_tx,
        }
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
    closed_rx: oneshot::Receiver<()>,
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
        // The client went away: `PubsubForward` was dropped, so the
        // sender half of this channel is gone and the receiver
        // resolves with `Err`.  Neither `writer` nor `reader` can be
        // relied on here — `writer`'s channel still has senders that
        // this task owns, and `reader` only wakes when the upstream
        // sends a frame, which never happens for a quiet subscription.
        _ = closed_rx => {},
    }
    *inner.state.lock() = State::Closed;
}
