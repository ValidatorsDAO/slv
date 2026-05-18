//! `slv-gtfa-plugin` — jetstreamer plugin emitting per-(tx, pubkey) rows
//! that back the `getTransactionsForAddress` RPC method.
//!
//! anza's three built-in plugins (program-tracking, instruction-tracking,
//! pubkey-stats) are all aggregations: they collapse counts and lose the
//! per-tx signature, which is exactly the field gTFA needs to return.
//! This plugin keeps the per-(tx, mentioned-pubkey) granularity by writing
//! one row to `gtfa_tx_mentions` for every account key referenced by every
//! transaction.
//!
//! Schema (created by `on_load`):
//! ```sql
//! CREATE TABLE gtfa_tx_mentions (
//!   pubkey            FixedString(32),
//!   slot              UInt64,
//!   transaction_index UInt32,
//!   signature         FixedString(64),
//!   status            UInt8,           -- 1 = succeeded, 0 = failed
//!   block_time        UInt32
//! )
//! ENGINE = MergeTree
//! PARTITION BY intDiv(slot, 432000)
//! ORDER BY (pubkey, slot, transaction_index)
//! TTL toDateTime(block_time) + INTERVAL 61 DAY
//! SETTINGS ttl_only_drop_parts = 1
//! ```
//!
//! `PARTITION BY intDiv(slot, 432000)` makes one partition per Solana
//! epoch (= 432000 slots).  `TTL ... + 61 DAY` (= 30 epochs + ~12 hr
//! buffer at ~2 days/epoch) plus `ttl_only_drop_parts = 1` means the
//! background TTL evaluator drops whole epoch partitions instantly via
//! metadata-only delete — no merge / no part rewrite / no 2x disk pressure.
//! Operators can also `ALTER TABLE DROP PARTITION '<epoch_id>'` for
//! manual control.  Steady-state storage is bounded at ~30 epochs.
//!
//! The `ORDER BY (pubkey, ...)` makes the per-address scan that gTFA
//! issues hit a tiny range of granules.  Inserts are batched per-slot in
//! a thread-safe accumulator and flushed in `on_block` so each block
//! results in one INSERT — same shape anza uses for `pubkey_stats`,
//! adjusted for our denormalised one-row-per-mention schema.

use std::sync::Arc;

use clickhouse::{Client, Row};
use dashmap::DashMap;
use futures_util::FutureExt;
use jetstreamer_firehose::firehose::{BlockData, TransactionData};
use jetstreamer_plugin::{Plugin, PluginFuture};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use solana_address::Address;
use solana_message::VersionedMessage;
use solana_signature::Signature;

/// Per-slot accumulator. Outer key = slot, inner value = the row batch
/// for that slot. The slot's batch is removed in `on_block`, ensuring
/// each block produces exactly one INSERT (or zero if the block had no
/// matching transactions).
static PENDING_BY_SLOT: Lazy<
    DashMap<u64, Vec<PendingMention>, ahash::RandomState>,
> = Lazy::new(|| DashMap::with_hasher(ahash::RandomState::new()));

/// Pre-block_time mention; the block_time is filled in when `on_block`
/// fires for that slot (we don't have it from `on_transaction`).
#[derive(Clone, Debug)]
struct PendingMention {
    pubkey: Address,
    transaction_index: u32,
    signature: Signature,
    status: u8,
}


#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct GtfaTxMention {
    pubkey: Address,
    slot: u64,
    transaction_index: u32,
    signature: Signature,
    status: u8,
    block_time: u32,
}

#[derive(Debug, Default, Clone)]
pub struct SlvGtfaPlugin;

impl SlvGtfaPlugin {
    pub const fn new() -> Self {
        Self
    }

    fn take_slot_rows(slot: u64, block_time: Option<i64>) -> Vec<GtfaTxMention> {
        let ts = clamp_block_time(block_time);
        let Some((_, pending)) = PENDING_BY_SLOT.remove(&slot) else {
            return Vec::new();
        };
        pending
            .into_iter()
            .map(|m| GtfaTxMention {
                pubkey: m.pubkey,
                slot,
                transaction_index: m.transaction_index,
                signature: m.signature,
                status: m.status,
                block_time: ts,
            })
            .collect()
    }

    fn drain_all_pending(block_time: Option<i64>) -> Vec<GtfaTxMention> {
        let ts = clamp_block_time(block_time);
        let slots: Vec<u64> = PENDING_BY_SLOT.iter().map(|e| *e.key()).collect();
        let mut out = Vec::new();
        for slot in slots {
            if let Some((_, pending)) = PENDING_BY_SLOT.remove(&slot) {
                out.extend(pending.into_iter().map(|m| GtfaTxMention {
                    pubkey: m.pubkey,
                    slot,
                    transaction_index: m.transaction_index,
                    signature: m.signature,
                    status: m.status,
                    block_time: ts,
                }));
            }
        }
        out
    }
}

