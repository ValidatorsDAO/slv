//! `getTransfersByAddress` — per-address token-transfer index backed
//! by the `token_transfers` ClickHouse table (and its `_by_to`
//! materialised view) emitted by the `slv_transfers_plugin`
//! jetstreamer plugin.
//!
//! Wire-shape parity target: byte-for-byte identical to the Deno
//! handler at `api/rpc-gateway/src/handlers/transfers.ts`.
//!
//! Highlights:
//!
//! - `direction = out` queries the primary table sorted by `from_owner`;
//!   `direction = in` queries the materialised view sorted by `to_owner`;
//!   `direction = any` (default) UNION DISTINCTs both halves.
//! - `solMode = merged` (default) is an output-time transform: rows
//!   whose mint is wSOL are surfaced with `mint = null` and `type =
//!   transfer` so wallet UX matches native SOL.  `wrap` / `unwrap`
//!   types collapse to `transfer` in that mode too.
//! - 5-tuple pagination cursor `<slot>:<txIdx>:<instrIdx>:<innerInstrIdx>:<type>`.
//!   `innerInstrIdx` is accepted as signed (= -1 for top-level legacy
//!   tokens).
//! - `windowStart` is cached per-process for 60 s.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

use crate::clickhouse::{quote_string, ClickHouseClient};

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 100;
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
/// Base58 of 32 zero bytes — the sentinel `from_owner` / `to_owner`
/// used for mint / burn / withdrawWithheldFee rows where there is no
/// real counterparty.  Surfaced to clients as `null` to keep the JSON
/// shape clean.
const ZERO_PUBKEY_B58: &str = "11111111111111111111111111111111";
const WINDOW_CACHE_TTL: Duration = Duration::from_secs(60);

/// Enum mapping for the `transfer_type` UInt8 column.  Index 0 is
/// reserved so the 1..7 values map directly to their string names.
/// Keep in sync with `slv_transfers_plugin`'s `CREATE TABLE` enum.
const TRANSFER_TYPE_NAMES: &[&str] = &[
    "_unknown",
    "transfer",
    "mint",
    "burn",
    "wrap",
    "unwrap",
    "changeOwner",
    "withdrawWithheldFee",
];

static BASE58_PUBKEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$").unwrap());

pub struct TransfersHandlers {
    ch: Arc<ClickHouseClient>,
    window_start_cache: Mutex<Option<(Instant, Option<u64>)>>,
}

impl TransfersHandlers {
    pub fn new(ch: Arc<ClickHouseClient>) -> Self {
        Self {
            ch,
            window_start_cache: Mutex::new(None),
        }
    }

