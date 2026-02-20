---
name: slv-grpc-geyser
description: Solana gRPC Geyser Stream deployment and operations via slv ansible recipes. Use when managing Geyser gRPC init, build, restart, or ansible playbook execution for gRPC nodes.
---

# SLV gRPC Geyser Skill

クラウド（cloud）専用スキル — Solana gRPC Geyser Stream のデプロイ・運用管理。

## 概要

ERPC の gRPC Geyser ノードを slv ansible レシピ経由で init・運用する。
MasterAPI の `/v3/geyserGrpc/` エンドポイント群を担当。**既に実装済み**のパターンがあり、IndexRpc/Validator の参考実装となる。

## アーキテクチャ

```
MasterAPI (CF Worker)
  → kafka-api queue('run-ansible-topic', ...)
    → ansible-api /apply
      → playbook: /home/solv/.slv/template/{slvVersion}/ansible/mainnet-rpc/init.yml
```

## gRPC Geyser Init — extra_vars (実装済み)

型定義: `cmn/types/ansible/init-geyser-grpc.ts` (`InitGeyserGrpcExtraVars`)

| 変数名 | 型 | 説明 | デフォルト |
|---|---|---|---|
| `identity_account` | string | Identity Pubkey | **必須** |
| `version` | string | Solana バージョン | **必須** |
| `richat_version` | string | Richat バージョン | `richat-v7.1.2` |
| `region` | string | リージョン | **必須** |
| `port_rpc` | number | RPCポート | `7211` |
| `dynamic_port_range` | string | 動的ポート範囲 | `8000-8025` |
| `validator_type` | string | Validator Type | `jito` |
| `rpc_type` | string | RPC Type | `Geyser gRPC` |
| `shred_receiver_address` | string | Shred Receiver | Jito region APIから |
| `allowed_ips` | string[] | 許可IPリスト | オプション |
| `allowed_ssh_ips` | string[] | SSH許可IPリスト | オプション |
| `snapshot_url` | string | スナップショットURL | region別自動選択 |

## Geyser 2系統

### Richat方式（現行推奨）
- `geyser_richat_build.yml` — Richatビルド
- `install_richat.yml` — Richatインストール
- `init_richat_geyser.yml` — Richat Geyser初期化
- 変数: `richat_version` のみ（versions.ymlにフォールバック）

### Yellowstone方式（レガシー）
- `geyser_build.yml` — バイナリDL
- `update_geyser.yml` — ソースビルド更新
- 変数: `geyser_version`

## 既存 MasterAPI エンドポイント (全実装済み ✅)

- `POST /v3/geyserGrpc/create` — DB作成 + オプションでassign
- `POST /v3/geyserGrpc/assign-bare-metal` — BM紐付け + init playbook実行
- `POST /v3/geyserGrpc/restart` — restart_node.yml
- `POST /v3/geyserGrpc/update-version` — バージョン更新

### assign フロー（参考実装）

ファイル: `api/erpc/master-api/src/route/v3/geyserGrpc/assignGeyserGrpcTasks.ts`

1. BareMetal検索 → GeyserGrpc取得
2. DB紐付け (associate)
3. `getSlvVersion()` → playbookパス生成
4. `getNearestJitoRegion(ip)` → shred_receiver_address取得
5. `queueCreateUserTask` → solv ユーザー作成
6. `mainnet-rpc/init.yml` を `InitGeyserGrpcExtraVars` つきでキューイング
7. nftable deploy (whitelistIps)
8. BareMetal更新、Discord通知
9. `checkRpcRunning(ip, 7211)` — 起動確認

## 絶対規約

- **PRはカイエンレビュー必須**
- **mainに直接プッシュ禁止**
- **デプロイは常にCI自動デプロイ**
