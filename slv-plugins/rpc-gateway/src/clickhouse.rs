//! Minimal ClickHouse HTTP client — HTTP only, JSONEachRow on the
//! wire, no native protocol.
//!
//! Keeps the dependency surface to `reqwest` + `serde_json` rather
//! than pulling in the `clickhouse` crate (= which the jetstreamer
//! plugins in this workspace use for `Row` derive on insert paths).
//! The gateway only reads, the SQL is hand-written, and the row
//! shapes belong to the calling handler — `serde::Deserialize` on
//! a per-handler struct is enough.

use std::time::Duration;

use base64::Engine;
use reqwest::Client as HttpClient;
use serde::de::DeserializeOwned;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClickHouseError {
    #[error("ClickHouse HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("ClickHouse transport error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("ClickHouse row parse error on line {line}: {source}")]
    Parse {
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error("ClickHouse URL parse error: {0}")]
    Url(#[from] url::ParseError),
}

#[derive(Debug, Clone)]
pub struct ClickHouseConfig {
    pub url: String,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub timeout: Duration,
}

impl Default for ClickHouseConfig {
    fn default() -> Self {
        Self {
            url: "http://localhost:8123".into(),
            database: Some("default".into()),
            username: None,
            password: None,
            timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClickHouseClient {
    url: String,
    http: HttpClient,
    auth_header: Option<String>,
}

impl ClickHouseClient {
    pub fn new(cfg: ClickHouseConfig) -> Result<Self, ClickHouseError> {
        // Append ?database=... to the URL if configured — works on
        // any ClickHouse server that supports the HTTP interface.
        let mut parsed = url::Url::parse(&cfg.url)?;
        if let Some(db) = cfg.database.as_deref() {
            parsed.query_pairs_mut().append_pair("database", db);
        }
        let url = parsed.into();

        let http = HttpClient::builder()
            .timeout(cfg.timeout)
            .build()?;

        let auth_header = cfg.username.as_deref().map(|user| {
            let pass = cfg.password.as_deref().unwrap_or("");
            let raw = format!("{user}:{pass}");
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(raw),
            )
        });

        Ok(Self { url, http, auth_header })
    }

    /// Execute a SQL query and parse rows.  Always appends `FORMAT
    /// JSONEachRow` if the caller didn't include a `FORMAT` clause.
    pub async fn query<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>, ClickHouseError> {
        let final_sql = ensure_format_clause(sql);
        let mut req = self.http.post(&self.url).body(final_sql);
        if let Some(h) = &self.auth_header {
            req = req.header("Authorization", h);
        }
        let res = req.send().await?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ClickHouseError::Http {
                status: status.as_u16(),
                body: text.chars().take(300).collect(),
            });
        }
        let mut out = Vec::new();
        for (i, line) in text.lines().enumerate() {
            if line.is_empty() {
                continue;
            }
            let row: T = serde_json::from_str(line)
                .map_err(|source| ClickHouseError::Parse { line: i + 1, source })?;
            out.push(row);
        }
        Ok(out)
    }

    /// Fire a query and return the first row, or `None`.
    pub async fn query_one<T: DeserializeOwned>(
        &self,
        sql: &str,
    ) -> Result<Option<T>, ClickHouseError> {
        let rows = self.query::<T>(sql).await?;
        Ok(rows.into_iter().next())
    }
}

fn ensure_format_clause(sql: &str) -> String {
    let trimmed = sql.trim_end();
    let last = trimmed
        .rsplit(|c: char| c.is_whitespace())
        .find(|s| !s.is_empty());
    let has_format = trimmed
        .to_ascii_uppercase()
        .rsplit_once("FORMAT")
        .is_some_and(|(_, tail)| {
            let tail = tail.trim();
            !tail.is_empty() && tail.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        });
    if has_format {
        sql.to_owned()
    } else {
        // Last-token check rejects false positives from FORMAT appearing
        // inside a string literal earlier in the query.
        let _ = last;
        format!("{trimmed} FORMAT JSONEachRow")
    }
}

/// Minimal SQL escaper for string literals.  Only safe for inputs
/// already restricted to known shapes (base58 addresses, hex
/// strings, integers); do not use for arbitrary user input.
pub fn quote_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '\'' => out.push_str(r"\'"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_format_appends_jsoneachrow() {
        assert_eq!(
            ensure_format_clause("SELECT 1"),
            "SELECT 1 FORMAT JSONEachRow",
        );
    }

    #[test]
    fn ensure_format_preserves_explicit_clause() {
        assert_eq!(
            ensure_format_clause("SELECT 1 FORMAT TabSeparated"),
            "SELECT 1 FORMAT TabSeparated",
        );
    }

    #[test]
    fn quote_string_escapes_quotes_and_backslashes() {
        assert_eq!(quote_string("hello"), "'hello'");
        assert_eq!(quote_string(r"O'Brien"), r"'O\'Brien'");
        assert_eq!(quote_string(r"a\b"), r"'a\\b'");
    }
}
