//! `slv-transfers-plugin` — jetstreamer plugin emitting per-transfer rows
//! that back the `getTransfersByAddress` RPC method.
//!
//! Phase 1 scope (this file): SPL Token v1 `Transfer` (3) and
//! `TransferChecked` (12) **top-level instructions only**.  Phase 3 will
//! extend: SPL Token v1 `MintTo`/`Burn`/`SetAuthority`/`CloseAccount`/
//! `SyncNative`, SPL Token-2022, System program native-SOL `Transfer`,
//! and inner-instruction (CPI) parsing.  See
//! `slv:.claude/design_slv_transfers_plugin.md` for the full plan.
//!
//! Schema (created by `on_load`):
//! ```sql
//! CREATE TABLE token_transfers (
//!   from_owner          FixedString(32),
//!   to_owner            FixedString(32),
//!   from_token_account  Nullable(FixedString(32)),
//!   to_token_account    Nullable(FixedString(32)),
//!   mint                FixedString(32),
//!   amount              UInt64,
//!   fee_amount          UInt64 DEFAULT 0,
//!   decimals            UInt8,
//!   slot                UInt64,
//!   tx_index            UInt32,
//!   instr_index         UInt16,
//!   inner_index         Int16 DEFAULT -1,
//!   transfer_type       UInt8,    -- 1=transfer, 2=mint, 3=burn,
//!                                 -- 4=wrap, 5=unwrap, 6=changeOwner,
//!                                 -- 7=withdrawWithheldFee.
//!                                 -- (Stored as UInt8 instead of an
//!                                 -- Enum8: clickhouse-rs 0.14's Row
//!                                 -- derive can't (de)serialize a Rust
//!                                 -- u8 into an Enum8 column.  The
//!                                 -- gateway handler maps numbers →
//!                                 -- string names at the API edge.)
//!   signature           FixedString(64),
//!   block_time          UInt32
//! )
//! ENGINE = MergeTree
//! PARTITION BY intDiv(slot, 432000)
//! ORDER BY (from_owner, slot, tx_index, instr_index, inner_index)
//! TTL toDateTime(block_time) + INTERVAL 61 DAY
//! SETTINGS ttl_only_drop_parts = 1
//! ```
//!
//! The `(from_owner, slot, ...)` order makes per-address scans hit a
//! tiny range of granules.  A parallel `MATERIALIZED VIEW
//! token_transfers_by_to` keeps a (to_owner, ...) ordered copy for the
//! `direction=in` query path.  Same per-slot batched-flush pattern as
//! the gtfa plugin: pending rows accumulate in a DashMap keyed by slot,
//! flushed in `on_block`, INSERT fires-and-forgets so firehose progress
//! is never blocked on slow CH.
//!
//! `PARTITION BY intDiv(slot, 432000)` makes one partition per Solana
//! epoch.  `TTL ... + 61 DAY` (= 30 epochs at ~2 days/epoch + ~12 hr
//! buffer) plus `ttl_only_drop_parts = 1` lets background TTL evict
//! whole epoch partitions instantly via metadata-only delete — no merge,
//! no part rewrite, no 2x disk pressure.  Steady-state storage is bounded
//! at ~30 epochs (≈ 300 GB for token_transfers + similar for the
//! materialised view at current row density).

use std::str::FromStr;
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
use solana_transaction_status::TransactionTokenBalance;

/// SPL Token v1 program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
/// Token-2022 (`TokenzQd...`) is intentionally NOT here in Phase 1 —
/// adding it requires extension parsing for transfer-fee, not just an
/// extra program-id match.
static SPL_TOKEN_V1_PROGRAM_ID: Lazy<Address> = Lazy::new(|| {
    Address::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        .expect("valid pubkey")
});

/// 32-zero-bytes sentinel, used in `from_owner`/`to_owner` for events
/// that have no counterparty wallet (e.g. mint-to where `from` is the
/// mint authority but conceptually "no sender").  Not used in Phase 1
/// (Transfer always has both sides) but documented for Phase 3.
#[allow(dead_code)]
const ZERO_PUBKEY: [u8; 32] = [0u8; 32];

