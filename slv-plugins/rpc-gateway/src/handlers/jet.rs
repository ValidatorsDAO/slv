//! `jet*` RPC methods — analytics over ClickHouse tables emitted by
//! the jetstreamer plugins in this workspace and anza-xyz's built-in
//! `program-tracking` / `pubkey-stats` plugins.
//!
//! Wire-shape parity target: byte-for-byte identical responses to the
//! Deno gateway at `api/rpc-gateway/src/handlers/jet.ts`.  Each
//! handler builds a SQL string and returns `serde_json::Value`; the
//! dispatcher wraps it into a JSON-RPC 2.0 response envelope.
//!
//! All numeric fields that come from `sum()` aggregates land here as
//! strings because ClickHouse's JSONEachRow format quotes UInt64 to
//! avoid JS number precision loss — matches what the Deno gateway
//! emits.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::clickhouse::{quote_string, ClickHouseClient};
use crate::handlers::{
    as_base58_pubkey, as_bool_or, as_date_string, as_int, as_int_or, as_string, clamp_int,
    param_obj,
};

const SLOTS_PER_EPOCH: i64 = 432_000;

/// `jetTopPrograms({ since?, until?, includeVotes?, limit? })`
pub async fn top_programs(ch: &ClickHouseClient, params: &Option<Value>) -> Result<Value, String> {
    let p = param_obj(params);
    let since = p.get("since")
        .map(|v| as_date_string(v, "since").map(|s| quote_string(&s)))
        .transpose()?;
    let until = p.get("until")
        .map(|v| as_date_string(v, "until").map(|s| quote_string(&s)))
        .transpose()?;
    let include_votes = as_bool_or(p.get("includeVotes"), false);
    let limit = clamp_int(as_int_or(p.get("limit"), "limit", 20)?, 1, 1000);

    let mut where_clauses = Vec::<String>::new();
    if let Some(s) = since.as_deref() {
        where_clauses.push(format!("timestamp >= toDateTime({s})"));
    }
    if let Some(s) = until.as_deref() {
        where_clauses.push(format!("timestamp <  toDateTime({s})"));
    }
    if !include_votes {
        where_clauses.push("is_vote = 0".into());
    }
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };

    let sql = format!(
        r#"
        SELECT
            base58Encode(toString(program_id)) AS program,
            sum(count)        AS invocations,
            sum(error_count)  AS errors,
            sum(total_cus)    AS total_cus
        FROM program_invocations
        {where_sql}
        GROUP BY program_id
        ORDER BY invocations DESC
        LIMIT {limit}
        "#
    );
    // ClickHouse JSONEachRow emits UInt64 sums as numbers (not
    // quoted strings) when `output_format_json_quote_64bit_integers`
    // is at its server default of `false`.  The slv-jetstreamer host
    // runs with that default, so deserialise as `u64`.  Matches the
    // Deno gateway's actual output where JS coerces the number back
    // to a JSON number in `JSON.stringify`.
    #[derive(Deserialize, Serialize)]
    struct Row {
        program: String,
        invocations: u64,
        errors: u64,
        total_cus: u64,
    }
    let rows: Vec<Row> = ch.query(&sql).await.map_err(|e| e.to_string())?;
    Ok(json!(rows))
}

/// `jetSlotStats({ slot } | { fromSlot, toSlot })`
pub async fn slot_stats(ch: &ClickHouseClient, params: &Option<Value>) -> Result<Value, String> {
    let p = param_obj(params);
    let where_sql = if let Some(slot_v) = p.get("slot") {
        let slot = as_int(slot_v, "slot")?;
        format!("WHERE slot = {slot}")
    } else {
        let from = as_int(
            p.get("fromSlot").ok_or("missing fromSlot")?,
            "fromSlot",
        )?;
        let to = as_int(p.get("toSlot").ok_or("missing toSlot")?, "toSlot")?;
        if to < from {
            return Err("toSlot must be >= fromSlot".into());
        }
        if to - from > 100_000 {
            return Err("range too large (max 100k slots)".into());
        }
        format!("WHERE slot BETWEEN {from} AND {to}")
    };

    let sql = format!(
        r#"
        SELECT
            slot,
            transaction_count,
            vote_transaction_count,
            non_vote_transaction_count,
            toUnixTimestamp(block_time) AS block_time
        FROM jetstreamer_slot_status
        {where_sql}
        ORDER BY slot
        "#
    );
    #[derive(Deserialize, Serialize)]
    struct Row {
        slot: u64,
        transaction_count: u64,
        vote_transaction_count: u64,
        non_vote_transaction_count: u64,
        block_time: u64,
    }
    let rows: Vec<Row> = ch.query(&sql).await.map_err(|e| e.to_string())?;
    Ok(json!(rows))
}

