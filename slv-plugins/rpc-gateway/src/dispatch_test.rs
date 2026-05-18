//! Dispatcher unit tests — verify the scaffold returns the expected
//! placeholder error shape for every namespace bucket.

#[cfg(test)]
mod tests {
    use crate::dispatch::dispatch;
    use crate::jsonrpc::{error_codes, Id, Request};
    use serde_json::json;

    fn req(method: &str) -> Request {
        Request::validate(json!({
            "jsonrpc": "2.0",
            "method": method,
            "id": 1,
        }))
        .expect("test request envelope is well-formed")
    }

    #[tokio::test]
    async fn known_jet_method_returns_handler_pending() {
        for m in [
            "jetTopPrograms",
            "jetSlotStats",
            "jetTpsTimeseries",
            "jetEpochSummary",
            "jetProgramStats",
        ] {
            let r = dispatch(req(m)).await;
            assert!(r.error.is_some(), "{m} should error in scaffold");
            let e = r.error.unwrap();
            assert_eq!(e.code, error_codes::METHOD_NOT_FOUND);
            assert!(e.message.contains("not yet ported"), "got {:?}", e.message);
        }
    }

    #[tokio::test]
    async fn address_indexed_methods_return_handler_pending() {
        for m in ["getTransactionsForAddress", "getTransfersByAddress"] {
            let r = dispatch(req(m)).await;
            let e = r.error.expect("should error");
            assert_eq!(e.code, error_codes::METHOD_NOT_FOUND);
            assert!(e.message.contains("not yet ported"));
        }
    }

    #[tokio::test]
    async fn unknown_jet_namespace_member_is_caught_early() {
        let r = dispatch(req("jetCompletelyMadeUp")).await;
        let e = r.error.expect("should error");
        assert_eq!(e.code, error_codes::METHOD_NOT_FOUND);
        assert!(
            e.message.starts_with("unknown jet* method:"),
            "expected jet-namespace catch, got {:?}",
            e.message
        );
    }

    #[tokio::test]
    async fn standard_rpc_method_reports_proxy_pending() {
        let r = dispatch(req("getBalance")).await;
        let e = r.error.expect("should error");
        assert_eq!(e.code, error_codes::METHOD_NOT_FOUND);
        assert!(e.message.contains("upstream proxy not yet ported"));
    }

    #[test]
    fn request_validates_jsonrpc_version_and_method() {
        // Good envelope.
        assert!(Request::validate(json!({
            "jsonrpc": "2.0", "method": "jetTopPrograms", "id": 1,
        })).is_some());
        // Missing jsonrpc version.
        assert!(Request::validate(json!({
            "method": "jetTopPrograms", "id": 1,
        })).is_none());
        // Wrong jsonrpc version.
        assert!(Request::validate(json!({
            "jsonrpc": "1.0", "method": "jetTopPrograms", "id": 1,
        })).is_none());
        // Empty method.
        assert!(Request::validate(json!({
            "jsonrpc": "2.0", "method": "", "id": 1,
        })).is_none());
    }

    #[test]
    fn id_or_null_uses_null_when_missing() {
        assert!(matches!(Id::or_null(None), Id::Null));
    }

    #[test]
    fn notification_detected_when_id_absent() {
        let req = Request::validate(json!({
            "jsonrpc": "2.0", "method": "jetTopPrograms",
        }))
        .unwrap();
        assert!(req.is_notification());
    }
}
