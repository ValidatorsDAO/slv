//! Yellowstone-gRPC client for the extended `transactionSubscribe`
//! / `transactionUnsubscribe` WebSocket methods.
//!
//! Each client `transactionSubscribe` opens its own outbound gRPC
//! subscribe stream with the client's filters; the resulting
//! `SubscribeUpdate.Transaction` events are transformed into a
//! JSON-RPC `transactionNotification` frame and pushed into the
//! per-client outbound mpsc.  Dropping the spawned forwarder task
//! tears the gRPC stream down — `transactionUnsubscribe` triggers
//! the abort via the per-connection `local_subs` map.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;
use yellowstone_grpc_client::{GeyserGrpcBuilderError, GeyserGrpcClient, GeyserGrpcClientError};
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeUpdate, SubscribeUpdateTransaction,
};

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("yellowstone gRPC build error: {0}")]
    Builder(#[from] GeyserGrpcBuilderError),
    #[error("yellowstone gRPC client error: {0}")]
    Client(#[from] GeyserGrpcClientError),
    #[error("yellowstone gRPC stream ended")]
    StreamEnded,
}

/// Per-call filter parsed out of the JSON-RPC params.  Matches the
/// extended-`transactionSubscribe` shape used by web3.js clients
/// that support filter-based transaction subscriptions; see the
/// Deno gateway's `TxSubscribeFilter` for the historical mapping.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TxSubscribeFilter {
    pub vote: Option<bool>,
    pub failed: Option<bool>,
    pub signature: Option<String>,
    pub account_include: Vec<String>,
    pub account_exclude: Vec<String>,
    pub account_required: Vec<String>,
}

/// Per-call options.  Mirrors `getTransaction` opts — commitment,
/// encoding, level of transaction detail to project into the
/// notification.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TxSubscribeOpts {
    pub commitment: Option<String>,
    pub encoding: Option<String>,
    /// One of `"full"` / `"signatures"` / `"accounts"` / `"none"`.
    /// Defaults to `"full"`.
    pub transaction_details: Option<String>,
    pub show_rewards: Option<bool>,
    pub max_supported_transaction_version: Option<u8>,
}

#[derive(Clone)]
pub struct YellowstoneBridge {
    endpoint: String,
}

impl YellowstoneBridge {
    pub fn new(endpoint: String) -> Self {
        // Bare `host:port` → coerce to `http://host:port` so tonic
        // can parse it; tonic's `Endpoint::from_shared` requires a
        // scheme.  Matches the Deno gateway's behaviour.
        let endpoint = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            endpoint
        } else {
            format!("http://{}", endpoint.trim_start_matches("grpc://"))
        };
        Self { endpoint }
    }

    /// Open a streaming `Subscribe` call against the upstream
    /// Yellowstone-gRPC and forward decoded transaction events into
    /// `on_update`.  The returned future resolves when either the
    /// stream ends naturally or the caller drops the future (which
    /// aborts the gRPC call).
    pub async fn run_subscribe<F>(
        &self,
        sub_id: u64,
        filter: TxSubscribeFilter,
        opts: TxSubscribeOpts,
        mut on_update: F,
    ) -> Result<(), BridgeError>
    where
        F: FnMut(Value) -> bool + Send + 'static,
    {
        let mut client = GeyserGrpcClient::build_from_shared(self.endpoint.clone())?
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .connect()
            .await?;

        let req = build_subscribe_request(sub_id, &filter, &opts);
        let mut stream = client
            .subscribe_once(req)
            .await?;

        use futures::stream::StreamExt as _;
        while let Some(update) = stream.next().await {
            let update = match update {
                Ok(u) => u,
                Err(status) => {
                    tracing::warn!(sub_id, status = %status, "yellowstone subscribe stream error");
                    break;
                }
            };
            let SubscribeUpdate { update_oneof: Some(UpdateOneof::Transaction(tx_update)), .. } =
                update
            else {
                continue;
            };
            let notification = transform_to_notification(sub_id, &tx_update, &opts);
            if !on_update(notification) {
                break;
            }
        }
        Ok(())
    }
}

fn build_subscribe_request(
    sub_id: u64,
    filter: &TxSubscribeFilter,
    opts: &TxSubscribeOpts,
) -> SubscribeRequest {
    let mut transactions = HashMap::new();
    transactions.insert(
        format!("txsub-{sub_id}"),
        SubscribeRequestFilterTransactions {
            vote: filter.vote,
            failed: filter.failed,
            signature: filter.signature.clone(),
            account_include: filter.account_include.clone(),
            account_exclude: filter.account_exclude.clone(),
            account_required: filter.account_required.clone(),
        },
    );
    let commitment = match opts.commitment.as_deref() {
        Some("processed") => CommitmentLevel::Processed,
        Some("finalized") => CommitmentLevel::Finalized,
        _ => CommitmentLevel::Confirmed,
    } as i32;
    SubscribeRequest {
        accounts: HashMap::new(),
        slots: HashMap::new(),
        transactions,
        transactions_status: HashMap::new(),
        blocks: HashMap::new(),
        blocks_meta: HashMap::new(),
        entry: HashMap::new(),
        commitment: Some(commitment),
        accounts_data_slice: Vec::new(),
        ping: None,
        from_slot: None,
    }
}

