//! Compile `proto/shredstream.proto` into a generated Rust module so
//! the gateway can speak `ShredstreamProxy.SubscribeEntries` without
//! depending on the full `solana-stream-sdk` crate (which brings in
//! `solana-ledger` + friends).  The proto file is a minimal wire-
//! compatible subset of jito-shredstream-proxy's definition — see
//! the file header for the rationale.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(false)
        .compile_protos(&["proto/shredstream.proto"], &["proto"])?;
    println!("cargo:rerun-if-changed=proto/shredstream.proto");
    Ok(())
}
