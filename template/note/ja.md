# 🚀 リリース: Solana Testnet Validator — メンテナンス / アップグレードノート

このリリースは、テストネットバリデータを最新の `slv` ツールおよび `agave-validator` セットアップに保つことを目的としています。以下の手順に従って、安全にアップグレードし変更を適用してください。

---

## ✅ ハイライト
- `slv` を最新バージョンにアップグレード  
- バリデータのバージョン設定を更新  
- `agave-validator` のリフレッシュ/更新  
- 変更を適用するためのクリーンな再起動シーケンス  
- ノーダウンタイムでのアイデンティティ切替、またはホットスペア割り当ての手順  

---

## 🧰 アップグレード手順

Agave/Firedancer Testnet Validator 向け

### 1) `slv` をアップグレード
```
slv upgrade
```

### 2) バージョン設定を更新
```
slv v update:version -c
┌─ Mainnet Validators ───────────────────────┐
  Agave: 2.3.8 = 2.3.8
  Jito: 2.3.8 = 2.3.8
  Firedancer: 0.708.20306 → 0.709.30000

┌─ Testnet Validators ───────────────────────┐
  Agave: 3.0.0 → 3.0.1
  Firedancer: 0.708.20306 = 0.708.20306

┌─ Mainnet RPCs ────────────────────────────┐
  Agave: 2.3.8 = 2.3.8
  Jito: 2.3.8 = 2.3.8
  Firedancer: 0.708.20306 → 0.709.30000
  Geyser: v9.0.0+solana.2.3.8 = v9.0.0+solana.2.3.8
```

### 3) `agave-validator` の更新/セットアップ
```
slv v update:version -n testnet
```

Firedancer Testnet Validator の場合:
```
slv setup:firedancer -n testnet
```

### 4) 変更を反映するために再起動
```
slv v stop  -n testnet
slv v start  -n testnet
```

### 5) アイデンティティの変更

レジャーの読み込みが完了した後、以下のコマンドでアイデンティティを変更してください。

```
slv v set:identity -n testnet
```

> ℹ️ 実行前に、`~/.slv/inventory.testnet.validators.yml` ファイルに Identity アドレスと Vote アドレスが正しく設定されていることを確認してください。

---

## 📝 注意事項
- `-n testnet` はテストネットプロファイルを対象にしています。別の環境を管理している場合は適宜変更してください。  
- 再起動後は、スロット進行、リーダースケジュール、ネットワーク接続などのヘルスを必ず確認し、ログを監視してください。  

---