fn transform_to_notification(
    sub_id: u64,
    update: &SubscribeUpdateTransaction,
    opts: &TxSubscribeOpts,
) -> Value {
    let slot = update.slot;
    let detail_level = opts.transaction_details.as_deref().unwrap_or("full");

    let Some(tx_info) = update.transaction.as_ref() else {
        return json!({
            "jsonrpc": "2.0",
            "method": "transactionNotification",
            "params": {
                "subscription": sub_id,
                "result": { "slot": slot },
            },
        });
    };
    let signature_b58 = if tx_info.signature.is_empty() {
        None
    } else {
        Some(bs58::encode(&tx_info.signature).into_string())
    };

    let result = match detail_level {
        "none" => json!({
            "signature": signature_b58,
            "slot": slot,
            "blockTime": Value::Null,
        }),
        "signatures" => {
            let signatures = tx_info
                .transaction
                .as_ref()
                .map(|t| {
                    t.signatures
                        .iter()
                        .map(|s| bs58::encode(s).into_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "transaction": { "signatures": signatures },
                "signature": signature_b58,
                "slot": slot,
                "blockTime": Value::Null,
            })
        }
        _ => {
            // "full" / "accounts" / anything else.  This Rust port
            // currently emits only the signatures + slot + the
            // tx-level success/failure marker; the Deno gateway
            // surfaces the full proto JSON via npm bindings that
            // expose proto types with native serde, which the
            // Rust proto crate doesn't ship.  Clients that need
            // the parsed transaction body should fetch it via
            // `getTransaction(signature)` after the notification.
            // Tracked for a follow-up that adds the
            // `solana_transaction_status::UiTransactionStatusMeta`
            // conversion.
            let signatures = tx_info
                .transaction
                .as_ref()
                .map(|t| {
                    t.signatures
                        .iter()
                        .map(|s| bs58::encode(s).into_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let is_vote = tx_info.is_vote;
            let err = tx_info
                .meta
                .as_ref()
                .and_then(|m| m.err.as_ref())
                .map(|e| json!({ "encoded": bs58::encode(&e.err).into_string() }));
            json!({
                "signature": signature_b58,
                "slot": slot,
                "blockTime": Value::Null,
                "transaction": { "signatures": signatures },
                "isVote": is_vote,
                "err": err,
            })
        }
    };

    json!({
        "jsonrpc": "2.0",
        "method": "transactionNotification",
        "params": {
            "subscription": sub_id,
            "result": result,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_coerces_bare_hostport() {
        let b = YellowstoneBridge::new("localhost:10000".into());
        assert_eq!(b.endpoint, "http://localhost:10000");
    }

    #[test]
    fn endpoint_passes_https_through() {
        let b = YellowstoneBridge::new("https://example:443".into());
        assert_eq!(b.endpoint, "https://example:443");
    }

    #[test]
    fn endpoint_strips_grpc_scheme() {
        let b = YellowstoneBridge::new("grpc://x:1".into());
        assert_eq!(b.endpoint, "http://x:1");
    }

    #[test]
    fn build_subscribe_request_uses_default_commitment_confirmed() {
        let filter = TxSubscribeFilter::default();
        let opts = TxSubscribeOpts::default();
        let req = build_subscribe_request(7, &filter, &opts);
        assert_eq!(req.commitment, Some(CommitmentLevel::Confirmed as i32));
        let entry_key = format!("txsub-{}", 7);
        assert!(req.transactions.contains_key(&entry_key));
    }

    #[test]
    fn build_subscribe_request_carries_filter_lists() {
        let filter = TxSubscribeFilter {
            vote: Some(false),
            failed: Some(false),
            signature: None,
            account_include: vec!["PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY".into()],
            account_exclude: vec![],
            account_required: vec![],
        };
        let opts = TxSubscribeOpts {
            commitment: Some("finalized".into()),
            ..TxSubscribeOpts::default()
        };
        let req = build_subscribe_request(9, &filter, &opts);
        assert_eq!(req.commitment, Some(CommitmentLevel::Finalized as i32));
        let entry = req.transactions.values().next().unwrap();
        assert_eq!(entry.vote, Some(false));
        assert_eq!(entry.account_include.len(), 1);
    }

    #[test]
    fn transform_to_notification_none_detail_returns_minimal() {
        let update = SubscribeUpdateTransaction {
            slot: 42,
            transaction: Some(Default::default()),
        };
        let opts = TxSubscribeOpts {
            transaction_details: Some("none".into()),
            ..TxSubscribeOpts::default()
        };
        let note = transform_to_notification(1, &update, &opts);
        assert_eq!(note["method"], "transactionNotification");
        assert_eq!(note["params"]["subscription"], 1);
        assert_eq!(note["params"]["result"]["slot"], 42);
        // `transaction` / `meta` should be absent on `none`.
        assert!(note["params"]["result"].get("transaction").is_none());
    }
}
