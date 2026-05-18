//! Thin JSON-RPC client for the upstream `of1` (yellowstone-faithful)
//! endpoint.  Currently exposes the single call the gateway needs in
//! Phase 2 — `getTransaction` — but the shape is ready to grow into
//! the full pass-through proxy that lands in Phase 3.
//!
//! The client is a wrapper around a shared `reqwest::Client` (HTTP/2
//! keep-alive, configurable timeout); construct one per process and
//! pass `Arc<Of1Client>` to handlers that need it.

use std::time::Duration;

use reqwest::Client as HttpClient;
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Of1Error {
    #[error("of1 HTTP {0}")]
    Http(u16),
    #[error("of1 transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("of1 error: {0}")]
    Rpc(String),
    #[error("transaction not found in of1 window")]
    NotFound,
    #[error("of1 returned malformed response: {0}")]
    Malformed(String),
}

#[derive(Debug, Clone)]
pub struct Of1Config {
    pub url: String,
    pub timeout: Duration,
}

impl Default for Of1Config {
    fn default() -> Self {
        Self {
            url: "http://localhost:8888".into(),
            timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Of1Client {
    url: String,
    http: HttpClient,
}

#[derive(Debug, Clone)]
pub struct TxFetch {
    pub transaction: Value,
    pub meta: Value,
    pub version: Value,
}

impl Of1Client {
    pub fn new(cfg: Of1Config) -> Result<Self, Of1Error> {
        let http = HttpClient::builder().timeout(cfg.timeout).build()?;
        Ok(Self { url: cfg.url, http })
    }

    /// `getTransaction(signature, { encoding, maxSupportedTransactionVersion })`.
    /// Returns the unwrapped `transaction` / `meta` / `version` fields on
    /// success; `Err(Of1Error::NotFound)` when of1 returns a `null`
    /// result (= tx outside its indexed window).
    pub async fn get_transaction(
        &self,
        signature: &str,
        encoding: &str,
        max_supported_transaction_version: i64,
    ) -> Result<TxFetch, Of1Error> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {
                    "encoding": encoding,
                    "maxSupportedTransactionVersion": max_supported_transaction_version,
                },
            ],
        });
        let res = self.http.post(&self.url).json(&body).send().await?;
        if !res.status().is_success() {
            return Err(Of1Error::Http(res.status().as_u16()));
        }
        let payload: Value = res.json().await?;
        if let Some(err) = payload.get("error") {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("of1 error")
                .to_owned();
            return Err(Of1Error::Rpc(msg));
        }
        let Some(result) = payload.get("result") else {
            return Err(Of1Error::Malformed("missing `result` field".into()));
        };
        if result.is_null() {
            return Err(Of1Error::NotFound);
        }
        Ok(TxFetch {
            transaction: result.get("transaction").cloned().unwrap_or(Value::Null),
            meta: result.get("meta").cloned().unwrap_or(Value::Null),
            version: result.get("version").cloned().unwrap_or(Value::Null),
        })
    }
}
