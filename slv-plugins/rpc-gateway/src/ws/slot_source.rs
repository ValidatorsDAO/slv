//! Multi-source slot fan-in for `slotSubscribe`.
//!
//! One singleton per `Gateway` for each of the three latency-tuned
//! variants the Deno gateway supports:
//!
//! | Constructor | Subscribe method | Filter | Use |
//! |---|---|---|---|
//! | `slot_subscribe(urls)` | `slotSubscribe` | none | dedup `slotNotification` across N upstream pubsubs (jitter smoothing) |
//! | `first_shred(url)` | `slotsUpdatesSubscribe` | `firstShredReceived` | early-signal slot ticks from one source |
//! | `first_shred_multiplex(urls)` | `slotsUpdatesSubscribe` | `firstShredReceived` | both axes combined |
//!
//! Each variant opens N persistent WebSocket connections (one per
//! URL) when the first client subscribes, dedupes incoming slot
//! numbers in a 1024-slot sliding window, and fans the resulting
//! `SlotUpdate` events out to all currently-registered listeners.
//!
//! Listeners are removed automatically when the returned
//! `SlotSubscription` is dropped — the WS handler abort()s the
//! forwarder task on `slotUnsubscribe` which lets the
//! `SlotSubscription` drop and unregister.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::SinkExt;
use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as TM;

const MAX_DELIVERED: usize = 1024;
const RECONNECT_MIN: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct SlotUpdate {
    pub slot: u64,
    /// Parent slot when carried in the upstream notification, `None`
    /// otherwise (`firstShredReceived` does not always carry it).
    pub parent: Option<u64>,
    /// Approximated `root` (= `slot.saturating_sub(32)`) so the
    /// emitted `slotNotification` carries a numeric field even when
    /// the upstream notification doesn't include one.  Clients that
    /// need an accurate root should use `rootSubscribe`.
    pub root: u64,
}

pub struct SlotPubsubMultiplex {
    /// Used in log lines so operators can tell which singleton emitted what.
    label: &'static str,
    urls: Vec<String>,
    subscribe_method: &'static str,
    notification_method: &'static str,
    filter_type: Option<&'static str>,
    listeners: Mutex<HashMap<u64, mpsc::UnboundedSender<SlotUpdate>>>,
    delivered: Mutex<DeliveredWindow>,
    next_listener_id: AtomicU64,
    started: AtomicBool,
}

struct DeliveredWindow {
    queue: VecDeque<u64>,
    set: HashSet<u64>,
}

impl DeliveredWindow {
    fn new() -> Self {
        Self { queue: VecDeque::new(), set: HashSet::new() }
    }
    /// `true` when the slot was newly inserted (= caller should
    /// deliver), `false` when it was already in the window.
    fn observe(&mut self, slot: u64) -> bool {
        if !self.set.insert(slot) {
            return false;
        }
        self.queue.push_back(slot);
        if self.queue.len() > MAX_DELIVERED {
            if let Some(evict) = self.queue.pop_front() {
                self.set.remove(&evict);
            }
        }
        true
    }
}

impl SlotPubsubMultiplex {
    /// Dedup'd `slotSubscribe` fan-in (= jitter smoothing across
    /// multiple upstream pubsubs).
    pub fn slot_subscribe(urls: Vec<String>) -> Self {
        Self::new("slot_multiplex", urls, "slotSubscribe", "slotNotification", None)
    }

    /// Single upstream re-emitting `firstShredReceived` events from
    /// `slotsUpdatesSubscribe` as `slotNotification`.
    pub fn first_shred(url: String) -> Self {
        Self::new(
            "slot_first_shred",
            vec![url],
            "slotsUpdatesSubscribe",
            "slotsUpdatesNotification",
            Some("firstShredReceived"),
        )
    }

    /// Dedup'd `firstShredReceived` fan-in across N upstreams.
    pub fn first_shred_multiplex(urls: Vec<String>) -> Self {
        Self::new(
            "slot_first_shred_multiplex",
            urls,
            "slotsUpdatesSubscribe",
            "slotsUpdatesNotification",
            Some("firstShredReceived"),
        )
    }

    fn new(
        label: &'static str,
        urls: Vec<String>,
        subscribe_method: &'static str,
        notification_method: &'static str,
        filter_type: Option<&'static str>,
    ) -> Self {
        Self {
            label,
            urls,
            subscribe_method,
            notification_method,
            filter_type,
            listeners: Mutex::new(HashMap::new()),
            delivered: Mutex::new(DeliveredWindow::new()),
            next_listener_id: AtomicU64::new(1),
            started: AtomicBool::new(false),
        }
    }

