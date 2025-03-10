---
id: skeet-ver2-released
title: オープンソース TypeScript サーバーレスフレームワーク Skeet Ver.2 リリース
category: プレスリリース
thumbnail: /news/2024/03/01/SkeetVer2Released.jpg
---

ELSOUL LABO B.V.（エルソウルラボ、本社: オランダ・アムステルダム、代表取締役 CEO
川崎文武）は、オープンソースの TypeScript
製サーバレスアプリ開発ツール「Skeet」の Ver.2 リリースを発表しました。

新バージョンでは、より洗練されたアーキテクチャで管理が容易になり、テスト駆動開発もやりやすく、Firebase
の呼び出し可能関数の利用で更に高いセキュリティを実現しました。

データモデルから一瞬で Web API コードを生成する Scaffold 機能も搭載し、Skeet
開発者の生産性を向上させます。

## Skeet Ver.2 の主なアップデートについて

Skeet Ver.2 へのアップデートでは主に下記の改善を行いました。

### pnpm の導入

pnpm
の導入は、特に大規模なプロジェクトやモノリポを扱う際のパッケージ管理に革命をもたらします。ディスクスペースの節約とパッケージのインストール速度の向上は、開発サイクルの迅速化に直結します。GitHub
Actions との連携によるキャッシュの活用は、CI/CD
パイプラインの効率化に寄与し、ビルド時間の短縮はプロジェクトのアジリティを高めます。

https://pnpm.io/

### vitest の導入

vitest
への更新は、テスト駆動開発(TDD)の採用を促進し、品質保証プロセスを強化します。変更を検知して即座にテストを実行するデーモンモードの導入は、開発者がコードの変更に対するフィードバックを迅速に得られるようにし、バグの早期発見と修正を促進します。

https://vitest.dev/

### Changesets の導入

モノリポへの移行と Changesets
の導入は、バージョン管理とリリースプロセスの自動化に大きな利点をもたらします。これにより、複数のパッケージの依存関係を効率的に管理し、Changelog
の自動生成やリリースノートの作成を通じて、プロジェクトの透明性と追跡可能性が向上します。

https://github.com/changesets/changesets

### SQL テンプレート (Hono Web サーバー) Scaffold の導入

Prisma を使用したモデル定義から Hono Web サーバーを介した CRUD API
の自動生成は、アプリケーション開発の迅速化に貢献します。このアプローチは、データモデリングから
API
エンドポイントの実装までのプロセスを簡素化し、開発者がビジネスロジックにより集中できるようにします。

https://hono.dev/

### Firebase Functions 呼び出し可能関数に対応

Firebase Functions の呼び出し可能関数を利用することで、https
エンドポイントを公開することなく、自分たちの Firebase
アプリからのみ呼び出せる関数を作成することができます。これにより、セキュリティを大幅に向上させることができます。

https://firebase.google.com/docs/functions/callable?gen=2nd

## Skeet - TypeScript サーバーレスフレームワーク

![Skeet - TypeScript Serverless Framework](/news/2024/03/01/SkeetV2JA.jpg)

Skeet は、TypeScript
を使用したオープンソースのサーバーレスアプリ開発ツールで、以下の特徴を備えています：

- **インフラ設計や管理の省略:**
  インフラに関する準備や心配を減らし、開発者がアプリケーションのロジックに集中できる環境を提供。
- **迅速なアプリケーション開発:**
  高速な開発サイクルを実現し、小規模チームでもサービス運用が可能。
- **必要なものを必要な分だけ:** API サーバーから Web、iOS、Android
  アプリまで、必要なものを必要な分だけ迅速に開発。
- **AI サポートの充実:** 開発するアプリへの AI 統合はもちろん、Skeet
  のツール自体にも AI
  サポートが組み込まれており、フレームワークを覚えきる前からアプリ開発をスタートすることができます。
- **dApps、Web3 アプリ対応:**
  ブロックチェーンを利用したアプリケーション開発にも対応し、モジュール式で拡張可能な現代的アプリケーションフレームワークとして設計されています。

詳しくは公式ドキュメントをご覧ください。また、公式 Discord
コミュニティでは、Skeet
開発者が集まり、日々最新情報の公開や議論が行われています。ぜひご参加ください。

Skeet 公式ドキュメント: https://skeet.dev/ja/

Discord コミュニティ: https://discord.com/invite/H2HeqRq54J