/// transfer_type Enum8 numeric values — keep in sync with the
/// gateway handler (`api/rpc-gateway/src/handlers/transfers.ts` in
/// the slv repo).
mod transfer_type {
    pub const TRANSFER: u8 = 1;
    #[allow(dead_code)]
    pub const MINT: u8 = 2;
    #[allow(dead_code)]
    pub const BURN: u8 = 3;
    #[allow(dead_code)]
    pub const WRAP: u8 = 4;
    #[allow(dead_code)]
    pub const UNWRAP: u8 = 5;
    #[allow(dead_code)]
    pub const CHANGE_OWNER: u8 = 6;
    #[allow(dead_code)]
    pub const WITHDRAW_WITHHELD_FEE: u8 = 7;
}

/// SPL Token v1 instruction discriminators (first byte of ix.data).
mod spl_token_ix {
    pub const TRANSFER: u8 = 3;
    pub const TRANSFER_CHECKED: u8 = 12;
}

/// Per-slot accumulator. Outer key = slot, inner value = the row batch
/// for that slot. Removed in `on_block`, ensuring each block produces
/// exactly one INSERT (or zero if the block had no matching transfers).
static PENDING_BY_SLOT: Lazy<
    DashMap<u64, Vec<PendingTransfer>, ahash::RandomState>,
> = Lazy::new(|| DashMap::with_hasher(ahash::RandomState::new()));

/// Pre-block_time transfer; block_time is filled in when `on_block`
/// fires for that slot.
#[derive(Clone, Debug)]
struct PendingTransfer {
    from_owner: Address,
    to_owner: Address,
    from_token_account: Option<Address>,
    to_token_account: Option<Address>,
    mint: Address,
    amount: u64,
    fee_amount: u64,
    decimals: u8,
    tx_index: u32,
    instr_index: u16,
    inner_index: i16,
    transfer_type: u8,
    signature: Signature,
}

#[derive(Row, Serialize, Deserialize, Clone, Debug)]
struct TokenTransfer {
    from_owner: Address,
    to_owner: Address,
    from_token_account: Option<Address>,
    to_token_account: Option<Address>,
    mint: Address,
    amount: u64,
    fee_amount: u64,
    decimals: u8,
    slot: u64,
    tx_index: u32,
    instr_index: u16,
    inner_index: i16,
    transfer_type: u8,
    signature: Signature,
    block_time: u32,
}

#[derive(Debug, Default, Clone)]
pub struct SlvTransfersPlugin;

impl SlvTransfersPlugin {
    pub const fn new() -> Self {
        Self
    }

    fn take_slot_rows(slot: u64, block_time: Option<i64>) -> Vec<TokenTransfer> {
        let ts = clamp_block_time(block_time);
        let Some((_, pending)) = PENDING_BY_SLOT.remove(&slot) else {
            return Vec::new();
        };
        pending.into_iter().map(|p| pending_to_row(p, slot, ts)).collect()
    }

    fn drain_all_pending(block_time: Option<i64>) -> Vec<TokenTransfer> {
        let ts = clamp_block_time(block_time);
        let slots: Vec<u64> = PENDING_BY_SLOT.iter().map(|e| *e.key()).collect();
        let mut out = Vec::new();
        for slot in slots {
            if let Some((_, pending)) = PENDING_BY_SLOT.remove(&slot) {
                for p in pending {
                    out.push(pending_to_row(p, slot, ts));
                }
            }
        }
        out
    }
}

