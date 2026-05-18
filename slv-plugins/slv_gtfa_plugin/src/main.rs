//! `slv-jetstreamer-gtfa` — jetstreamer runner with the slv-gtfa plugin
//! wired in.
//!
//! Drop-in replacement for `jetstreamer` in the backfill systemd unit:
//! same CLI arguments (epoch number, slot range, env vars like
//! `JETSTREAMER_THREADS`, `JETSTREAMER_CLICKHOUSE_MODE`,
//! `JETSTREAMER_CLICKHOUSE_DSN`).  The only difference is that this
//! binary additionally ingests rows into the `gtfa_tx_mentions` table
//! via `SlvGtfaPlugin`.
//!
//! Use `JETSTREAMER_CLICKHOUSE_MODE=remote` +
//! `JETSTREAMER_CLICKHOUSE_DSN=http://localhost:8123` to share the
//! persistent ClickHouse already provisioned for the host (see
//! slv-jetstreamer SKILL).

use jetstreamer::JetstreamerRunner;
use slv_gtfa_plugin::SlvGtfaPlugin;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    JetstreamerRunner::default()
        .with_log_level("info")
        .with_plugin(Box::new(SlvGtfaPlugin::new()))
        .parse_cli_args()?
        .run()
        .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;
    Ok(())
}
