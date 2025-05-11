---
id: shredstream-test
title: Solana Shredstream - Connectivity Test
description: SLV - Solana Shredstream - Connectivity Test
---

このガイドでは、Solana Shredstream の接続をテストする方法について説明します。

## 前提条件

Rust をインストールしてください:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Git リポジトリのクローン
次のコマンドで、Shredstream Git リポジトリをクローンします:

```bash
git clone https://github.com/jito-labs/shredstream-proxy.git
```

## Proto リポジトリのクローン
次のコマンドで、Proto リポジトリをクローンします:

```bash
cd shredstream-proxy
rm -rf protos
git clone https://github.com/jito-labs/mev-protos.git ./protos
cd ..
```

## 実行ファイルの編集

`shredstream-proxy/examples/deshred.rs` を開き、次の行を見つけてください:

```rust
let mut client = ShredstreamProxyClient::connect("http://127.0.0.1:9999")
```

この URL を、Shredstream サーバーの URL に置き換えます。

例えば、次のように変更します:

```rust
let mut client = ShredstreamProxyClient::connect("http://<YourShredServerIP>:10000")
```

## Shredstream のビルド&実行

次のコマンドで、Shredstream をビルドして実行します:

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

無事に Shred を受信できました！