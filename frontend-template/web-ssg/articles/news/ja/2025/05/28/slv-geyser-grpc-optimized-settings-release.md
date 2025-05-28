---
id: slv-geyser-grpc-easy-setup-release
title: SLV、Solana Geyser gRPC ノードの簡単セットアップ機能を提供開始
category: プレスリリース
thumbnail: /news/2025/05/06/SLVgeyserGRPCeasySetupJA.jpg
---

ELSOUL LABO B.V.（本社: オランダ・アムステルダム、代表取締役 CEO: 川崎文武）と、Solanaネットワークの分散化・セキュリティ強化を推進する Validators DAO は、オープンソースの Solana バリデータツール「SLV」において、**Solana Geyser gRPC ノードの簡単セットアップ機能を正式リリース**しました。

従来、SolanaのRPCノードでGeyser gRPCを利用するためには、Yellowstoneプラグインのインストールや複雑な設定作業が必要でしたが、今回SLVが提供する新機能を利用することで、**対話式の簡単な入力だけでGeyser gRPCノードを迅速かつ簡単にセットアップ**できるようになります。

## Geyser gRPCノードをわずか数ステップで構築可能に

![SLV RPC init](/news/2025/05/06/SLVrpcInit.jpg)

SLVの最新バージョンでは、コマンドラインからの簡単な質問に答えるだけで、以下の設定を自動で行うことができます。

- SSH接続の確認
- ノードの識別鍵（Identity key）の自動生成・管理
- Solana CLI との自動連携
- Jito ブロックエンジン地域の選択（例: Frankfurt）
- RPC/gRPCポートの設定
- RPCタイプの選択（Geyser gRPC、Index RPC、SendTx RPCなど）

これにより、複雑な作業を大幅に軽減し、ミスなくセットアップを完了できます。

## 専用ベアメタルサーバーで最適な運用を実現

![SLV Metals](/news/2025/05/06/BaremetalPriceJA.jpg)

Validators DAOの公式Discordコミュニティでは、SolanaのgRPCノード向けに最適化された専用ベアメタルサーバーの提供も開始しています。

- **サーバースペック**: AMD EPYC 9254 (4.15GHz, 24 Cores), 384GB ECC DDR5, 1TB x 2, 2TB x 2 NVMe, 3Gbps uplink, 月間転送量200TB
- **料金**: 月額 €580.00

この専用ベアメタルサーバーは、特に高負荷なgRPCストリーミングにも対応できる性能を備えており、ノード運用を効率的かつ安定的にサポートします。

- **Validators DAO 公式 Discord**: [https://discord.gg/C7ZQSrCkYR](https://discord.gg/C7ZQSrCkYR)

## 今後の展望

![SLV](/news/2025/03/22/SLV.jpg)

今回のリリースにより、SLVはSolanaエコシステム内でのGeyser gRPC運用のハードルを下げ、より多くのユーザーが迅速に最新のgRPCノードを構築・運用できるようになります。SLVチームは引き続き負荷テストやユーザーからのフィードバックをもとに機能改善を継続し、より高性能で安定したサービスの提供を目指してまいります。

## 関連リンク

- **SLV GitHub**: [https://github.com/ValidatorsDAO/slv](https://github.com/ValidatorsDAO/slv)
- **SLV ドキュメント（日本語）**: [https://slv.dev/ja](https://slv.dev/ja)
- **Validators DAO 公式 Discord**: [https://discord.gg/C7ZQSrCkYR](https://discord.gg/C7ZQSrCkYR)

SLVはこれからも、初心者から上級者まで幅広くSolanaネットワークの発展に寄与する機能を提供し続けてまいります。