    pub async fn handle(&self, params: &Option<Value>) -> Result<Value, String> {
        let (address, options) = parse_params(params)?;

        let direction = options
            .get("direction")
            .map(|v| as_string(v, "direction"))
            .transpose()?
            .unwrap_or_else(|| "any".into());
        if direction != "in" && direction != "out" && direction != "any" {
            return Err(r#"invalid direction: expected "in" | "out" | "any""#.into());
        }

        let sort_order = options
            .get("sortOrder")
            .map(|v| as_string(v, "sortOrder"))
            .transpose()?
            .unwrap_or_else(|| "desc".into());
        if sort_order != "desc" && sort_order != "asc" {
            return Err(r#"invalid sortOrder: expected "desc" or "asc""#.into());
        }
        let desc = sort_order == "desc";

        let limit = match options.get("limit") {
            Some(v) => as_int(v, "limit")?.min(MAX_LIMIT),
            None => DEFAULT_LIMIT.min(MAX_LIMIT),
        };
        if limit == 0 {
            let window_start = self.get_window_start().await;
            return Ok(json!({
                "data": [],
                "paginationToken": Value::Null,
                "windowStart": window_start,
            }));
        }

        let sol_mode = options
            .get("solMode")
            .map(|v| as_string(v, "solMode"))
            .transpose()?
            .unwrap_or_else(|| "merged".into());
        if sol_mode != "merged" && sol_mode != "separate" {
            return Err(r#"invalid solMode: expected "merged" or "separate""#.into());
        }

        if let Some(c_v) = options.get("commitment") {
            let c = as_string(c_v, "commitment")?;
            if c != "finalized" && c != "confirmed" {
                return Err(
                    r#"invalid commitment: expected "finalized" or "confirmed""#.into(),
                );
            }
        }

        let with_counterparty = options
            .get("with")
            .map(|v| as_base58_pubkey(v, "with"))
            .transpose()?;

        let mut where_predicates = Vec::<String>::new();
        if let Some(mint_v) = options.get("mint") {
            let mint = as_base58_pubkey(mint_v, "mint")?;
            where_predicates.push(format!("mint = base58Decode({})", quote_string(&mint)));
        }

        if let Some(filters) = options.get("filters") {
            apply_filters(filters, &mut where_predicates)?;
        }

        let mut cursor_predicate = String::new();
        if let Some(tok_v) = options.get("paginationToken") {
            let s = as_string(tok_v, "paginationToken")?;
            let cur = parse_pagination_token(&s)?;
            let op = if desc { "<" } else { ">" };
            cursor_predicate = format!(
                "(slot, tx_index, instr_index, inner_index) {op} ({}, {}, {}, {})",
                cur.slot, cur.tx_idx, cur.instr_idx, cur.inner_instr_idx,
            );
        }

        let order_dir = if desc { "DESC" } else { "ASC" };
        let projection = r#"
            base58Encode(signature) AS signature,
            slot,
            block_time,
            transfer_type,
            base58Encode(from_owner) AS from_owner,
            base58Encode(to_owner) AS to_owner,
            if(isNotNull(from_token_account), base58Encode(from_token_account), NULL) AS from_token_account,
            if(isNotNull(to_token_account), base58Encode(to_token_account), NULL) AS to_token_account,
            base58Encode(mint) AS mint,
            toString(amount) AS amount,
            toString(fee_amount) AS fee_amount,
            decimals,
            tx_index,
            instr_index,
            inner_index
        "#;

        let build_select = |dir: &str| -> String {
            let table_and_addr = if dir == "out" {
                format!(
                    "FROM token_transfers WHERE from_owner = base58Decode({})",
                    quote_string(&address),
                )
            } else {
                format!(
                    "FROM token_transfers_by_to WHERE to_owner = base58Decode({})",
                    quote_string(&address),
                )
            };
            let counterparty_predicate = match with_counterparty.as_deref() {
                Some(cp) => {
                    if dir == "out" {
                        format!("AND to_owner = base58Decode({})", quote_string(cp))
                    } else {
                        format!("AND from_owner = base58Decode({})", quote_string(cp))
                    }
                }
                None => String::new(),
            };
            let where_part = if !where_predicates.is_empty() {
                format!("AND {}", where_predicates.join(" AND "))
            } else {
                String::new()
            };
            let cursor_part = if !cursor_predicate.is_empty() {
                format!("AND {cursor_predicate}")
            } else {
                String::new()
            };
            format!("{table_and_addr} {counterparty_predicate} {where_part} {cursor_part}")
        };

        let fetch = limit + 1;
        let sql = match direction.as_str() {
            "out" => format!(
                r#"
                SELECT {projection}
                {sel}
                ORDER BY slot {order_dir}, tx_index {order_dir}, instr_index {order_dir}, inner_index {order_dir}
                LIMIT {fetch}
                "#,
                sel = build_select("out"),
            ),
            "in" => format!(
                r#"
                SELECT {projection}
                {sel}
                ORDER BY slot {order_dir}, tx_index {order_dir}, instr_index {order_dir}, inner_index {order_dir}
                LIMIT {fetch}
                "#,
                sel = build_select("in"),
            ),
            _ => format!(
                // UNION DISTINCT dedupes the rare self-transfer (from ==
                // to) case where both tables emit the same row.
                r#"
                SELECT {projection} FROM (
                    SELECT * {out_sel}
                    UNION DISTINCT
                    SELECT * {in_sel}
                )
                ORDER BY slot {order_dir}, tx_index {order_dir}, instr_index {order_dir}, inner_index {order_dir}
                LIMIT {fetch}
                "#,
                out_sel = build_select("out"),
                in_sel = build_select("in"),
            ),
        };

        let mut rows: Vec<RawRow> = self.ch.query(&sql).await.map_err(|e| e.to_string())?;
        let pagination_token = if rows.len() as i64 > limit {
            let sentinel = &rows[limit as usize];
            let tok = encode_pagination_token(sentinel);
            rows.truncate(limit as usize);
            Some(tok)
        } else {
            None
        };

        let data: Vec<Value> = rows.iter().map(|r| raw_row_to_entry(r, &sol_mode)).collect();
        let window_start = self.get_window_start().await;
        Ok(json!({
            "data": data,
            "paginationToken": pagination_token,
            "windowStart": window_start,
        }))
    }

    async fn get_window_start(&self) -> Option<u64> {
        {
            let cache = self.window_start_cache.lock();
            if let Some((refreshed, value)) = cache.as_ref() {
                if refreshed.elapsed() < WINDOW_CACHE_TTL {
                    return *value;
                }
            }
        }
        let value = self.fetch_window_start().await;
        *self.window_start_cache.lock() = Some((Instant::now(), value));
        value
    }

    async fn fetch_window_start(&self) -> Option<u64> {
        #[derive(Deserialize)]
        struct Row {
            min_slot: Option<String>,
        }
        match self
            .ch
            .query::<Row>("SELECT toString(min(slot)) AS min_slot FROM token_transfers")
            .await
        {
            Ok(rows) => rows.into_iter().next().and_then(|r| {
                let raw = r.min_slot?;
                if raw == r"\N" { return None; }
                let n: u64 = raw.parse().ok()?;
                if n == 0 { None } else { Some(n) }
            }),
            Err(_) => None,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
struct RawRow {
    signature: String,
    slot: u64,
    block_time: u64,
    /// ClickHouse JSONEachRow returns UInt8 as number.  `transfer_type`
    /// is intentionally received as a string so the Deno helper's
    /// `parseInt(...)` parity is exact — both implementations index
    /// into `TRANSFER_TYPE_NAMES` after parsing.
    transfer_type: serde_json::Value,
    from_owner: String,
    to_owner: String,
    from_token_account: Option<String>,
    to_token_account: Option<String>,
    mint: String,
    /// `toString(amount)` keeps u64 precision intact across JSON.
    amount: String,
    fee_amount: String,
    decimals: u8,
    tx_index: u64,
    instr_index: i64,
    inner_index: i64,
}

#[derive(Debug)]
struct Cursor {
    slot: u64,
    tx_idx: u64,
    instr_idx: i64,
    inner_instr_idx: i64,
}

fn parse_pagination_token(s: &str) -> Result<Cursor, String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 5 {
        return Err(
            r#"invalid paginationToken: expected "<slot>:<txIdx>:<instrIdx>:<innerInstrIdx>:<type>""#
                .into(),
        );
    }
    let slot: u64 = parts[0]
        .parse()
        .map_err(|_| "invalid paginationToken.slot".to_string())?;
    let tx_idx: u64 = parts[1]
        .parse()
        .map_err(|_| "invalid paginationToken.txIdx".to_string())?;
    let instr_idx: i64 = parts[2]
        .parse()
        .map_err(|_| "invalid paginationToken.instrIdx".to_string())?;
    // innerInstrIdx accepts -1 (= top-level legacy) and signed semantics
    // for tuple comparison; match the Deno handler's `parseInt` behaviour.
    let inner_instr_idx: i64 = parts[3]
        .parse()
        .map_err(|_| "invalid paginationToken.innerInstrIdx".to_string())?;
    let type_name = parts[4];
    if !TRANSFER_TYPE_NAMES[1..].contains(&type_name) {
        return Err(format!("invalid paginationToken.type: {type_name}"));
    }
    Ok(Cursor { slot, tx_idx, instr_idx, inner_instr_idx })
}

fn encode_pagination_token(r: &RawRow) -> String {
    let type_idx = transfer_type_index(&r.transfer_type);
    let type_name = TRANSFER_TYPE_NAMES
        .get(type_idx as usize)
        .copied()
        .unwrap_or("transfer");
    format!(
        "{}:{}:{}:{}:{}",
        r.slot, r.tx_index, r.instr_index, r.inner_index, type_name,
    )
}

fn transfer_type_index(v: &Value) -> u8 {
    match v {
        Value::Number(n) => n.as_u64().map(|n| n as u8).unwrap_or(1),
        Value::String(s) => s.parse::<u8>().unwrap_or(1),
        _ => 1,
    }
}

fn raw_row_to_entry(r: &RawRow, sol_mode: &str) -> Value {
    let type_idx = transfer_type_index(&r.transfer_type);
    let transfer_type = TRANSFER_TYPE_NAMES
        .get(type_idx as usize)
        .copied()
        .unwrap_or("transfer");

    // Sentinel-zero from_owner/to_owner means "no counterparty" (mint/burn etc.)
    let from_user_account = if r.from_owner == ZERO_PUBKEY_B58 {
        Value::Null
    } else {
        Value::String(r.from_owner.clone())
    };
    let to_user_account = if r.to_owner == ZERO_PUBKEY_B58 {
        Value::Null
    } else {
        Value::String(r.to_owner.clone())
    };

    // solMode=merged: wSOL → native SOL representation.  wrap/unwrap
    // collapse to transfer since the merged view hides the wrapping.
    let (mint, display_type): (Value, &str) = if sol_mode == "merged" && r.mint == WSOL_MINT {
        let dt = if transfer_type == "wrap" || transfer_type == "unwrap" {
            "transfer"
        } else {
            transfer_type
        };
        (Value::Null, dt)
    } else {
        (Value::String(r.mint.clone()), transfer_type)
    };

    let fee_present = r.fee_amount != "0";
    let fee_amount: Value = if fee_present {
        Value::String(r.fee_amount.clone())
    } else {
        Value::Null
    };
    let fee_ui_amount: Value = if fee_present {
        Value::String(format_ui_amount(&r.fee_amount, r.decimals))
    } else {
        Value::Null
    };

    json!({
        "signature": r.signature,
        "slot": r.slot,
        "blockTime": r.block_time,
        "type": display_type,
        "fromUserAccount": from_user_account,
        "toUserAccount": to_user_account,
        "fromTokenAccount": r.from_token_account.clone().map(Value::String).unwrap_or(Value::Null),
        "toTokenAccount": r.to_token_account.clone().map(Value::String).unwrap_or(Value::Null),
        "mint": mint,
        "amount": r.amount,
        "decimals": r.decimals,
        "uiAmount": format_ui_amount(&r.amount, r.decimals),
        "feeAmount": fee_amount,
        "feeUiAmount": fee_ui_amount,
        "confirmationStatus": "finalized",
        "transactionIdx": r.tx_index,
        "instructionIdx": r.instr_index,
        "innerInstructionIdx": r.inner_index,
    })
}

/// `amount` (numeric string) × 10^-decimals → UI-formatted string,
/// matches the Deno helper character-for-character to preserve
/// wire-shape parity (no `.0` suffix, trailing zeros stripped).
fn format_ui_amount(amount: &str, decimals: u8) -> String {
    if decimals == 0 {
        return amount.to_owned();
    }
    let decimals = decimals as usize;
    let padded = if amount.len() < decimals + 1 {
        let mut s = String::with_capacity(decimals + 1);
        for _ in 0..(decimals + 1 - amount.len()) {
            s.push('0');
        }
        s.push_str(amount);
        s
    } else {
        amount.to_owned()
    };
    let split_at = padded.len() - decimals;
    let int_part = &padded[..split_at];
    let frac_part = padded[split_at..].trim_end_matches('0');
    if frac_part.is_empty() {
        int_part.to_owned()
    } else {
        format!("{int_part}.{frac_part}")
    }
}

fn parse_params(params: &Option<Value>) -> Result<(String, Map<String, Value>), String> {
    match params {
        Some(Value::Array(arr)) => {
            if arr.is_empty() {
                return Err("missing address (first positional param)".into());
            }
            let address = as_base58_pubkey(&arr[0], "address")?;
            let options = match arr.get(1) {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(m)) => m.clone(),
                _ => return Err("invalid options: expected object".into()),
            };
            Ok((address, options))
        }
        Some(Value::Object(m)) => {
            let address_v = m.get("address").ok_or("missing address")?;
            let address = as_base58_pubkey(address_v, "address")?;
            Ok((address, m.clone()))
        }
        _ => Err("missing params".into()),
    }
}

fn apply_filters(raw: &Value, where_predicates: &mut Vec<String>) -> Result<(), String> {
    let Value::Object(filters) = raw else {
        return Err("invalid filters: expected object".into());
    };
    if let Some(v) = filters.get("amount") {
        where_predicates.extend(cmp_to_sql("amount", &parse_cmp(v, "filters.amount")?));
    }
    if let Some(v) = filters.get("blockTime") {
        where_predicates.extend(cmp_to_sql("block_time", &parse_cmp(v, "filters.blockTime")?));
    }
    if let Some(v) = filters.get("slot") {
        where_predicates.extend(cmp_to_sql("slot", &parse_cmp(v, "filters.slot")?));
    }
    Ok(())
}

#[derive(Debug, Default)]
struct Cmp {
    gt: Option<i64>,
    gte: Option<i64>,
    lt: Option<i64>,
    lte: Option<i64>,
}

fn parse_cmp(raw: &Value, name: &str) -> Result<Cmp, String> {
    let Value::Object(o) = raw else {
        return Err(format!(
            "invalid {name}: expected object with gt/gte/lt/lte",
        ));
    };
    let mut cmp = Cmp::default();
    let mut any = false;
    for (k, target) in [
        ("gt", &mut cmp.gt),
        ("gte", &mut cmp.gte),
        ("lt", &mut cmp.lt),
        ("lte", &mut cmp.lte),
    ] {
        if let Some(v) = o.get(k) {
            *target = Some(as_int(v, &format!("{name}.{k}"))?);
            any = true;
        }
    }
    if !any {
        return Err(format!(
            "invalid {name}: at least one of gt/gte/lt/lte required",
        ));
    }
    Ok(cmp)
}

fn cmp_to_sql(col: &str, cmp: &Cmp) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = cmp.gt {
        out.push(format!("{col} > {v}"));
    }
    if let Some(v) = cmp.gte {
        out.push(format!("{col} >= {v}"));
    }
    if let Some(v) = cmp.lt {
        out.push(format!("{col} < {v}"));
    }
    if let Some(v) = cmp.lte {
        out.push(format!("{col} <= {v}"));
    }
    out
}

fn as_string(v: &Value, name: &str) -> Result<String, String> {
    match v {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        _ => Err(format!("missing {name}")),
    }
}

fn as_int(v: &Value, name: &str) -> Result<i64, String> {
    let n = match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
    .ok_or_else(|| format!("invalid {name}: expected non-negative integer"))?;
    if n < 0 {
        return Err(format!("invalid {name}: expected non-negative integer"));
    }
    Ok(n)
}

fn as_base58_pubkey(v: &Value, name: &str) -> Result<String, String> {
    let s = as_string(v, name)?;
    if BASE58_PUBKEY_RE.is_match(&s) {
        Ok(s)
    } else {
        Err(format!("invalid {name}: not a valid base58 pubkey"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_ui_amount_zero_decimals_returns_input() {
        assert_eq!(format_ui_amount("123", 0), "123");
    }

    #[test]
    fn format_ui_amount_shifts_decimal_point() {
        // 1_000_000 lamports with 6 decimals = 1.000000 → trimmed to "1"
        assert_eq!(format_ui_amount("1000000", 6), "1");
        // 12345 with 4 decimals = 1.2345
        assert_eq!(format_ui_amount("12345", 4), "1.2345");
        // 1 with 9 decimals = 0.000000001
        assert_eq!(format_ui_amount("1", 9), "0.000000001");
        // Trailing zeros stripped: 12300 / 4 → 1.23
        assert_eq!(format_ui_amount("12300", 4), "1.23");
    }

    #[test]
    fn pagination_token_round_trip() {
        let tok = "12345:67:8:0:transfer";
        let cur = parse_pagination_token(tok).unwrap();
        assert_eq!(cur.slot, 12345);
        assert_eq!(cur.tx_idx, 67);
        assert_eq!(cur.instr_idx, 8);
        assert_eq!(cur.inner_instr_idx, 0);
    }

    #[test]
    fn pagination_token_accepts_minus_one_inner() {
        let cur = parse_pagination_token("100:0:0:-1:mint").unwrap();
        assert_eq!(cur.inner_instr_idx, -1);
    }

    #[test]
    fn pagination_token_rejects_unknown_type() {
        let err = parse_pagination_token("1:2:3:0:bogus").unwrap_err();
        assert!(err.contains("invalid paginationToken.type"));
    }

    #[test]
    fn pagination_token_rejects_wrong_arity() {
        assert!(parse_pagination_token("1:2:3:4").is_err());
        assert!(parse_pagination_token("1:2:3:4:5:6").is_err());
    }

    #[test]
    fn cmp_emits_each_operator_in_order() {
        let cmp = parse_cmp(&json!({ "gt": 1, "gte": 2, "lt": 9, "lte": 8 }), "filters.amount")
            .unwrap();
        let sql = cmp_to_sql("amount", &cmp);
        assert_eq!(sql.len(), 4);
        assert!(sql[0].ends_with("> 1"));
        assert!(sql[1].ends_with(">= 2"));
        assert!(sql[2].ends_with("< 9"));
        assert!(sql[3].ends_with("<= 8"));
    }

    #[test]
    fn cmp_rejects_empty() {
        let err = parse_cmp(&json!({}), "filters.amount").unwrap_err();
        assert!(err.contains("at least one of"));
    }

    #[test]
    fn sentinel_zero_owner_emits_null_user_account() {
        let r = make_raw_row("So11111111111111111111111111111111111111112", ZERO_PUBKEY_B58, "addr");
        let entry = raw_row_to_entry(&r, "merged");
        assert!(entry.get("fromUserAccount").unwrap().is_null());
        assert_eq!(entry.get("toUserAccount").unwrap(), "addr");
    }

    #[test]
    fn merged_mode_converts_wsol_mint_to_null() {
        let r = make_raw_row(WSOL_MINT, "from", "to");
        let entry = raw_row_to_entry(&r, "merged");
        assert!(entry.get("mint").unwrap().is_null());
        assert_eq!(entry.get("type").unwrap(), "transfer");
    }

    #[test]
    fn separate_mode_keeps_wsol_mint() {
        let r = make_raw_row(WSOL_MINT, "from", "to");
        let entry = raw_row_to_entry(&r, "separate");
        assert_eq!(entry.get("mint").unwrap(), WSOL_MINT);
    }

    #[test]
    fn merged_collapses_wrap_unwrap_to_transfer_for_wsol() {
        let mut r = make_raw_row(WSOL_MINT, "from", "to");
        r.transfer_type = json!(4); // wrap
        let entry = raw_row_to_entry(&r, "merged");
        assert_eq!(entry.get("type").unwrap(), "transfer");
        r.transfer_type = json!(5); // unwrap
        let entry = raw_row_to_entry(&r, "merged");
        assert_eq!(entry.get("type").unwrap(), "transfer");
    }

    #[test]
    fn fee_zero_emits_nulls() {
        let r = make_raw_row("So11111111111111111111111111111111111111112", "from", "to");
        let entry = raw_row_to_entry(&r, "separate");
        assert!(entry.get("feeAmount").unwrap().is_null());
        assert!(entry.get("feeUiAmount").unwrap().is_null());
    }

    fn make_raw_row(mint: &str, from_owner: &str, to_owner: &str) -> RawRow {
        RawRow {
            signature: "sig".into(),
            slot: 1,
            block_time: 2,
            transfer_type: json!(1),
            from_owner: from_owner.into(),
            to_owner: to_owner.into(),
            from_token_account: None,
            to_token_account: None,
            mint: mint.into(),
            amount: "1000000".into(),
            fee_amount: "0".into(),
            decimals: 9,
            tx_index: 3,
            instr_index: 4,
            inner_index: -1,
        }
    }
}
