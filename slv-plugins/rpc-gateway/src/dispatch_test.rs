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
    use serde_json::json;

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
        Gateway::new(ch, of1, 20)
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

    #[tokio::test]
    async fn standard_rpc_method_reports_proxy_pending() {
        let gw = gateway();
        let r = gw.dispatch(req("getBalance")).await;
        let e = r.error.expect("should error");
        assert_eq!(e.code, error_codes::METHOD_NOT_FOUND);
        assert!(e.message.contains("upstream proxy not yet ported"));
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
