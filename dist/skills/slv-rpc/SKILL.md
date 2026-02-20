---
name: slv-rpc
description: Solana RPC node (Index RPC) deployment and operations via slv ansible recipes. Use when managing RPC init, deploy, start, stop, restart, update, or ansible playbook execution for RPC nodes.
---

# SLV RPC Skill

ティナ（tina）専用スキル — Solana RPC ノード（Index RPC）のデプロイ・運用管理。

## 概要

ERPC の Mainnet/Testnet/Devnet RPC ノードを slv ansible レシピ経由で init・運用する。
MasterAPI の `/v3/rpcIndex/` エンドポイント群と、ansible-api 経由の playbook 実行を担当。

## アーキテクチャ

```
MasterAPI (CF Worker)
  → kafka-api queue('run-ansible-topic', ...)
    → ansible-api /apply
      → playbook: /home/solv/.slv/template/{slvVersion}/ansible/{type}/{playbook}.yml
```

## SLV Ansible テンプレート

パス: `vs2-app/slv/template/0.9.962/ansible/`

### RPC Init — 必須 extra_vars

**mainnet-rpc/init.yml** で `rpc_type` と `validator_type` により分岐:

| 変数名 | 型 | 説明 | デフォルト |
|---|---|---|---|
| `validator_type` | string | `agave` / `jito` / `firedancer-agave` / `firedancer-jito` | `firedancer-jito` |
| `rpc_type` | string | `Index RPC` / `Geyser gRPC` / `Index RPC + gRPC` | **必須** (mainnet) |
| `identity_account` | string | Identity Pubkey | **必須** |
| `version` | string | Solana バージョン | versions.yml参照 |
| `region` | string | リージョン | — |
| `port_rpc` | number | RPCポート | `7211` |
| `dynamic_port_range` | string | 動的ポート範囲 | `8000-8025` |
| `snapshot_url` | string | スナップショットURL | region別自動選択 |
| `shred_receiver_address` | string | Shred Receiver | Jito region APIから |
| `allowed_ips` | string[] | 許可IPリスト | — |
| `allowed_ssh_ips` | string[] | SSH許可IPリスト | — |
| `faithful_proxy_target_url` | string | Faithful Proxy URL (Index RPC用) | — |

### RPC 運用コマンド

| Playbook | 必須 extra_vars | 説明 |
|---|---|---|
| `start_node.yml` | `validator_type` | ノード起動 |
| `stop_node.yml` | `validator_type` | ノード停止 |
| `restart_node.yml` | `validator_type` | ノード再起動 |
| `update_startup_config.yml` | `validator_type` | 起動設定更新 |
| `install_solana.yml` | `version` | バージョン更新 |
| `install_of1.yml` | — | yellowstone-faithful インストール (mainnet) |

### ネットワーク固有の違い

| 項目 | Mainnet | Testnet | Devnet |
|---|---|---|---|
| rpc_type | あり | なし | なし |
| パーティション | 4つ | 2つ | 2つ |
| faithful (of1) | あり | なし | なし |
| fail2ban | あり | なし | なし |
| ビルド方式 | ソースビルド | ソースビルド | バイナリDL |
| snapshot DL | あり | あり | なし |

### 型定義 (InitIndexRpcExtraVars)

パス: `cmn/types/ansible/init-index-rpc.ts`

### 既存 MasterAPI エンドポイント

**RpcIndex (v3)**:
- `POST /v3/rpcIndex/create` — DB作成
- `POST /v3/rpcIndex/assign-bare-metal` — BM紐付け + init
- `POST /v3/rpcIndex/restart` — restart_node.yml
- `POST /v3/rpcIndex/update-version` — バージョン更新

### 実装参考

GeyserGrpc の `assignGeyserGrpcTasks.ts` と同パターンで実装。
`rpc_type` を `'Index RPC'` に設定して init.yml を実行。

## 絶対規約

- **PRはカイエンレビュー必須**
- **mainに直接プッシュ禁止**
- **デプロイは常にCI自動デプロイ**