impl Plugin for SlvTransfersPlugin {
    #[inline(always)]
    fn name(&self) -> &'static str {
        "slv-transfers"
    }

    fn on_transaction<'a>(
        &'a self,
        _thread_id: usize,
        _db: Option<Arc<Client>>,
        tx: &'a TransactionData,
    ) -> PluginFuture<'a> {
        async move {
            // Skip votes — they never carry token transfers and would
            // dominate the row count.  Same logic gtfa uses.
            if tx.is_vote {
                return Ok(());
            }

            // Combine static account_keys + ALT-loaded (writable, readonly)
            // so an instruction's account index — which addresses into the
            // *combined* list — resolves correctly.  Same combination
            // gtfa uses.
            let static_keys: &[Address] = match &tx.transaction.message {
                VersionedMessage::Legacy(msg) => &msg.account_keys,
                VersionedMessage::V0(msg) => &msg.account_keys,
            };
            let loaded = &tx.transaction_status_meta.loaded_addresses;
            let combined_keys: Vec<Address> = static_keys
                .iter()
                .chain(loaded.writable.iter())
                .chain(loaded.readonly.iter())
                .copied()
                .collect();

            // Pre/post token balances for owner + decimals + mint resolution.
            // The Option wraps the per-tx vec; treat None as empty so we
            // simply fail to parse rather than panic.
            const EMPTY: &[TransactionTokenBalance] = &[];
            let pre_balances: &[TransactionTokenBalance] = tx
                .transaction_status_meta
                .pre_token_balances
                .as_deref()
                .unwrap_or(EMPTY);
            let post_balances: &[TransactionTokenBalance] = tx
                .transaction_status_meta
                .post_token_balances
                .as_deref()
                .unwrap_or(EMPTY);

            // Walk top-level instructions AND inner instructions (CPIs).
            // Inner-ix coverage is the dominant Phase 3 gap-closer: most
            // DEX/router transfers are emitted as CPIs from a top-level
            // router/aggregator ix, not as top-level Token.Transfer.  A
            // 2026-05-14 coverage probe found top-level-only coverage was
            // 15.5%; adding inner-ix is expected to push it >80%.
            let instructions = match &tx.transaction.message {
                VersionedMessage::Legacy(msg) => &msg.instructions,
                VersionedMessage::V0(msg) => &msg.instructions,
            };
            let inner_groups = tx
                .transaction_status_meta
                .inner_instructions
                .as_deref()
                .unwrap_or(&[]);

            let tx_index = tx.transaction_slot_index as u32;
            let signature = tx.signature;

            let mut batch: Vec<PendingTransfer> = Vec::new();

            // 1. Top-level instructions (inner_index = -1).
            for (instr_idx, ix) in instructions.iter().enumerate() {
                if let Some(parsed) = parse_if_token_transfer(
                    ix.program_id_index,
                    &ix.data,
                    &ix.accounts,
                    &combined_keys,
                    pre_balances,
                    post_balances,
                ) {
                    batch.push(PendingTransfer {
                        from_owner: parsed.from_owner,
                        to_owner: parsed.to_owner,
                        from_token_account: parsed.from_token_account,
                        to_token_account: parsed.to_token_account,
                        mint: parsed.mint,
                        amount: parsed.amount,
                        fee_amount: 0,
                        decimals: parsed.decimals,
                        tx_index,
                        instr_index: instr_idx as u16,
                        inner_index: -1,
                        transfer_type: transfer_type::TRANSFER,
                        signature,
                    });
                }
            }

            // 2. Inner instructions per top-level ix.  `group.index` is
            //    the parent top-level ix index; `pos` within
            //    `group.instructions` is what we store as `inner_index`.
            //    `stack_height` exists but isn't part of the wire format
            //    we expose, so we ignore it (the API reports a flat
            //    `innerInstructionIdx`).
            for group in inner_groups {
                let parent_idx = group.index as u16;
                for (pos, inner_ix) in group.instructions.iter().enumerate() {
                    let ci = &inner_ix.instruction;
                    if let Some(parsed) = parse_if_token_transfer(
                        ci.program_id_index,
                        &ci.data,
                        &ci.accounts,
                        &combined_keys,
                        pre_balances,
                        post_balances,
                    ) {
                        batch.push(PendingTransfer {
                            from_owner: parsed.from_owner,
                            to_owner: parsed.to_owner,
                            from_token_account: parsed.from_token_account,
                            to_token_account: parsed.to_token_account,
                            mint: parsed.mint,
                            amount: parsed.amount,
                            fee_amount: 0,
                            decimals: parsed.decimals,
                            tx_index,
                            instr_index: parent_idx,
                            inner_index: pos as i16,
                            transfer_type: transfer_type::TRANSFER,
                            signature,
                        });
                    }
                }
            }

            if batch.is_empty() {
                return Ok(());
            }

            // Append into the per-slot bucket. Multiple tokio workers
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
                let _ = PENDING_BY_SLOT.remove(&slot);
                return Ok(());
            }
            let rows = Self::take_slot_rows(slot, block_time);
            let Some(db) = db else { return Ok(()); };
            if rows.is_empty() {
                return Ok(());
            }
            tokio::spawn(async move {
                if let Err(err) = write_rows(db, rows).await {
                    log::error!("slv-transfers: failed to write token_transfers rows: {err}");
                }
            });
            Ok(())
        }
        .boxed()
    }

    fn on_load(&self, db: Option<Arc<Client>>) -> PluginFuture<'_> {
        async move {
            log::info!("slv-transfers plugin loaded.");
            let Some(db) = db else {
                log::warn!("slv-transfers: ClickHouse client unavailable; rows will not be persisted.");
                return Ok(());
            };
            log::info!("slv-transfers: ensuring token_transfers table exists...");
            db.query(
                r#"
                CREATE TABLE IF NOT EXISTS token_transfers (
                    from_owner          FixedString(32),
                    to_owner            FixedString(32),
                    from_token_account  Nullable(FixedString(32)),
                    to_token_account    Nullable(FixedString(32)),
                    mint                FixedString(32),
                    amount              UInt64,
                    fee_amount          UInt64 DEFAULT 0,
                    decimals            UInt8,
                    slot                UInt64,
                    tx_index            UInt32,
                    instr_index         UInt16,
                    inner_index         Int16 DEFAULT -1,
                    transfer_type       UInt8,
                    signature           FixedString(64),
                    block_time          UInt32
                )
                ENGINE = MergeTree
                PARTITION BY intDiv(slot, 432000)
                ORDER BY (from_owner, slot, tx_index, instr_index, inner_index)
                TTL toDateTime(block_time) + INTERVAL 61 DAY
                SETTINGS ttl_only_drop_parts = 1
                "#,
            )
            .execute()
            .await?;
            log::info!("slv-transfers: ensuring token_transfers_by_to materialized view exists...");
            db.query(
                r#"
                CREATE MATERIALIZED VIEW IF NOT EXISTS token_transfers_by_to
                ENGINE = MergeTree
                PARTITION BY intDiv(slot, 432000)
                ORDER BY (to_owner, slot, tx_index, instr_index, inner_index)
                TTL toDateTime(block_time) + INTERVAL 61 DAY
                SETTINGS ttl_only_drop_parts = 1
                POPULATE
                AS SELECT * FROM token_transfers
                "#,
            )
            .execute()
            .await?;
            log::info!("slv-transfers: token_transfers + by_to view ready.");
            Ok(())
        }
        .boxed()
    }

    fn on_exit(&self, db: Option<Arc<Client>>) -> PluginFuture<'_> {
        async move {
            let rows = Self::drain_all_pending(None);
            let Some(db) = db else { return Ok(()); };
            if rows.is_empty() {
                return Ok(());
            }
            if let Err(err) = write_rows(db, rows).await {
                log::error!("slv-transfers: shutdown flush failed: {err}");
            }
            Ok(())
        }
        .boxed()
    }
}

