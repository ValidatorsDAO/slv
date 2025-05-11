---
id: shredstream-test
title: Solana Shredstream - Connectivity Test
description: SLV - Solana Shredstream - Connectivity Test
---

This guide explains how to test connectivity to Solana Shredstream.

## Prerequisites

Install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Clone the Git Repository
Clone the Shredstream Git repository with the following command:

```bash
git clone https://github.com/jito-labs/shredstream-proxy.git
```

## Clone the Proto Repository
Clone the Proto repository with the following commands:

```bash
cd shredstream-proxy
rm -rf protos
git clone https://github.com/jito-labs/mev-protos.git ./protos
cd ..
```

## Edit the Executable

Open `shredstream-proxy/examples/deshred.rs` and find the following line:

```rust
let mut client = ShredstreamProxyClient::connect("http://127.0.0.1:9999")
```

Replace this URL with your Shredstream server URL.

For example, change it to:

```rust
let mut client = ShredstreamProxyClient::connect("http://<YourShredServerIP>:10000")
```

## Build & Run Shredstream

Build and run Shredstream with the following command:

```bash
RUST_LOG=INFO cargo run --example deshred
slot 339282778, entries: 1, transactions: 0
slot 339282779, entries: 22, transactions: 68
slot 339282779, entries: 28, transactions: 57
slot 339282779, entries: 36, transactions: 71
slot 339282779, entries: 26, transactions: 73
slot 339282779, entries: 35, transactions: 71
slot 339282779, entries: 11, transactions: 89
slot 339282779, entries: 44, transactions: 41
slot 339282779, entries: 38, transactions: 43
slot 339282779, entries: 24, transactions: 103
..
```

Successfully receiving shreds!
