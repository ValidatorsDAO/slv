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
    use crate::dispatch::Gateway;
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
            WsConfig { pubsub_url },
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

    #[tokio::test]
    async fn ws_rejects_transaction_subscribe_until_phase4c() {
        // Phase 4c lands the gRPC bridge; until then the gateway
        // tells the client transactionSubscribe is not yet ported.
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
        let err = body.get("error").expect("expected error envelope");
        assert_eq!(err.get("code").unwrap().as_i64().unwrap(), -32601);
        assert!(
            err.get("message").unwrap().as_str().unwrap().contains("not yet ported"),
            "got {body:?}",
        );
    }
}
