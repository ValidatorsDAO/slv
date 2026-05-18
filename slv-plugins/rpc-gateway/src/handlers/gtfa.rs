//! `getTransactionsForAddress` — per-address transaction-index method
//! backed by the `gtfa_tx_mentions` ClickHouse table emitted by the
//! `slv_gtfa_plugin` jetstreamer plugin.
//!
//! Two modes (driven by the `transactionDetails` option):
//!
//! - `signatures`: pure index lookup, returns one row per matching tx
//!   with `signature`, `slot`, `transactionIndex`, `blockTime`, `err`
//!   (= `null` on success, `{ unknown: true }` placeholder on failure),
//!   `memo` (always `null` until the plugin extracts it), and a fixed
//!   `confirmationStatus: "finalized"`.
//!
//! - `full`: same index lookup, then a per-signature `getTransaction`
//!   fan-out to the upstream `of1` with a configurable concurrency cap.
//!   Each entry additionally carries the `transaction`, `meta`, `version`
//!   fields from `of1`; failed lookups still appear with those set to
//!   `null` and an `error: "<msg>"` so the caller can retry that one.
//!
//! Wire-shape parity target: byte-for-byte identical to the Deno
//! handler at `api/rpc-gateway/src/handlers/gtfa.ts`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use parking_lot::Mutex;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

use crate::clickhouse::{quote_string, ClickHouseClient};
use crate::of1::{Of1Client, Of1Error};

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT_SIGNATURES: i64 = 1000;
const MAX_LIMIT_FULL: i64 = 100;
const WINDOW_CACHE_TTL: Duration = Duration::from_secs(60);

const VALID_ENCODINGS: &[&str] = &["json", "jsonParsed", "base64", "base58"];
const FULL_MODE_SUPPORTED_ENCODINGS: &[&str] = &["json", "base64", "base58"];

static BASE58_PUBKEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$").unwrap());
static BASE58_SIG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[1-9A-HJ-NP-Za-km-z]{64,88}$").unwrap());

pub struct GtfaHandlers {
    ch: Arc<ClickHouseClient>,
    of1: Arc<Of1Client>,
    full_concurrency: usize,
    /// `(refreshed_at, value)` — refreshed at most once per
    /// `WINDOW_CACHE_TTL`.  `value = None` when CH is unreachable or
    /// the table is empty.
    window_start_cache: Mutex<Option<(Instant, Option<u64>)>>,
}

impl GtfaHandlers {
    pub fn new(ch: Arc<ClickHouseClient>, of1: Arc<Of1Client>, full_concurrency: usize) -> Self {
        Self {
            ch,
            of1,
            full_concurrency: full_concurrency.max(1),
            window_start_cache: Mutex::new(None),
        }
    }