/// `jetTpsTimeseries({ from, to, bucketSec? })`
pub async fn tps_timeseries(
    ch: &ClickHouseClient,
    params: &Option<Value>,
) -> Result<Value, String> {
    let p = param_obj(params);
    let from = quote_string(&as_date_string(
        p.get("from").ok_or("missing from")?,
        "from",
    )?);
    let to = quote_string(&as_date_string(
        p.get("to").ok_or("missing to")?,
        "to",
    )?);
    let bucket_sec = clamp_int(as_int_or(p.get("bucketSec"), "bucketSec", 300)?, 1, 86_400);

    let sql = format!(
        r#"
        SELECT
            toUnixTimestamp(toStartOfInterval(block_time, INTERVAL {bucket_sec} SECOND)) AS bucket,
            sum(non_vote_transaction_count) / {bucket_sec} AS non_vote_tps,
            sum(transaction_count)          / {bucket_sec} AS total_tps
        FROM jetstreamer_slot_status
        WHERE block_time >= toDateTime({from})
          AND block_time <  toDateTime({to})
        GROUP BY bucket
        ORDER BY bucket
        "#
    );
    #[derive(Deserialize, Serialize)]
    struct Row {
        bucket: u64,
        non_vote_tps: f64,
        total_tps: f64,
    }
    let rows: Vec<Row> = ch.query(&sql).await.map_err(|e| e.to_string())?;
    Ok(json!(rows))
}

/// `jetEpochSummary({ epoch })`
pub async fn epoch_summary(ch: &ClickHouseClient, params: &Option<Value>) -> Result<Value, String> {
    let p = param_obj(params);
    let epoch = as_int(p.get("epoch").ok_or("missing epoch")?, "epoch")?;
    let from_slot = epoch * SLOTS_PER_EPOCH;
    let to_slot = from_slot + SLOTS_PER_EPOCH - 1;

    let summary_sql = format!(
        r#"
        SELECT
            count() AS slots,
            sum(non_vote_transaction_count) AS non_vote_txs,
            sum(vote_transaction_count)     AS vote_txs,
            sum(transaction_count)          AS total_txs,
            toUnixTimestamp(min(block_time)) AS first_block_time,
            toUnixTimestamp(max(block_time)) AS last_block_time
        FROM jetstreamer_slot_status
        WHERE slot BETWEEN {from_slot} AND {to_slot}
        "#
    );
    #[derive(Deserialize, Serialize)]
    struct SummaryRow {
        slots: u64,
        non_vote_txs: Option<u64>,
        vote_txs: Option<u64>,
        total_txs: Option<u64>,
        first_block_time: Option<u64>,
        last_block_time: Option<u64>,
    }
    let row: Option<SummaryRow> = ch.query_one(&summary_sql).await.map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(Value::Null); };
    if row.slots == 0 {
        return Ok(Value::Null);
    }

    let programs_sql = format!(
        r#"
        SELECT
            uniqExact(program_id) AS programs,
            sum(count)            AS invocations
        FROM program_invocations
        WHERE slot BETWEEN {from_slot} AND {to_slot}
        "#
    );
    #[derive(Deserialize)]
    struct ProgRow {
        programs: Option<u64>,
        invocations: Option<u64>,
    }
    let prog: Option<ProgRow> = ch.query_one(&programs_sql).await.map_err(|e| e.to_string())?;

    Ok(json!({
        "epoch": epoch,
        "slots": row.slots,
        "non_vote_txs": row.non_vote_txs.unwrap_or(0),
        "vote_txs": row.vote_txs.unwrap_or(0),
        "total_txs": row.total_txs.unwrap_or(0),
        "first_block_time": row.first_block_time,
        "last_block_time": row.last_block_time,
        "distinct_programs": prog
            .as_ref()
            .and_then(|p| p.programs)
            .unwrap_or(0),
        "program_invocations": prog
            .and_then(|p| p.invocations)
            .unwrap_or(0),
    }))
}

/// `jetProgramStats({ programIdBase58, since?, until?, bucketSec? })`
pub async fn program_stats(
    ch: &ClickHouseClient,
    params: &Option<Value>,
) -> Result<Value, String> {
    let p = param_obj(params);
    let program_b58 = as_base58_pubkey(
        p.get("programIdBase58").ok_or("missing programIdBase58")?,
        "programIdBase58",
    )?;
    let since = p.get("since")
        .map(|v| as_date_string(v, "since").map(|s| quote_string(&s)))
        .transpose()?;
    let until = p.get("until")
        .map(|v| as_date_string(v, "until").map(|s| quote_string(&s)))
        .transpose()?;
    let bucket_sec = clamp_int(
        as_int_or(p.get("bucketSec"), "bucketSec", 3600)?,
        60,
        86_400,
    );

    let mut where_clauses = vec![format!(
        "program_id = base58Decode({})",
        quote_string(&program_b58),
    )];
    if let Some(s) = since.as_deref() {
        where_clauses.push(format!("timestamp >= toDateTime({s})"));
    }
    if let Some(s) = until.as_deref() {
        where_clauses.push(format!("timestamp <  toDateTime({s})"));
    }

    let sql = format!(
        r#"
        SELECT
            toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL {bucket_sec} SECOND)) AS bucket,
            sum(count)        AS invocations,
            sum(error_count)  AS errors,
            sum(total_cus)    AS total_cus
        FROM program_invocations
        WHERE {where_join}
        GROUP BY bucket
        ORDER BY bucket
        "#,
        where_join = where_clauses.join(" AND "),
    );
    // `as_string` for the would-be name lint clean-up.
    let _ = as_string;
    #[derive(Deserialize, Serialize)]
    struct Row {
        bucket: u64,
        invocations: u64,
        errors: u64,
        total_cus: u64,
    }
    let rows: Vec<Row> = ch.query(&sql).await.map_err(|e| e.to_string())?;
    Ok(json!(rows))
}