impl Plugin for SlvGtfaPlugin {
    #[inline(always)]
    fn name(&self) -> &'static str {
        "slv-gtfa"
    }

    fn on_transaction<'a>(
        &'a self,
        _thread_id: usize,
        _db: Option<Arc<Client>>,
        tx: &'a TransactionData,
    ) -> PluginFuture<'a> {
        async move {
            // Skip votes — gTFA users never ask for them and they would
            // dominate row counts on busy slots (>50% of mainnet txs are
            // vote txs).
            if tx.is_vote {
                return Ok(());
            }

            // Combine static account_keys + ALT-loaded (writable, readonly)
            // so addresses that only show in V0 `loaded_addresses` still
            // match the address-scan — clients expect a transaction to be
            // returned even when the queried account is only referenced
            // via an address lookup table.
            let static_keys: &[Address] = match &tx.transaction.message {
                VersionedMessage::Legacy(msg) => &msg.account_keys,
                VersionedMessage::V0(msg) => &msg.account_keys,
            };
            let loaded = &tx.transaction_status_meta.loaded_addresses;
            let total_keys = static_keys.len()
                + loaded.writable.len()
                + loaded.readonly.len();
            if total_keys == 0 {
                return Ok(());
            }

            // ClickHouse `FixedString(64)` accepts the raw signature
            // bytes; clients can base58 on the way out.  Pass Signature
            // through; clickhouse-rs uses its serde repr.
            let sig = tx.signature;
            let tx_index = tx.transaction_slot_index as u32;
            let status = if tx.transaction_status_meta.status.is_ok() { 1 } else { 0 };

            // Deduplicate by pubkey within this transaction — if the same
            // account appears as both static and ALT-loaded (legal in V0),
            // emit one row, not two.  Each distinct account counts as one
            // mention.
            let mut seen = ahash::AHashSet::with_capacity(total_keys);
            let mut batch = Vec::with_capacity(total_keys);
            for pk in static_keys
                .iter()
                .chain(loaded.writable.iter())
                .chain(loaded.readonly.iter())
            {
                if !seen.insert(*pk) {
                    continue;
                }
                batch.push(PendingMention {
                    pubkey: *pk,
                    transaction_index: tx_index,
                    signature: sig,
                    status,
                });
            }

            // Append into the per-slot bucket.  Multiple tokio workers
            // call `on_transaction` concurrently for the same slot, so
            // DashMap's entry API gives us per-bucket locking.
            PENDING_BY_SLOT
                .entry(tx.slot)
                .or_insert_with(|| Vec::with_capacity(batch.len()))
                .extend(batch);

            Ok(())
        }
        .boxed()
    }

    fn on_block(
        &self,
        _thread_id: usize,
        db: Option<Arc<Client>>,
        block: &BlockData,
    ) -> PluginFuture<'_> {
        let slot = block.slot();
        let block_time = block.block_time();
        let skipped = block.was_skipped();
        async move {
            if skipped {
                // Skipped block — drop whatever transactions accumulated
                // (rare race during fork; same handling anza does in
                // pubkey_stats).
                let _ = PENDING_BY_SLOT.remove(&slot);
                return Ok(());
            }
            let rows = Self::take_slot_rows(slot, block_time);
            let Some(db) = db else { return Ok(()); };
            if rows.is_empty() {
                return Ok(());
            }
            // Spawn fire-and-forget: don't block the firehose progress on
            // a slow ClickHouse insert.  mirror anza's pattern; failed
            // inserts log + drop, the slot can be re-ingested.
            tokio::spawn(async move {
                if let Err(err) = write_rows(db, rows).await {
                    log::error!("slv-gtfa: failed to write gtfa_tx_mentions rows: {err}");
                }
            });
            Ok(())
        }
        .boxed()
    }

    fn on_load(&self, db: Option<Arc<Client>>) -> PluginFuture<'_> {
        async move {
            log::info!("slv-gtfa plugin loaded.");
            let Some(db) = db else {
                log::warn!("slv-gtfa: ClickHouse client unavailable; rows will not be persisted.");
                return Ok(());
            };
            log::info!("slv-gtfa: ensuring gtfa_tx_mentions table exists...");
            db.query(
                r#"
                CREATE TABLE IF NOT EXISTS gtfa_tx_mentions (
                    pubkey            FixedString(32),
                    slot              UInt64,
                    transaction_index UInt32,
                    signature         FixedString(64),
                    status            UInt8,
                    block_time        UInt32
                )
                ENGINE = MergeTree
                PARTITION BY intDiv(slot, 432000)
                ORDER BY (pubkey, slot, transaction_index)
                TTL toDateTime(block_time) + INTERVAL 61 DAY
                SETTINGS ttl_only_drop_parts = 1
                "#,
            )
            .execute()
            .await?;
            log::info!("slv-gtfa: gtfa_tx_mentions table ready.");
            Ok(())
        }
        .boxed()
    }

    fn on_exit(&self, db: Option<Arc<Client>>) -> PluginFuture<'_> {
        async move {
            // Best-effort: flush any straggler rows on shutdown so we don't
            // lose the tail of an in-progress slot.
            let rows = Self::drain_all_pending(None);
            let Some(db) = db else { return Ok(()); };
            if rows.is_empty() {
                return Ok(());
            }
            if let Err(err) = write_rows(db, rows).await {
                log::error!("slv-gtfa: shutdown flush failed: {err}");
            }
            Ok(())
        }
        .boxed()
    }
}

async fn write_rows(db: Arc<Client>, rows: Vec<GtfaTxMention>) -> Result<(), clickhouse::error::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut insert = db.insert::<GtfaTxMention>("gtfa_tx_mentions").await?;
    for row in rows {
        insert.write(&row).await?;
    }
    insert.end().await
}

fn clamp_block_time(block_time: Option<i64>) -> u32 {
    // ClickHouse UInt32 -> Unix seconds; well before 2106 we're fine.
    // anza's pubkey_stats uses the same clamp logic.
    let t = block_time.unwrap_or(0);
    if t < 0 {
        0
    } else if t > u32::MAX as i64 {
        u32::MAX
    } else {
        t as u32
    }
}