    pub async fn handle(&self, params: &Option<Value>) -> Result<Value, String> {
        let (address, options) = parse_params(params)?;

        let transaction_details = options
            .get("transactionDetails")
            .map(|v| as_string(v, "transactionDetails"))
            .transpose()?
            .unwrap_or_else(|| "signatures".to_owned());
        if transaction_details != "signatures" && transaction_details != "full" {
            return Err(r#"invalid transactionDetails: expected "signatures" or "full""#.into());
        }
        let full_mode = transaction_details == "full";

        let mut encoding: String = "json".into();
        if let Some(v) = options.get("encoding") {
            let e = as_string(v, "encoding")?;
            if !VALID_ENCODINGS.contains(&e.as_str()) {
                return Err(format!(
                    "invalid encoding: expected one of {}",
                    VALID_ENCODINGS.join(", "),
                ));
            }
            encoding = e;
        }
        if full_mode && !FULL_MODE_SUPPORTED_ENCODINGS.contains(&encoding.as_str()) {
            return Err(format!(
                "encoding=\"{encoding}\" not yet supported; full mode supports {}",
                FULL_MODE_SUPPORTED_ENCODINGS.join(", "),
            ));
        }

        let max_supported_transaction_version = options
            .get("maxSupportedTransactionVersion")
            .map(|v| as_int(v, "maxSupportedTransactionVersion"))
            .transpose()?
            .unwrap_or(0);

        let sort_order = options
            .get("sortOrder")
            .map(|v| as_string(v, "sortOrder"))
            .transpose()?
            .unwrap_or_else(|| "desc".into());
        if sort_order != "desc" && sort_order != "asc" {
            return Err(r#"invalid sortOrder: expected "desc" or "asc""#.into());
        }
        let desc = sort_order == "desc";

        let max_limit = if full_mode { MAX_LIMIT_FULL } else { MAX_LIMIT_SIGNATURES };
        let limit = match options.get("limit") {
            Some(v) => as_int(v, "limit")?.min(max_limit),
            None => DEFAULT_LIMIT.min(max_limit),
        };
        if limit == 0 {
            let window_start = self.get_window_start().await;
            return Ok(json!({
                "data": [],
                "paginationToken": Value::Null,
                "windowStart": window_start,
            }));
        }

        let mut where_clauses = vec![
            format!("pubkey = base58Decode({})", quote_string(&address)),
        ];

        if let Some(filters) = options.get("filters") {
            apply_filters(filters, &mut where_clauses)?;
        }

        if let Some(tok_v) = options.get("paginationToken") {
            let tok_s = as_string(tok_v, "paginationToken")?;
            let (tok_slot, tok_tx) = parse_pagination_token(&tok_s)?;
            if desc {
                where_clauses.push(format!(
                    "(slot < {tok_slot} OR (slot = {tok_slot} AND transaction_index < {tok_tx}))",
                ));
            } else {
                where_clauses.push(format!(
                    "(slot > {tok_slot} OR (slot = {tok_slot} AND transaction_index > {tok_tx}))",
                ));
            }
        }

        if let Some(c_v) = options.get("commitment") {
            let c = as_string(c_v, "commitment")?;
            if c != "finalized" && c != "confirmed" {
                return Err(r#"invalid commitment: expected "finalized" or "confirmed""#.into());
            }
        }

        let order_dir = if desc { "DESC" } else { "ASC" };
        // Subquery isolates the WHERE clause from the SELECT
        // projection so `pubkey = base58Decode(...)` keeps comparing
        // raw FixedString columns rather than the outer-SELECT alias
        // strings — same trap-avoidance pattern as the Deno handler.
        let sql = format!(
            r#"
            SELECT
                base58Encode(signature) AS signature,
                slot,
                transaction_index AS transactionIndex,
                block_time AS blockTime,
                if(status = 1, 'succeeded', 'failed') AS status
            FROM (
                SELECT signature, slot, transaction_index, block_time, status
                FROM gtfa_tx_mentions
                WHERE {where_join}
                ORDER BY slot {order_dir}, transaction_index {order_dir}
                LIMIT {fetch}
            )
            ORDER BY slot {order_dir}, transaction_index {order_dir}
            "#,
            where_join = where_clauses.join(" AND "),
            fetch = limit + 1,
        );

        let mut rows: Vec<SigRow> = self.ch.query(&sql).await.map_err(|e| e.to_string())?;

        let pagination_token = if rows.len() as i64 > limit {
            let sentinel = &rows[limit as usize];
            let tok = format!("{}:{}", sentinel.slot, sentinel.transaction_index);
            rows.truncate(limit as usize);
            Some(tok)
        } else {
            None
        };

        let window_start = self.get_window_start().await;

        if !full_mode {
            let data: Vec<Value> = rows.iter().map(sig_row_to_entry).collect();
            return Ok(json!({
                "data": data,
                "paginationToken": pagination_token,
                "windowStart": window_start,
            }));
        }

        // Full mode — fan out to of1 with the configured concurrency cap.
        let of1 = self.of1.clone();
        let encoding_owned = encoding.clone();
        let max_ver = max_supported_transaction_version;
        let raw: Vec<(usize, SigRow, Result<crate::of1::TxFetch, Of1Error>)> =
            stream::iter(rows.into_iter().enumerate())
                .map(|(idx, row)| {
                    let of1 = of1.clone();
                    let encoding = encoding_owned.clone();
                    async move {
                        let fetched = of1
                            .get_transaction(&row.signature, &encoding, max_ver)
                            .await;
                        (idx, row, fetched)
                    }
                })
                .buffer_unordered(self.full_concurrency)
                .collect()
                .await;
        let mut fetched_sorted: Vec<FullRow> = raw
            .into_iter()
            .map(|(idx, row, fetched)| match fetched {
                Ok(tx) => FullRow {
                    idx,
                    row,
                    transaction: tx.transaction,
                    meta: tx.meta,
                    version: tx.version,
                    error: None,
                },
                Err(e) => FullRow {
                    idx,
                    row,
                    transaction: Value::Null,
                    meta: Value::Null,
                    version: Value::Null,
                    error: Some(of1_error_message(e)),
                },
            })
            .collect();
        fetched_sorted.sort_by_key(|r| r.idx);
        let data: Vec<Value> = fetched_sorted.iter().map(full_row_to_entry).collect();
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
            .query::<Row>("SELECT toString(min(slot)) AS min_slot FROM gtfa_tx_mentions")
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
struct SigRow {
    signature: String,
    slot: u64,
    #[serde(rename = "transactionIndex")]
    transaction_index: u64,
    #[serde(rename = "blockTime")]
    block_time: u64,
    status: String,
}

struct FullRow {
    idx: usize,
    row: SigRow,
    transaction: Value,
    meta: Value,
    version: Value,
    error: Option<String>,
}

fn sig_row_to_entry(r: &SigRow) -> Value {
    json!({
        "signature": r.signature,
        "slot": r.slot,
        "transactionIndex": r.transaction_index,
        "err": if r.status == "succeeded" { Value::Null } else { json!({ "unknown": true }) },
        "memo": Value::Null,
        "blockTime": r.block_time,
        "confirmationStatus": "finalized",
    })
}

fn full_row_to_entry(r: &FullRow) -> Value {
    let succeeded = r.row.status == "succeeded";
    let meta_err = match &r.meta {
        Value::Object(m) => m.get("err").cloned(),
        _ => None,
    };
    let err_field = match meta_err {
        Some(v) => v,
        None => {
            if succeeded {
                Value::Null
            } else {
                json!({ "unknown": true })
            }
        }
    };
    let mut out = json!({
        "signature": r.row.signature,
        "slot": r.row.slot,
        "transactionIndex": r.row.transaction_index,
        "err": err_field,
        "memo": Value::Null,
        "blockTime": r.row.block_time,
        "confirmationStatus": "finalized",
        "transaction": r.transaction,
        "meta": r.meta,
        "version": r.version,
    });
    if let Some(e) = &r.error {
        out.as_object_mut().unwrap().insert("error".into(), Value::String(e.clone()));
    }
    out
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

fn parse_pagination_token(s: &str) -> Result<(u64, u64), String> {
    let (a, b) = s
        .split_once(':')
        .ok_or_else(|| r#"invalid paginationToken: expected "<slot>:<txIndex>""#.to_string())?;
    if a.is_empty() {
        return Err(r#"invalid paginationToken: expected "<slot>:<txIndex>""#.into());
    }
    let slot: u64 = a.parse().map_err(|_| "invalid paginationToken.slot".to_string())?;
    let tx: u64 = b.parse().map_err(|_| "invalid paginationToken.txIndex".to_string())?;
    Ok((slot, tx))
}

fn apply_filters(raw: &Value, where_clauses: &mut Vec<String>) -> Result<(), String> {
    let Value::Object(filters) = raw else {
        return Err("invalid filters: expected object".into());
    };
    if let Some(v) = filters.get("slot") {
        let cmp = parse_cmp(v, "filters.slot")?;
        where_clauses.extend(cmp_to_sql("slot", &cmp));
    }
    if let Some(v) = filters.get("blockTime") {
        let cmp = parse_cmp(v, "filters.blockTime")?;
        where_clauses.extend(cmp_to_sql("block_time", &cmp));
    }
    if let Some(v) = filters.get("signature") {
        let Value::Object(sig_obj) = v else {
            return Err("invalid filters.signature: expected object with eq".into());
        };
        let eq = sig_obj
            .get("eq")
            .ok_or("invalid filters.signature: only { eq } supported")?;
        let sig_b58 = as_base58_signature(eq, "filters.signature.eq")?;
        where_clauses.push(format!(
            "signature = base58Decode({})",
            quote_string(&sig_b58),
        ));
    }
    if let Some(v) = filters.get("status") {
        let s = as_string(v, "filters.status")?;
        match s.as_str() {
            "succeeded" => where_clauses.push("status = 1".into()),
            "failed" => where_clauses.push("status = 0".into()),
            "any" => {}
            _ => {
                return Err(
                    r#"invalid filters.status: expected "succeeded" | "failed" | "any""#.into(),
                )
            }
        }
    }
    if let Some(v) = filters.get("tokenAccounts") {
        let s = v.as_str().unwrap_or("");
        if s != "none" {
            return Err(format!(
                "filters.tokenAccounts=\"{s}\" not yet supported; only \"none\" is implemented in this version",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
struct Cmp {
    gte: Option<i64>,
    gt: Option<i64>,
    lte: Option<i64>,
    lt: Option<i64>,
    eq: Option<i64>,
}

fn parse_cmp(raw: &Value, name: &str) -> Result<Cmp, String> {
    let Value::Object(o) = raw else {
        return Err(format!(
            "invalid {name}: expected object with gte/gt/lte/lt/eq",
        ));
    };
    let mut cmp = Cmp::default();
    let mut any = false;
    for (k, target) in [
        ("gte", &mut cmp.gte),
        ("gt", &mut cmp.gt),
        ("lte", &mut cmp.lte),
        ("lt", &mut cmp.lt),
        ("eq", &mut cmp.eq),
    ] {
        if let Some(v) = o.get(k) {
            *target = Some(as_int(v, &format!("{name}.{k}"))?);
            any = true;
        }
    }
    if !any {
        return Err(format!(
            "invalid {name}: at least one of gte/gt/lte/lt/eq required",
        ));
    }
    Ok(cmp)
}

fn cmp_to_sql(col: &str, cmp: &Cmp) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = cmp.eq {
        out.push(format!("{col} = {v}"));
    }
    if let Some(v) = cmp.gte {
        out.push(format!("{col} >= {v}"));
    }
    if let Some(v) = cmp.gt {
        out.push(format!("{col} > {v}"));
    }
    if let Some(v) = cmp.lte {
        out.push(format!("{col} <= {v}"));
    }
    if let Some(v) = cmp.lt {
        out.push(format!("{col} < {v}"));
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

fn as_base58_signature(v: &Value, name: &str) -> Result<String, String> {
    let s = as_string(v, name)?;
    if BASE58_SIG_RE.is_match(&s) {
        Ok(s)
    } else {
        Err(format!("invalid {name}: not a valid base58 signature"))
    }
}

fn of1_error_message(e: Of1Error) -> String {
    match e {
        Of1Error::Http(c) => format!("of1 HTTP {c}"),
        Of1Error::Transport(e) => e.to_string(),
        Of1Error::Rpc(m) => m,
        Of1Error::NotFound => "transaction not found in of1 window".into(),
        Of1Error::Malformed(m) => format!("of1 malformed response: {m}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_params_positional_with_address_only() {
        let p = Some(json!(["PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"]));
        let (addr, opts) = parse_params(&p).unwrap();
        assert_eq!(addr, "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");
        assert!(opts.is_empty());
    }

    #[test]
    fn parse_params_positional_with_options() {
        let p = Some(json!([
            "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
            { "limit": 10 }
        ]));
        let (_, opts) = parse_params(&p).unwrap();
        assert_eq!(opts.get("limit").unwrap().as_i64(), Some(10));
    }

    #[test]
    fn parse_params_object_form() {
        let p = Some(json!({
            "address": "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
            "limit": 5
        }));
        let (addr, opts) = parse_params(&p).unwrap();
        assert!(addr.starts_with("Phoe"));
        assert!(opts.contains_key("address"));
    }

    #[test]
    fn parse_params_rejects_invalid_address() {
        let p = Some(json!(["!!!not-base58!!!"]));
        let err = parse_params(&p).unwrap_err();
        assert!(err.contains("not a valid base58 pubkey"), "got {err:?}");
    }

    #[test]
    fn pagination_token_round_trip() {
        let (slot, tx) = parse_pagination_token("12345:67").unwrap();
        assert_eq!(slot, 12345);
        assert_eq!(tx, 67);
    }

    #[test]
    fn pagination_token_rejects_malformed() {
        assert!(parse_pagination_token("123").is_err());
        assert!(parse_pagination_token(":67").is_err());
        assert!(parse_pagination_token("abc:67").is_err());
    }

    #[test]
    fn cmp_emits_each_operator() {
        let cmp = parse_cmp(&json!({ "gte": 10, "lt": 100 }), "filters.slot").unwrap();
        let sql = cmp_to_sql("slot", &cmp);
        assert!(sql.iter().any(|s| s == "slot >= 10"));
        assert!(sql.iter().any(|s| s == "slot < 100"));
    }

    #[test]
    fn cmp_rejects_empty() {
        let err = parse_cmp(&json!({}), "filters.slot").unwrap_err();
        assert!(err.contains("at least one of"));
    }

    #[test]
    fn sig_row_success_emits_null_err() {
        let r = SigRow {
            signature: "abc".into(),
            slot: 1,
            transaction_index: 2,
            block_time: 3,
            status: "succeeded".into(),
        };
        let entry = sig_row_to_entry(&r);
        assert!(entry.get("err").unwrap().is_null());
        assert_eq!(entry.get("confirmationStatus").unwrap(), "finalized");
    }

    #[test]
    fn sig_row_failure_emits_unknown_placeholder() {
        let r = SigRow {
            signature: "abc".into(),
            slot: 1,
            transaction_index: 2,
            block_time: 3,
            status: "failed".into(),
        };
        let entry = sig_row_to_entry(&r);
        assert_eq!(entry.get("err").unwrap(), &json!({ "unknown": true }));
    }
}
