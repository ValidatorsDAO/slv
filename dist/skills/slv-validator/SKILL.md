---
name: slv-validator
description: Solana Validator (Mainnet/Testnet) deployment and operations via slv ansible recipes. Use when managing validator init, start, stop, restart, switch, update, or ansible playbook execution for validators.
---

# SLV Validator Skill

セシル（cecil）専用スキル — Solana Validator のデプロイ・運用管理。

## 概要

ERPC の Mainnet/Testnet Validator を slv ansible レシピ経由で init・運用する。
MasterAPI の `/v3/validator/` エンドポイント群と、ansible-api 経由の playbook 実行を担当。

## アーキテクチャ

```
MasterAPI (CF Worker)
  → kafka-api queue('run-ansible-topic', ...)
    → ansible-api /apply
      → playbook: /home/solv/.slv/template/{slvVersion}/ansible/{type}/{playbook}.yml
```

## SLV Ansible テンプレート

パス: `vs2-app/slv/template/0.9.962/ansible/`（`latest` はローカルシンボリックリンク、バージョン直指定を使うこと）

### ディレクトリ構成

| ディレクトリ | 用途 |
|---|---|
| `mainnet-validator/` | Mainnet Validator |
| `testnet-validator/` | Testnet Validator |
| `mainnet-rpc/` | Mainnet RPC（GeyserGrpc/IndexRpc含む） |
| `testnet-rpc/` | Testnet RPC |
| `cmn/` | 共通タスク |

### Validator Init — 必須 extra_vars

**統合 init.yml** (mainnet/testnet共通) で `validator_type` により分岐:

| 変数名 | 型 | 説明 | デフォルト |
|---|---|---|---|
| `validator_type` | string | `agave` / `jito` / `firedancer-agave` / `firedancer-jito` / `frankendancer` | `firedancer-jito` |
| `identity_account` | string | Identity Pubkey | **必須** |
| `vote_account` | string | Vote Account Pubkey | **必須** |
| `commission_bps` | number | ステーキング手数料（bps） | `0` |
| `version` | string | Solana/Agave バージョン | versions.yml参照 |
| `region` | string | リージョン（Jito region解決用） | — |
| `snapshot_url` | string | スナップショットURL | — |
| `port_rpc` | number | RPCポート | `8899` |
| `limit_ledger_size` | number | レジャーサイズ制限 | `200000000` |
| `block_engine_url` | string | Jito Block Engine URL | Jito region APIから取得 |
| `relayer_url` | string | Jito Relayer URL | Jito region APIから取得 |
| `shred_receiver_address` | string | Shred Receiver アドレス | Jito region APIから取得 |
| `allowed_ips` | string[] | 許可IPリスト | — |
| `allowed_ssh_ips` | string[] | SSH許可IPリスト | — |

### Validator 運用コマンド — extra_vars

| Playbook | 必須 extra_vars | 説明 |
|---|---|---|
| `start_node.yml` | `validator_type` | ノード起動 |
| `stop_node.yml` | `validator_type` | ノード停止 |
| `restart_node.yml` | `validator_type` | ノード再起動 |
| `nodowntime_migrate.yml` | `validator_type`, `source_host`, `target_host` | ゼロダウンタイム移行 |
| `switch_on_identity.yml` | — | Identity有効化 |
| `switch_off_identity.yml` | — | Identity無効化 |
| `update_startup_config.yml` | `validator_type` | 起動設定更新 |
| `install_solana.yml` | `version` | Solanaバージョン更新 |
| `set_identity_key.yml` | `identity_account` | Identity Key設定 |

### versions.yml で管理されるデフォルト値

```yaml
mainnet_validators:
  version_agave: "2.2.16"
  version_jito: "2.2.16-jito"
  version_firedancer: "0.404.20115"
  allowed_ssh_ips: [...]
  allowed_ips: [...]

testnet_validators:
  version_agave: "2.3.7-agave"
  version_jito: "2.3.7-jito"
  version_firedancer: "0.404.20115"
```

⚠️ **versions.yml を使わず extra_vars で全て渡せる** — API経由の場合はextra_varsを直接指定すること。

### 既存 MasterAPI エンドポイント

**Validator (v3)**:
- `POST /v3/validator/mainnet/add` — DB作成 + BM紐付け（⚠️ ansible init未実装）
- `POST /v3/validator/mainnet/start` — start_node.yml
- `POST /v3/validator/mainnet/stop` — stop_node.yml
- `POST /v3/validator/mainnet/switch` — switch identity
- `POST /v3/validator/mainnet/update` — update_startup_config.yml
- `POST /v3/validator/mainnet/dl-snapshot` — wget_snapshot.yml
- `POST /v3/validator/mainnet/rm-ledger` — rm_ledger.yml

testnet も同構成。

### 実装参考: GeyserGrpc assign パターン

`api/erpc/master-api/src/route/v3/geyserGrpc/assignGeyserGrpcTasks.ts` が参考実装:

1. BareMetal検索 → GeyserGrpc取得
2. DB紐付け (associate)
3. slvVersion取得 (`getSlvVersion()`)
4. Jito region取得 (`getNearestJitoRegion(ip)`)
5. solv ユーザー作成 (`queueCreateUserTask`)
6. **init playbook を extra_vars つきでキューイング**
7. BareMetal更新、Discord通知

### 共通ヘルパー

- `resolveValidatorBareMetal(id, network)` — Validator ID → BareMetal IP解決
- `getPlaybookPath(network, playbook)` — slvVersion込みのplaybookパス生成
- `queueAnsiblePlaybook(ip, path, extraVars)` — kafka-api経由でAnsible実行

パス: `api/erpc/master-api/src/route/v3/validator/shared/resolveValidatorBareMetal.ts`

## ⚠️ バグ

- `testnet-validator/update_firedancer.yml` が `mainnet_validators.version_firedancer` を参照（testnetなのに）

## 絶対規約

- **PRはカイエンレビュー必須**
- **mainに直接プッシュ禁止** — ブランチ切ってPR
- **デプロイは常にCI自動デプロイ**
- **master-apiの直接操作はロック経由**