/// Result of parsing one SPL Token Transfer / TransferChecked ix.
struct ParsedTransfer {
    from_owner: Address,
    to_owner: Address,
    from_token_account: Option<Address>,
    to_token_account: Option<Address>,
    mint: Address,
    amount: u64,
    decimals: u8,
}

/// Helper: combine the program-id check + the SPL Token transfer
/// parse into one call so the caller (top-level + inner-ix loops) is
/// just a `if let Some(parsed) = ...` filter.  Returns `None` for any
/// ix whose program isn't SPL Token v1 OR isn't a `Transfer` (3) /
/// `TransferChecked` (12).
fn parse_if_token_transfer(
    program_id_index: u8,
    data: &[u8],
    accounts: &[u8],
    combined_keys: &[Address],
    pre_balances: &[TransactionTokenBalance],
    post_balances: &[TransactionTokenBalance],
) -> Option<ParsedTransfer> {
    let program_id = combined_keys.get(program_id_index as usize)?;
    if program_id != &*SPL_TOKEN_V1_PROGRAM_ID {
        return None;
    }
    parse_token_transfer_ix(data, accounts, combined_keys, pre_balances, post_balances)
}

/// Parse a single SPL Token v1 ix.  Returns `None` for any ix that
/// isn't a `Transfer` (3) or `TransferChecked` (12), or whose
/// arguments / token-balance-meta lookup can't be resolved.
fn parse_token_transfer_ix(
    data: &[u8],
    accounts: &[u8],
    combined_keys: &[Address],
    pre_balances: &[TransactionTokenBalance],
    post_balances: &[TransactionTokenBalance],
) -> Option<ParsedTransfer> {
    if data.is_empty() {
        return None;
    }
    let disc = data[0];

    match disc {
        spl_token_ix::TRANSFER => {
            // Transfer { amount: u64 } accounts: [src, dst, authority]
            if data.len() < 9 {
                return None;
            }
            let amount = u64::from_le_bytes(data[1..9].try_into().ok()?);
            let src_idx = *accounts.first()?;
            let dst_idx = *accounts.get(1)?;
            let src_token = *combined_keys.get(src_idx as usize)?;
            let dst_token = *combined_keys.get(dst_idx as usize)?;

            // Lookup mint, owner, decimals from pre_balances (or post for dst
            // if it was newly created in this tx).
            let src_bal = find_balance(src_idx, pre_balances)
                .or_else(|| find_balance(src_idx, post_balances))?;
            let dst_bal = find_balance(dst_idx, post_balances)
                .or_else(|| find_balance(dst_idx, pre_balances))?;

            Some(ParsedTransfer {
                from_owner: parse_address(&src_bal.owner)?,
                to_owner: parse_address(&dst_bal.owner)?,
                from_token_account: Some(src_token),
                to_token_account: Some(dst_token),
                mint: parse_address(&src_bal.mint)?,
                amount,
                decimals: src_bal.ui_token_amount.decimals,
            })
        }
        spl_token_ix::TRANSFER_CHECKED => {
            // TransferChecked { amount: u64, decimals: u8 }
            // accounts: [src, mint, dst, authority]
            if data.len() < 10 {
                return None;
            }
            let amount = u64::from_le_bytes(data[1..9].try_into().ok()?);
            let decimals = data[9];
            let src_idx = *accounts.first()?;
            let mint_idx = *accounts.get(1)?;
            let dst_idx = *accounts.get(2)?;
            let src_token = *combined_keys.get(src_idx as usize)?;
            let mint_pub = *combined_keys.get(mint_idx as usize)?;
            let dst_token = *combined_keys.get(dst_idx as usize)?;

            // Owner via balances; mint already known from ix.
            let src_bal = find_balance(src_idx, pre_balances)
                .or_else(|| find_balance(src_idx, post_balances))?;
            let dst_bal = find_balance(dst_idx, post_balances)
                .or_else(|| find_balance(dst_idx, pre_balances))?;

            Some(ParsedTransfer {
                from_owner: parse_address(&src_bal.owner)?,
                to_owner: parse_address(&dst_bal.owner)?,
                from_token_account: Some(src_token),
                to_token_account: Some(dst_token),
                mint: mint_pub,
                amount,
                decimals,
            })
        }
        _ => None,
    }
}

