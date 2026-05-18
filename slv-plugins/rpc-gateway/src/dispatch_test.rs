//! Dispatcher unit tests.
//!
//! Routing assertions only — handler-level SQL is exercised against a
//! live ClickHouse via the smoke test in the PR body, not here, so
//! these tests stay hermetic.

#[cfg(test)]
mod tests {
    use crate::clickhouse::{ClickHouseClient, ClickHouseConfig};
    use crate::dispatch::Gateway;
    use crate::jsonrpc::{error_codes, Request};
    use crate::of1::{Of1Client, Of1Config};
    use crate::ws::WsConfig;
    use serde_json::json;

    fn default_ws_cfg() -> WsConfig {
        WsConfig {
            pubsub_url: "ws://127.0.0.1:1".into(),
            slot_pubsub_url: None,
        }
    }

    fn req(method: &str) -> Request {
        Request::validate(json!({
            "jsonrpc": "2.0",
            "method": method,
            "id": 1,
        }))
        .expect("test request envelope is well-formed")
    }

    fn gateway() -> Gateway {
        // Bogus URLs are fine for routing tests — every handler in this
        // file's assertions short-circuits before touching the network.
        let ch = ClickHouseClient::new(ClickHouseConfig::default())
            .expect("default ch config builds");
        let of1 = Of1Client::new(Of1Config::default())
            .expect("default of1 config builds");
        Gateway::new(ch, of1, 20, default_ws_cfg())
    }

    #[tokio::test]
    async fn address_indexed_methods_surface_invalid_params_for_missing_address() {
        // Both gtfa and transfers handlers validate params before
        // touching the network; an empty request surfaces the
        // handler-level error message as INVALID_PARAMS.
        let gw = gateway();
        for m in ["getTransactionsForAddress", "getTransfersByAddress"] {
            let r = gw.dispatch(req(m)).await;
            let e = r.error.expect("should error");
            assert_eq!(e.code, error_codes::INVALID_PARAMS, "{m}");
            assert!(e.message.contains("missing"), "{m} got {:?}", e.message);
        }
    }

    #[tokio::test]
    async fn unknown_jet_namespace_member_is_caught_early() {
        let gw = gateway();
        let r = gw.dispatch(req("jetCompletelyMadeUp")).await;
        let e = r.error.expect("should error");
        assert_eq!(e.code, error_codes::METHOD_NOT_FOUND);
        assert!(
            e.message.starts_with("unknown jet* method:"),
            "expected jet-namespace catch, got {:?}",
            e.message,
        );
    }

    /// Spawn a tiny axum server that echoes a canned JSON-RPC response
    /// for one POST.  Used by the proxy round-trip test below so we
    /// can verify the forward path end-to-end without a live upstream.
    async fn spawn_mock_upstream(canned: serde_json::Value) -> (String, tokio::task::JoinHandle<()>) {
        use axum::{routing::post, Json, Router};
        let app = Router::new().route(
            "/",
            post(move |Json(_body): Json<serde_json::Value>| {
                let canned = canned.clone();
                async move { Json(canned) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn proxy_forwards_full_envelope_and_returns_upstream_body() {
        let canned = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": { "context": { "slot": 1 }, "value": 42 },
        });
        let (url, server) = spawn_mock_upstream(canned.clone()).await;
        let ch = ClickHouseClient::new(ClickHouseConfig::default()).unwrap();
        let of1 = Of1Client::new(Of1Config { url, ..Of1Config::default() }).unwrap();
        let gw = Gateway::new(ch, of1, 20, default_ws_cfg());
        let req = Request::validate(json!({
            "jsonrpc": "2.0", "method": "getBalance", "id": 7,
            "params": ["SomeAddress"],
        })).unwrap();
        let resp = gw.dispatch(req).await;
        assert!(resp.error.is_none(), "expected ok, got {:?}", resp.error);
        assert_eq!(resp.result.unwrap(), canned.get("result").unwrap().clone());
        server.abort();
    }

    #[tokio::test]
    async fn standard_rpc_method_now_forwards_to_upstream() {
        // With Phase 3 the gateway pass-throughs unknown methods to
        // the upstream RPC node.  The default config points at
        // `http://localhost:8888` which isn't running in CI, so the
        // forward fails — that surfaces as `UPSTREAM_ERROR`, not
        // METHOD_NOT_FOUND.  Either way the dispatcher no longer
        // short-circuits with "not yet ported".
        let gw = gateway();
        let r = gw.dispatch(req("getBalance")).await;
        let e = r.error.expect("should error in CI without an upstream");
        assert_eq!(e.code, error_codes::UPSTREAM_ERROR);
        assert!(e.message.starts_with("upstream:"));
    }

    #[tokio::test]
    async fn jet_method_with_invalid_params_returns_invalid_params() {
        // slotStats requires `slot` or `fromSlot+toSlot`; an empty
        // params object surfaces the handler-level error message as
        // INVALID_PARAMS without going to the network for any cluster
        // SQL (the handler validates before it queries).
        let gw = gateway();
        let req = Request::validate(json!({
            "jsonrpc": "2.0",
            "method": "jetSlotStats",
            "params": [{}],
            "id": 9,
        }))
        .unwrap();
        let r = gw.dispatch(req).await;
        let e = r.error.expect("should error");
        assert_eq!(e.code, error_codes::INVALID_PARAMS);
        assert!(e.message.contains("missing fromSlot"));
    }
}
