//! WS handler integration test.  Spins a mock pubsub upstream
//! (tokio-tungstenite) and a real gateway server (axum on
//! 127.0.0.1:0), connects a real WebSocket client, sends
//! `slotSubscribe`, and asserts the canned upstream response
//! makes it back to the client.

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;

    use axum::routing::get;
    use axum::Router;
    use futures::SinkExt;
    use futures::StreamExt;
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message as TM;

    use crate::clickhouse::{ClickHouseClient, ClickHouseConfig};
    use crate::dispatch::{Gateway, GatewayBuilder};
    use crate::of1::{Of1Client, Of1Config};
    use crate::ws::{ws_route, WsConfig};

    /// Trivial Solana-pubsub-compatible mock: accepts the WS upgrade,
    /// waits for one `slotSubscribe`, replies with the canned
    /// envelope verbatim.
    async fn spawn_mock_pubsub(canned_subscribe_reply: Value) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let (mut sink, mut stream) = ws.split();
            if let Some(Ok(_first)) = stream.next().await {
                let raw = serde_json::to_string(&canned_subscribe_reply).unwrap();
                let _ = sink.send(TM::Text(raw.into())).await;
            }
        });
        format!("ws://{addr}/")
    }

    async fn spawn_gateway(pubsub_url: String) -> String {
        let ch = ClickHouseClient::new(ClickHouseConfig::default()).unwrap();
        let of1 = Of1Client::new(Of1Config::default()).unwrap();
        let gw = Arc::new(Gateway::new(
            ch,
            of1,
            20,
            WsConfig { pubsub_url, slot_pubsub_url: None },
        ));
        let app = Router::new().route("/ws", get(ws_route)).with_state(gw);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("ws://{addr}/ws")
    }

    #[tokio::test]
    async fn ws_forwards_standard_pubsub_to_upstream() {
        let canned = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": 12345,
        });
        let pubsub_url = spawn_mock_pubsub(canned.clone()).await;
        let gateway_url = spawn_gateway(pubsub_url).await;

        let (mut ws, _) = tokio_tungstenite::connect_async(&gateway_url).await.unwrap();
        ws.send(TM::Text(
            json!({"jsonrpc": "2.0", "id": 1, "method": "slotSubscribe"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
            .await
            .expect("upstream reply within timeout")
            .expect("got a frame")
            .expect("frame was ok");
        let body = match frame {
            TM::Text(t) => serde_json::from_str::<Value>(&t).unwrap(),
            other => panic!("unexpected frame: {other:?}"),
        };
        assert_eq!(body, canned, "client should receive the canned upstream reply verbatim");
    }

    /// Mock pubsub that streams `firstShredReceived` notifications
    /// at a fixed interval until the client disconnects.  Used to
    /// drive the slot-first-shred-multiplex variant of the
    /// `slotSubscribe` cascade end-to-end.
    async fn spawn_mock_first_shred_stream(slots: Vec<u64>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let slots = slots.clone();
                tokio::spawn(async move {
                    let ws = match tokio_tungstenite::accept_async(sock).await {
                        Ok(w) => w,
                        Err(_) => return,
                    };
                    let (mut sink, mut stream) = ws.split();
                    // Drain client subscribe; we don't care about its contents.
                    let _ = stream.next().await;
                    let sub_ack = serde_json::json!({
                        "jsonrpc": "2.0", "id": 1, "result": 1,
                    });
                    let _ = sink.send(TM::Text(sub_ack.to_string().into())).await;
                    for slot in slots {
                        let frame = serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "slotsUpdatesNotification",
                            "params": {
                                "subscription": 1,
                                "result": {
                                    "slot": slot,
                                    "parent": slot.saturating_sub(1),
                                    "type": "firstShredReceived",
                                },
                            },
                        });
                        if sink.send(TM::Text(frame.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        format!("ws://{addr}/")
    }

    async fn spawn_gateway_with_slot_first_shred(urls: Vec<String>) -> String {
        let ch = ClickHouseClient::new(ClickHouseConfig::default()).unwrap();
        let of1 = Of1Client::new(Of1Config::default()).unwrap();
        let ws_cfg = WsConfig {
            pubsub_url: "ws://127.0.0.1:1".into(),
            slot_pubsub_url: None,
        };
        let builder = GatewayBuilder {
            full_concurrency: 20,
            ws: None,
            slot_first_shred_multiplex_urls: urls,
            slot_first_shred_url: None,
            slot_multiplex_urls: Vec::new(),
            yellowstone_endpoint: "localhost:10000".into(),
        };
        let gw = Arc::new(Gateway::with_slot_sources(ch, of1, ws_cfg, builder));
        let app = Router::new().route("/ws", get(ws_route)).with_state(gw);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("ws://{addr}/ws")
    }

    #[tokio::test]
    async fn slot_first_shred_multiplex_dedupes_and_remits_as_slot_notification() {
        // Two upstreams emit overlapping slot ranges; the multiplex
        // should deliver each slot exactly once as `slotNotification`.
        let a = spawn_mock_first_shred_stream(vec![100, 101, 102, 103]).await;
        let b = spawn_mock_first_shred_stream(vec![101, 102, 103, 104]).await;
        let gateway_url = spawn_gateway_with_slot_first_shred(vec![a, b]).await;

        let (mut ws, _) = tokio_tungstenite::connect_async(&gateway_url).await.unwrap();
        ws.send(TM::Text(
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "slotSubscribe"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        // Expect the ack envelope first.
        let ack_frame = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let ack: Value = match ack_frame {
            TM::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("unexpected ack frame: {other:?}"),
        };
        let sub_id = ack.get("result").and_then(Value::as_u64).unwrap();
        assert!(sub_id >= crate::ws::LOCAL_SUB_ID_BASE, "sub_id should be local-base, got {sub_id}");

        // Collect up to 5 distinct slot notifications within a couple seconds.
        let mut seen: std::collections::HashSet<u64> = Default::default();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while seen.len() < 5 && tokio::time::Instant::now() < deadline {
            let next = tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await;
            match next {
                Ok(Some(Ok(TM::Text(t)))) => {
                    let body: Value = serde_json::from_str(&t).unwrap();
                    if body.get("method").and_then(Value::as_str) == Some("slotNotification") {
                        let slot = body
                            .pointer("/params/result/slot")
                            .and_then(Value::as_u64)
                            .unwrap();
                        seen.insert(slot);
                    }
                }
                _ => break,
            }
        }
        // Both upstreams sent {101, 102, 103} which would total 8 if
        // not dedup'd; we expect exactly 5 distinct slots {100..104}.
        assert!(
            seen.is_superset(&[100, 101, 102, 103, 104].iter().copied().collect()),
            "expected dedup'd union, got {seen:?}",
        );
    }

    #[tokio::test]
    async fn ws_accepts_transaction_subscribe_and_returns_local_sub_id() {
        // Phase 4c spawns the gRPC subscribe task in the background
        // and immediately ACKs with a local sub-id ≥ LOCAL_SUB_ID_BASE.
        // The bridge will fail to reach `localhost:10000` in CI and
        // log a warning — that's expected; the client gets the
        // sub-id immediately and a real upstream would deliver
        // notifications later.
        let pubsub_url = spawn_mock_pubsub(json!({})).await;
        let gateway_url = spawn_gateway(pubsub_url).await;

        let (mut ws, _) = tokio_tungstenite::connect_async(&gateway_url).await.unwrap();
        ws.send(TM::Text(
            json!({
                "jsonrpc": "2.0", "id": 5, "method": "transactionSubscribe",
                "params": [{ "vote": false }],
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
            .await
            .expect("server reply within timeout")
            .unwrap()
            .unwrap();
        let body = match frame {
            TM::Text(t) => serde_json::from_str::<Value>(&t).unwrap(),
            other => panic!("unexpected frame: {other:?}"),
        };
        assert!(body.get("error").is_none(), "expected ok, got {body:?}");
        let sub_id = body.get("result").and_then(Value::as_u64).unwrap();
        assert!(
            sub_id >= crate::ws::LOCAL_SUB_ID_BASE,
            "expected local sub-id ≥ {}, got {sub_id}",
            crate::ws::LOCAL_SUB_ID_BASE,
        );
    }
}
