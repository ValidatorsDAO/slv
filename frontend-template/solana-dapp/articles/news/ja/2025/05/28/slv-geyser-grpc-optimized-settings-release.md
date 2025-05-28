---
id: slv-geyser-grpc-optimized-settings-release
title: SLV、Solana Geyser gRPCにおけるパフォーマンス最適化リリース
category: プレスリリース
thumbnail: /news/2025/05/28/SLVgeyserGRPCoptimizedSettingsJA.jpg
---

ELSOUL LABO B.V.（本社：オランダ・アムステルダム、代表取締役CEO：川崎文武）とSolanaネットワークの分散化・セキュリティ強化を推進するValidators DAOは、オープンソースのSolanaバリデータツール「SLV」において、**Solana Geyser gRPCストリームの人気ユースケース向けにパフォーマンスと高負荷耐性を最適化した設定を公開しました。**

SLVを利用すれば、これまで複雑でわかりにくかったGeyser gRPCサーバーの設定を、デフォルトで最適化された状態で迅速に立ち上げることができます。

## ERPC運用ノウハウを活かした最適設定

![ERPC](/news/2025/05/23/ERPC.jpg)

私たちは日々、Solana RPCプロバイダーとして ERPC を運用し、多くの研究開発や運用上の知見を蓄積しています。また、Validators DAOコミュニティには、gRPCサーバーの安定稼働やパフォーマンスに関する多くのフィードバックが寄せられています。これらの豊富なデータと経験を基に、SLVの最新バージョンでは人気のユースケースで最大限のパフォーマンスと高負荷耐性を発揮する設定を標準搭載しました。

### 推奨サーバースペック

この最適化設定を効果的に運用するための推奨サーバースペックは以下のとおりです。

- CPU: 最低24コア以上、3.8GHz以上
- RAM: 384GB 以上 (DDR5推奨)

## 既存ユーザーの課題を解決

これまでGeyser gRPCサーバーをセットアップしたものの、適切な設定が不明確なためにダウンタイムやパフォーマンス低下を経験するユーザーが数多く存在しました。今回公開した設定は、このような課題を抱えるユーザーに最適な解決策を提供します。

以前の設定で運用に課題があった方も、ぜひ最新バージョンのSLVをお試しください。

- [Solana Geyser gRPC クイックスタートガイド](https://slv.dev/ja/doc/mainnet-rpc/quickstart/)

## 今後の取り組み

![SLV](/news/2025/03/22/SLV.jpg)

SLVは今後も貴重なユーザーの皆様からのフィードバックやさらなる負荷テストの結果を踏まえ、継続的に性能改善を進めてまいります。私たちはオープンソースコミュニティの一員として、Solanaネットワーク全体の性能と安定性向上に貢献していきます。

引き続きご支援・ご協力をお願い申し上げます。

## 関連リンク

- **SLV GitHub**: [https://github.com/ValidatorsDAO/slv](https://github.com/ValidatorsDAO/slv)
- **SLV ドキュメント（日本語）**: [https://slv.dev/ja](https://slv.dev/ja)
- **ERPC（日本語）**: [https://erpc.global/ja](https://erpc.global/ja)
- **Validators DAO 公式Discord**: [https://discord.gg/C7ZQSrCkYR](https://discord.gg/C7ZQSrCkYR)
