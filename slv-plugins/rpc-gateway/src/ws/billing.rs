//! WebSocket connection billing emitter.
//!
//! On WebSocket close, POSTs a connection log to a configurable
//! metrics endpoint so a central metering system can charge per-
//! second WS duration.  Fire-and-forget — the POST runs in a
//! detached tokio task and a failure is logged at `error` level but
//! does not affect the client connection.
//!
//! The endpoint URL + bearer token are operator-supplied via env at
//! gateway startup (see `RPC_METRICS_API_URL`, `RPC_METRICS_API_BEARER`
//! in `main.rs`).  Wire format is a JSON body with the keys
//! `apiKey`, `connectionId`, `upstreamIp`, `startTime` (RFC3339),
//! `endTime` (RFC3339), `durationSeconds`.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde_json::json;

/// Per-gateway singleton.  Holds the reusable HTTP client + the
/// `rpc-metrics-api` endpoint config.  Cheap to `Arc::clone`.
#[derive(Clone)]
pub struct BillingClient {
    http: Client,
    /// Metrics API base URL (no trailing slash).  The
    /// `/ws-connection-log` path is appended at POST time.  Supplied
    /// via env at startup; no production hostname is encoded here so
    /// this crate stays vendor-agnostic when published.
    base_url: String,
    /// `Authorization: Bearer <bearer>` header value.
    bearer: String,
    /// Host self-identifier emitted as `upstreamIp` in the log body
    /// (for downstream attribution / debugging).
    upstream_ip: String,
}

impl BillingClient {
    pub fn new(base_url: String, bearer: String, upstream_ip: String) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client builds with default config");
        Self { http, base_url, bearer, upstream_ip }
    }

    /// Spawns a detached tokio task that POSTs the close log.
    /// Returns immediately so the WS shutdown path is not blocked.
    /// No-op when `api_key` is empty (= internal probe, no billable
    /// connection).
    pub fn emit_close(
        self: &Arc<Self>,
        api_key: String,
        connection_id: String,
        start_time: SystemTime,
        end_time: SystemTime,
    ) {
        if api_key.is_empty() {
            return;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            me.do_emit(api_key, connection_id, start_time, end_time).await;
        });
    }

    async fn do_emit(
        &self,
        api_key: String,
        connection_id: String,
        start_time: SystemTime,
        end_time: SystemTime,
    ) {
        let duration_secs = end_time
            .duration_since(start_time)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let start_iso = system_time_to_rfc3339(start_time);
        let end_iso = system_time_to_rfc3339(end_time);
        let body = json!({
            "apiKey": api_key,
            "connectionId": connection_id,
            "upstreamIp": self.upstream_ip,
            "startTime": start_iso,
            "endTime": end_iso,
            "durationSeconds": duration_secs,
        });
        let url = format!("{}/ws-connection-log", self.base_url.trim_end_matches('/'));
        match self
            .http
            .post(&url)
            .bearer_auth(&self.bearer)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!(
                    connection_id = %connection_id,
                    duration_seconds = duration_secs,
                    "ws_billing_log_ok"
                );
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                tracing::error!(
                    connection_id = %connection_id,
                    status = %status,
                    body = %body,
                    "ws_billing_log_failed_status"
                );
            }
            Err(e) => {
                tracing::error!(
                    connection_id = %connection_id,
                    error = %e,
                    "ws_billing_log_failed_network"
                );
            }
        }
    }
}

fn system_time_to_rfc3339(t: SystemTime) -> String {
    let dt: DateTime<Utc> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rfc3339_format_matches_iso8601_z() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let s = system_time_to_rfc3339(t);
        // UNIX 1_700_000_000 = 2023-11-14T22:13:20Z
        assert_eq!(s, "2023-11-14T22:13:20.000Z");
    }

    #[test]
    fn empty_api_key_is_no_op() {
        let client = Arc::new(BillingClient::new(
            "http://invalid-host-for-test".into(),
            "test".into(),
            "127.0.0.1".into(),
        ));
        // Empty api_key short-circuits before any HTTP attempt — this
        // call must return without panic and without spawning a task
        // that the test would otherwise wait on.
        client.emit_close(
            String::new(),
            "test-conn".into(),
            SystemTime::now(),
            SystemTime::now(),
        );
        // No assertion beyond "didn't panic"; the spawned task path
        // is not taken when api_key is empty.
    }
}
