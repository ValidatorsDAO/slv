//! JSON-RPC 2.0 request / response types used by the dispatcher.
//!
//! Scope kept intentionally minimal for the scaffold PR:
//!   - `Request` parses both `id` (number / string / null) and `params`
//!     (positional array, by-name object, or absent) without committing
//!     to per-method param schemas — handlers do their own parsing.
//!   - `Response` is a serialise-only convenience around `success` /
//!     `error` shapes; the dispatcher returns `serde_json::Value` so
//!     each handler can construct the most natural body shape and we
//!     don't pay for a custom enum until we need one.
//!
//! Mirrors the wire shape of `api/rpc-gateway/src/jsonrpc.ts` in the
//! Deno gateway so a method ported to Rust returns byte-for-byte the
//! same response the Deno version would have.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC 2.0 request `id` field.  Spec says it may be a string,
/// number, or `null`.  We also accept absent (= notification) — the
/// dispatcher decides whether to reply based on `is_notification`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Id {
    Num(i64),
    Str(String),
    Null,
}

impl Id {
    pub fn or_null(opt: Option<Self>) -> Self {
        opt.unwrap_or(Self::Null)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub id: Option<Id>,
}

impl Request {
    /// Per JSON-RPC 2.0: a request without `id` is a *notification*;
    /// the server MUST process it but MUST NOT respond.
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    /// Cheap validator — returns Some only when the envelope itself is
    /// well-formed.  Per-method param validation happens inside each
    /// handler, where the error message can be specific.
    pub fn validate(value: Value) -> Option<Self> {
        let req: Self = serde_json::from_value(value).ok()?;
        if req.jsonrpc != "2.0" || req.method.is_empty() {
            return None;
        }
        Some(req)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorObject>,
    pub id: Id,
}

impl Response {
    pub fn ok(id: Id, result: Value) -> Self {
        Self { jsonrpc: "2.0", result: Some(result), error: None, id }
    }
    pub fn err(id: Id, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            result: None,
            error: Some(ErrorObject { code, message: message.into(), data: None }),
            id,
        }
    }
}

/// JSON-RPC 2.0 standard error codes plus a couple of project-local
/// extensions used by the Deno gateway that the Rust port preserves
/// (`UPSTREAM_ERROR` for failed forward to `of1`, `INTERNAL_ERROR`
/// for unexpected dispatcher panics).
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const UPSTREAM_ERROR: i32 = -32099;
}
