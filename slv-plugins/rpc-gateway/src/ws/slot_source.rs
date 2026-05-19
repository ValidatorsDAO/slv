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
//! The `first_shred_multiplex` variant additionally accepts two
//! optional fast-path sources that bypass the validator's TVU
//! processing entirely:
//!
//!   - a gRPC URL pointing at a `jito-shredstream-proxy`'s
//!     `ShredstreamProxy.SubscribeEntries` endpoint — proxy decodes
//!     each shred into an `Entry` whose proto header carries the
//!     slot number.
//!
//!   - a UDP bind address for raw shred reception — the gateway
//!     opens a `UdpSocket` and reads the slot field directly from
//!     the shred header (offset 65, u64 LE, per Solana's
//!     `solana_ledger::shred::wire::get_slot`).  Saves ~150–450 µs
//!     vs the gRPC path by skipping the proxy's decode + gRPC
//!     serialize round-trip.  Requires the upstream sender (the
//!     local `jito-shredstream-proxy` or the stake validator) to
//!     include the gateway's UDP port in its `--dest-ip-ports`.
//!     Signatures are NOT verified by the gateway; security relies
//!     on an IP allowlist (= nftables) at the bind port.
//!
//! All sources feed the same per-multiplex dedup window so the
//! earliest signal across every transport wins.
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
    /// Optional jito-shredstream-proxy `SubscribeEntries` endpoint
    /// (`http://host:port`) used as an additional fast-path source
    /// for `first_shred_multiplex`.  Sent through the same dedup
    /// window as the WS sources.  Only honoured by
    /// `first_shred_multiplex` — other variants ignore it.
    grpc_url: Option<String>,
    /// Optional UDP bind address (`host:port`) for raw shred
    /// reception.  Reads the slot field straight from the shred
    /// header without verifying signatures — security relies on a
    /// strict source-IP allowlist (nftables) at the bind port.
    /// Only honoured by `first_shred_multiplex`.
    udp_bind: Option<String>,
    subscribe_method: &'static str,
    notification_method: &'static str,
    filter_type: Option<&'static str>,
    listeners: Mutex<HashMap<u64, mpsc::UnboundedSender<SlotUpdate>>>,
    delivered: Mutex<DeliveredWindow>,
    next_listener_id: AtomicU64,
    started: AtomicBool,
    /// Highest slot number we've observed across every input source.
    /// Updated lock-free in `deliver()` so the HTTP-RPC `getSlot`
    /// handler can read it without touching any mutex.  Zero =
    /// no signal yet (= unset).
    latest_slot: AtomicU64,
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
        Self::new(
            "slot_multiplex",
            urls,
            None,
            None,
            "slotSubscribe",
            "slotNotification",
            None,
        )
    }

    /// Single upstream re-emitting `firstShredReceived` events from
    /// `slotsUpdatesSubscribe` as `slotNotification`.
    pub fn first_shred(url: String) -> Self {
        Self::new(
            "slot_first_shred",
            vec![url],
            None,
            None,
            "slotsUpdatesSubscribe",
            "slotsUpdatesNotification",
            Some("firstShredReceived"),
        )
    }

    /// Dedup'd `firstShredReceived` fan-in across N upstreams.  When
    /// `grpc_url` is `Some`, a jito-shredstream-proxy
    /// `ShredstreamProxy.SubscribeEntries` stream is added as an
    /// additional input — the proxy bypasses the validator's TVU
    /// processing and reports slot numbers from the raw shred
    /// header, which can win the multiplex race when a shred
    /// arrives via the proxy before the validator finishes shred
    /// verification.  When `udp_bind` is `Some`, the gateway also
    /// listens on that UDP address for raw shred packets and reads
    /// the slot field directly from the header — saves ~150–450 µs
    /// per shred by skipping the proxy's decode + gRPC round-trip.
    pub fn first_shred_multiplex(
        urls: Vec<String>,
        grpc_url: Option<String>,
        udp_bind: Option<String>,
    ) -> Self {
        Self::new(
            "slot_first_shred_multiplex",
            urls,
            grpc_url,
            udp_bind,
            "slotsUpdatesSubscribe",
            "slotsUpdatesNotification",
            Some("firstShredReceived"),
        )
    }

    fn new(
        label: &'static str,
        urls: Vec<String>,
        grpc_url: Option<String>,
        udp_bind: Option<String>,
        subscribe_method: &'static str,
        notification_method: &'static str,
        filter_type: Option<&'static str>,
    ) -> Self {
        Self {
            label,
            urls,
            grpc_url,
            udp_bind,
            subscribe_method,
            notification_method,
            filter_type,
            listeners: Mutex::new(HashMap::new()),
            delivered: Mutex::new(DeliveredWindow::new()),
            next_listener_id: AtomicU64::new(1),
            started: AtomicBool::new(false),
            latest_slot: AtomicU64::new(0),
        }
    }

    /// Eagerly start all configured input sources without registering
    /// a listener.  Lets the HTTP-RPC `getSlot` handler read a fresh
    /// cached value via [`latest_slot`] even when no WS client has
    /// subscribed yet.  Cheap to call (= no-op after first invocation).
    pub fn ensure_running(self: &Arc<Self>) {
        self.ensure_started();
    }

    /// Highest slot observed across all input sources, or `None` when
    /// no signal has arrived yet (= just after process start, or the
    /// multiplex has no live sources).  Lock-free read.
    pub fn latest_slot(&self) -> Option<u64> {
        let v = self.latest_slot.load(Ordering::Relaxed);
        (v != 0).then_some(v)
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
        if let Some(grpc_url) = self.grpc_url.clone() {
            let me = Arc::clone(self);
            tokio::spawn(connect_grpc_loop(me, grpc_url));
        }
        if let Some(udp_bind) = self.udp_bind.clone() {
            let me = Arc::clone(self);
            tokio::spawn(udp_shred_loop(me, udp_bind));
        }
    }

    /// Test-only accessor — exposed so unit tests can drive the
    /// dedup window without spinning up the full connection
    /// machinery.
    #[cfg(test)]
    pub(crate) fn deliver_for_test(&self, update: SlotUpdate) {
        self.deliver(update);
    }

    fn deliver(&self, update: SlotUpdate) {
        if !self.delivered.lock().observe(update.slot) {
            return;
        }
        // Track the high-water mark before fanning out so the
        // HTTP-RPC `getSlot` cache always reflects the latest slot
        // even when no WS listeners are attached.  `fetch_max`
        // guarantees monotonicity under concurrent updates.
        self.latest_slot.fetch_max(update.slot, Ordering::Relaxed);
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

async fn connect_grpc_loop(me: Arc<SlotPubsubMultiplex>, url: String) {
    let mut delay = RECONNECT_MIN;
    loop {
        match try_grpc_once(&me, &url).await {
            Ok(()) => {
                tracing::warn!(
                    label = %me.label,
                    url = %url,
                    "slot_grpc_stream_ended",
                );
            }
            Err(e) => {
                tracing::error!(
                    label = %me.label,
                    url = %url,
                    error = %e,
                    "slot_grpc_connect_failed",
                );
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RECONNECT_MAX);
    }
}

async fn try_grpc_once(
    me: &Arc<SlotPubsubMultiplex>,
    url: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::proto::shredstream::shredstream_proxy_client::ShredstreamProxyClient;
    use crate::proto::shredstream::SubscribeEntriesRequest;

    let endpoint = tonic::transport::Endpoint::from_shared(url.to_string())?
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Some(Duration::from_secs(30)));
    let channel = endpoint.connect().await?;
    let mut client = ShredstreamProxyClient::new(channel);
    tracing::info!(
        label = %me.label,
        url = %url,
        "slot_grpc_connected",
    );
    let request = tonic::Request::new(SubscribeEntriesRequest {});
    let mut stream = client.subscribe_entries(request).await?.into_inner();
    while let Some(entry) = stream.message().await? {
        if entry.slot == 0 {
            continue;
        }
        me.deliver(SlotUpdate {
            slot: entry.slot,
            parent: None,
            root: entry.slot.saturating_sub(32),
        });
    }
    Ok(())
}

/// Solana shred header (signature || variant) + slot field layout:
///   bytes 0..64   = leader signature  (NOT verified here)
///   byte  64      = shred variant flag
///   bytes 65..73  = slot (u64 little-endian)  ← what we read
///   bytes 73..77  = index in slot (u32 LE)    (unused for slot dedup)
///
/// See `solana_ledger::shred::wire::get_slot` for the authoritative
/// reference.  This module intentionally does *not* depend on
/// `solana-ledger` (= huge dep tree); the slot offset is part of
/// the wire protocol and stable across versions.
const SHRED_SLOT_OFFSET: usize = 65;
const SHRED_SLOT_END: usize = SHRED_SLOT_OFFSET + 8;

/// Returns `Some(slot)` when the packet looks like a Solana shred
/// (= long enough to hold the common header + slot field) and the
/// slot is non-zero.  `None` for too-short packets or sentinel `0`.
fn parse_shred_slot(packet: &[u8]) -> Option<u64> {
    let bytes: [u8; 8] = packet.get(SHRED_SLOT_OFFSET..SHRED_SLOT_END)?.try_into().ok()?;
    let slot = u64::from_le_bytes(bytes);
    (slot != 0).then_some(slot)
}

async fn udp_shred_loop(me: Arc<SlotPubsubMultiplex>, bind: String) {
    let mut delay = RECONNECT_MIN;
    loop {
        match tokio::net::UdpSocket::bind(&bind).await {
            Ok(socket) => {
                tracing::info!(
                    label = %me.label,
                    bind = %bind,
                    "slot_udp_bound",
                );
                delay = RECONNECT_MIN;
                let _ = run_udp(&me, socket).await;
                tracing::warn!(label = %me.label, bind = %bind, "slot_udp_socket_closed");
            }
            Err(e) => {
                tracing::error!(
                    label = %me.label,
                    bind = %bind,
                    error = %e,
                    "slot_udp_bind_failed",
                );
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RECONNECT_MAX);
    }
}

async fn run_udp(
    me: &Arc<SlotPubsubMultiplex>,
    socket: tokio::net::UdpSocket,
) -> std::io::Result<()> {
    // Typical Solana shred is ~1228 bytes (MTU-bound).  2048 is
    // comfortable headroom for any current or future shred variant
    // without forcing the kernel to truncate.
    let mut buf = [0u8; 2048];
    loop {
        let (n, _peer) = socket.recv_from(&mut buf).await?;
        if let Some(slot) = parse_shred_slot(&buf[..n]) {
            me.deliver(SlotUpdate {
                slot,
                parent: None,
                root: slot.saturating_sub(32),
            });
        }
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

    #[test]
    fn first_shred_multiplex_stores_grpc_url_alongside_ws_urls() {
        let m = SlotPubsubMultiplex::first_shred_multiplex(
            vec!["ws://127.0.0.1:7212".into(), "ws://127.0.0.1:7111".into()],
            Some("http://127.0.0.1:10000".into()),
            None,
        );
        assert_eq!(m.urls.len(), 2);
        assert_eq!(m.grpc_url.as_deref(), Some("http://127.0.0.1:10000"));
        assert_eq!(m.label, "slot_first_shred_multiplex");
    }

    #[test]
    fn first_shred_multiplex_grpc_only_is_valid() {
        // The dispatcher activates the multiplex when EITHER the
        // WS-URLs list is non-empty OR the gRPC URL is set; the
        // gRPC-only variant must be representable.
        let m = SlotPubsubMultiplex::first_shred_multiplex(
            Vec::new(),
            Some("http://127.0.0.1:10000".into()),
            None,
        );
        assert!(m.urls.is_empty());
        assert!(m.grpc_url.is_some());
    }

    #[test]
    fn other_constructors_ignore_grpc() {
        let m = SlotPubsubMultiplex::slot_subscribe(vec!["ws://x".into()]);
        assert!(m.grpc_url.is_none());
        let m = SlotPubsubMultiplex::first_shred("ws://x".into());
        assert!(m.grpc_url.is_none());
    }

    #[test]
    fn first_shred_multiplex_stores_udp_bind() {
        let m = SlotPubsubMultiplex::first_shred_multiplex(
            Vec::new(),
            None,
            Some("0.0.0.0:20100".into()),
        );
        assert_eq!(m.udp_bind.as_deref(), Some("0.0.0.0:20100"));
        // The other variants must default udp_bind to None.
        let m = SlotPubsubMultiplex::slot_subscribe(vec!["ws://x".into()]);
        assert!(m.udp_bind.is_none());
        let m = SlotPubsubMultiplex::first_shred("ws://x".into());
        assert!(m.udp_bind.is_none());
    }

    #[test]
    fn parse_shred_slot_reads_offset_65_le() {
        // Synthetic shred packet: 64-byte signature + variant byte +
        // slot u64 LE + filler.  Slot value chosen so the byte
        // pattern is unambiguous.
        let mut pkt = vec![0u8; 1228];
        // Slot = 0x0102030405060708 = 72623859790382856
        let slot_bytes: [u8; 8] = 72_623_859_790_382_856u64.to_le_bytes();
        pkt[65..73].copy_from_slice(&slot_bytes);
        assert_eq!(parse_shred_slot(&pkt), Some(72_623_859_790_382_856));
    }

    #[test]
    fn parse_shred_slot_rejects_short_packets() {
        assert_eq!(parse_shred_slot(&[]), None);
        assert_eq!(parse_shred_slot(&[0u8; 64]), None);
        assert_eq!(parse_shred_slot(&[0u8; 72]), None); // 1 byte short
    }

    #[test]
    fn parse_shred_slot_rejects_zero_slot() {
        // Zero slot is the sentinel used by `slotsUpdatesSubscribe`
        // probes and by zero-padded packets — must not be delivered.
        let pkt = vec![0u8; 1228];
        assert_eq!(parse_shred_slot(&pkt), None);
    }

    #[test]
    fn latest_slot_starts_none_then_tracks_high_water_mark() {
        let m = Arc::new(SlotPubsubMultiplex::first_shred_multiplex(
            Vec::new(), None, None,
        ));
        // No deliveries yet — `getSlot` would fall through to upstream.
        assert_eq!(m.latest_slot(), None);

        m.deliver(SlotUpdate { slot: 100, parent: None, root: 100u64.saturating_sub(32) });
        assert_eq!(m.latest_slot(), Some(100));

        // A later slot updates the high-water mark.
        m.deliver(SlotUpdate { slot: 101, parent: None, root: 101u64.saturating_sub(32) });
        assert_eq!(m.latest_slot(), Some(101));

        // An earlier slot (= out-of-order from a slow source) must
        // NOT regress the cache.  Note `deliver()` also dedupes per
        // slot number — slot 100 has already been observed so the
        // second call would be a no-op anyway; we use slot 99 (= a
        // slot we haven't seen but is older than the high-water).
        m.deliver(SlotUpdate { slot: 99, parent: None, root: 99u64.saturating_sub(32) });
        assert_eq!(m.latest_slot(), Some(101));
    }

    #[tokio::test]
    async fn udp_shred_loop_delivers_unique_slots_through_dedup() {
        let m = Arc::new(SlotPubsubMultiplex::first_shred_multiplex(
            Vec::new(),
            None,
            None, // we drive deliver directly, no listener spawn
        ));
        let mut sub = m.subscribe();

        // Two packets, same slot — second must NOT re-deliver.
        let slot = 999_000_001u64;
        let mut pkt = vec![0u8; 1228];
        pkt[65..73].copy_from_slice(&slot.to_le_bytes());
        let parsed = parse_shred_slot(&pkt).unwrap();
        m.deliver(SlotUpdate { slot: parsed, parent: None, root: parsed.saturating_sub(32) });
        m.deliver(SlotUpdate { slot: parsed, parent: None, root: parsed.saturating_sub(32) });

        let first = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            sub.rx.recv(),
        )
        .await
        .expect("first slot arrives")
        .expect("channel still open");
        assert_eq!(first.slot, slot);

        // Second should not arrive.
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            sub.rx.recv(),
        )
        .await;
        assert!(second.is_err(), "duplicate slot must be deduped");
    }
}
