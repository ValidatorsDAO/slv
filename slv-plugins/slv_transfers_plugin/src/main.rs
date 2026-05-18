//! `slv-jetstreamer-transfers` — jetstreamer runner with the slv-transfers
//! plugin wired in.
//!
//! Drop-in alongside `slv-jetstreamer-gtfa`: the firehose can host both
//! plugins concurrently, so adding this binary doesn't displace gtfa.
//! Run with the same env vars (`JETSTREAMER_THREADS`,
//! `JETSTREAMER_CLICKHOUSE_MODE=remote`,
//! `JETSTREAMER_CLICKHOUSE_DSN=http://localhost:8123`).
//!
//! Phase 1 scope: SPL Token v1 `Transfer` (3) + `TransferChecked` (12).
//! Phase 3 will extend: MintTo, Burn, SetAuthority, CloseAccount,
//! SyncNative wrap/unwrap, SPL Token-2022, System.Transfer.
//! See slv:.claude/design_slv_transfers_plugin.md for the full plan.

use jetstreamer::JetstreamerRunner;
use slv_transfers_plugin::SlvTransfersPlugin;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    JetstreamerRunner::default()
        .with_log_level("info")
        .with_plugin(Box::new(SlvTransfersPlugin::new()))
        .parse_cli_args()?
        .run()
        .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;
    Ok(())
}