    /// Register a listener; returns a subscription handle.  Dropping
    /// the handle unregisters the listener and (if it was the last
    /// one) leaves the upstream connections running — connections
    /// are cheap to keep open and reattaching to a still-running
    /// singleton avoids per-subscriber reconnect storms.
    pub fn subscribe(self: &Arc<Self>) -> SlotSubscription {
        let id = self.next_listener_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.listeners.lock().insert(id, tx);
        self.ensure_started();
        SlotSubscription { multi: Arc::clone(self), id, rx }
    }

    fn ensure_started(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        for url in self.urls.clone() {
            let me = Arc::clone(self);
            tokio::spawn(connect_loop(me, url));
        }
    }

    fn deliver(&self, update: SlotUpdate) {
        if !self.delivered.lock().observe(update.slot) {
            return;
        }
        // Snapshot the listener set so per-listener `send` doesn't
        // hold the lock across an iteration that might want to
        // remove dropped peers.
        let snapshot: Vec<(u64, mpsc::UnboundedSender<SlotUpdate>)> = self
            .listeners
            .lock()
            .iter()
            .map(|(id, tx)| (*id, tx.clone()))
            .collect();
        let mut dead = Vec::new();
        for (id, tx) in snapshot {
            if tx.send(update.clone()).is_err() {
                dead.push(id);
            }
        }
        if !dead.is_empty() {
            let mut listeners = self.listeners.lock();
            for id in dead {
                listeners.remove(&id);
            }
        }
    }
}

pub struct SlotSubscription {
    multi: Arc<SlotPubsubMultiplex>,
    id: u64,
    pub rx: mpsc::UnboundedReceiver<SlotUpdate>,
}

impl Drop for SlotSubscription {
    fn drop(&mut self) {
        self.multi.listeners.lock().remove(&self.id);
    }
}

async fn connect_loop(me: Arc<SlotPubsubMultiplex>, url: String) {
    let mut delay = RECONNECT_MIN;
    loop {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                tracing::info!(
                    label = %me.label,
                    url = %url,
                    "slot_pubsub_connected",
                );
                delay = RECONNECT_MIN;
                let _ = run_one(&me, ws).await;
                tracing::warn!(label = %me.label, url = %url, "slot_pubsub_disconnected");
            }
            Err(e) => {
                tracing::error!(
                    label = %me.label,
                    url = %url,
                    error = %e,
                    "slot_pubsub_connect_failed",
                );
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RECONNECT_MAX);
    }
}

async fn run_one(
    me: &Arc<SlotPubsubMultiplex>,
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let (mut sink, mut stream) = ws.split();
    let sub = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": me.subscribe_method,
    });
    sink.send(TM::Text(sub.to_string().into())).await?;

    while let Some(msg) = stream.next().await {
        let msg = msg?;
        let text = match msg {
            TM::Text(t) => t.to_string(),
            TM::Binary(b) => match std::str::from_utf8(&b) {
                Ok(s) => s.to_owned(),
                Err(_) => continue,
            },
            TM::Ping(p) => {
                sink.send(TM::Pong(p)).await?;
                continue;
            }
            TM::Pong(_) | TM::Frame(_) => continue,
            TM::Close(_) => break,
        };
        let parsed: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if parsed.get("method").and_then(Value::as_str) != Some(me.notification_method) {
            continue;
        }
        let Some(result) = parsed.get("params").and_then(|p| p.get("result")) else {
            continue;
        };
        if let Some(filter) = me.filter_type {
            let ty = result.get("type").and_then(Value::as_str);
            if ty != Some(filter) {
                continue;
            }
        }
        let Some(slot) = result.get("slot").and_then(Value::as_u64) else {
            continue;
        };
        if slot == 0 {
            continue;
        }
        let parent = result.get("parent").and_then(Value::as_u64);
        let update = SlotUpdate {
            slot,
            parent,
            root: slot.saturating_sub(32),
        };
        me.deliver(update);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivered_window_dedupes() {
        let mut w = DeliveredWindow::new();
        assert!(w.observe(1));
        assert!(!w.observe(1));
        assert!(w.observe(2));
    }

    #[test]
    fn delivered_window_evicts_oldest_when_full() {
        let mut w = DeliveredWindow::new();
        for slot in 0..(MAX_DELIVERED as u64 + 50) {
            assert!(w.observe(slot));
        }
        // The first 50 slots should have been evicted and be re-observable.
        for slot in 0..50 {
            assert!(w.observe(slot), "slot {slot} should re-enter after eviction");
        }
    }
}