fn find_balance(
    idx: u8,
    balances: &[TransactionTokenBalance],
) -> Option<&TransactionTokenBalance> {
    balances.iter().find(|b| b.account_index == idx)
}

/// `TransactionTokenBalance.owner` and `.mint` are base58 strings in
/// the public RPC representation.  Parse to the binary `Address` once
/// here so the rest of the pipeline stays binary.
fn parse_address(s: &str) -> Option<Address> {
    Address::from_str(s).ok()
}

fn pending_to_row(p: PendingTransfer, slot: u64, ts: u32) -> TokenTransfer {
    TokenTransfer {
        from_owner: p.from_owner,
        to_owner: p.to_owner,
        from_token_account: p.from_token_account,
        to_token_account: p.to_token_account,
        mint: p.mint,
        amount: p.amount,
        fee_amount: p.fee_amount,
        decimals: p.decimals,
        slot,
        tx_index: p.tx_index,
        instr_index: p.instr_index,
        inner_index: p.inner_index,
        transfer_type: p.transfer_type,
        signature: p.signature,
        block_time: ts,
    }
}

async fn write_rows(
    db: Arc<Client>,
    rows: Vec<TokenTransfer>,
) -> Result<(), clickhouse::error::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut insert = db.insert::<TokenTransfer>("token_transfers").await?;
    for row in rows {
        insert.write(&row).await?;
    }
    insert.end().await
}

fn clamp_block_time(block_time: Option<i64>) -> u32 {
    let t = block_time.unwrap_or(0);
    if t < 0 {
        0
    } else if t > u32::MAX as i64 {
        u32::MAX
    } else {
        t as u32
    }
}
