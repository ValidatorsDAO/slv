//! JSON-RPC method handlers, grouped by namespace.
//!
//! Each handler returns a `serde_json::Value` (the eventual `result`
//! field of the response) or an error string that the dispatcher
//! wraps into a JSON-RPC error object.  Param parsing helpers live
//! in this module so handler implementations stay focused on SQL.

pub mod gtfa;
pub mod jet;
pub mod transfers;

use serde_json::Value;

/// `req.params` for slv methods is always either `[]` or `[{...}]`
/// (= zero or one options object).  Returns the inner options map,
/// or an empty map if absent.
pub fn param_obj(params: &Option<Value>) -> serde_json::Map<String, Value> {
    match params {
        Some(Value::Array(arr)) => match arr.first() {
            Some(Value::Object(map)) => map.clone(),
            _ => Default::default(),
        },
        _ => Default::default(),
    }
}

pub fn as_int(v: &Value, name: &str) -> Result<i64, String> {
    as_int_opt(v, name)?.ok_or_else(|| format!("missing {name}"))
}

pub fn as_int_or(v: Option<&Value>, name: &str, fallback: i64) -> Result<i64, String> {
    match v {
        None | Some(Value::Null) => Ok(fallback),
        Some(other) => {
            as_int_opt(other, name)?.ok_or_else(|| format!("invalid {name}: not an integer"))
        }
    }
}

fn as_int_opt(v: &Value, name: &str) -> Result<Option<i64>, String> {
    match v {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("invalid {name}: not an integer")),
        Value::String(s) => s
            .parse::<i64>()
            .map(Some)
            .map_err(|_| format!("invalid {name}: not an integer")),
        _ => Err(format!("invalid {name}: not an integer")),
    }
}

pub fn as_string(v: &Value, name: &str) -> Result<String, String> {
    match v {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        _ => Err(format!("missing {name}")),
    }
}

pub fn as_bool_or(v: Option<&Value>, fallback: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        _ => fallback,
    }
}

/// Accepts unix seconds/millis or `'YYYY-MM-DD[ HH:MM:SS]'`.
/// Mirrors `asDateString` in `api/rpc-gateway/src/handlers/jet.ts`.
pub fn as_date_string(v: &Value, name: &str) -> Result<String, String> {
    let s = as_string(v, name)?;
    let date_re = regex::Regex::new(
        r"^(\d{10}|\d{13}|\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2}:\d{2})?)$",
    )
    .expect("static regex compiles");
    if date_re.is_match(&s) {
        Ok(s)
    } else {
        Err(format!(
            "invalid {name}: expected unix seconds/millis or 'YYYY-MM-DD[ HH:MM:SS]'",
        ))
    }
}

pub fn as_base58_pubkey(v: &Value, name: &str) -> Result<String, String> {
    let s = as_string(v, name)?;
    let re = regex::Regex::new(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
        .expect("static regex compiles");
    if re.is_match(&s) {
        Ok(s)
    } else {
        Err(format!("invalid {name}: not a valid base58 pubkey"))
    }
}

pub fn clamp_int(value: i64, min: i64, max: i64) -> i64 {
    value.clamp(min, max)
}
