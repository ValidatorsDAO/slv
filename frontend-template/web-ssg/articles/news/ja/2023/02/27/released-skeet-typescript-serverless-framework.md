---
id: released-skeet-typescript-serverless-framework
title: オープンソースのTypeScript製サーバーレスフレームワーク「Skeet」をリリースしました
category: プレスリリース
thumbnail: /news/2023/02/27/skeet.png
---

ELSOUL LABO B.V. (本社: オランダ・アムステルダム)は、オープンソースの TypeScript
製フルスタックサーバーレスアプリケーションフレームワークの「Skeet」のリリースを発表しました。

Skeet: https://skeet.dev

## アプリの開発・メンテナンスコストを下げる

![Skeet Top](/news/2023/02/27/skeet-top-ja-fix.png)

アプリ開発によって改善できるポイントは街中に溢れています。

しかし実際にアプリを作って公開しようとすると、割と広範囲に渡る知識と技術が必要になってくるため、多くのチームが苦戦を強いられているのが現状です。

迅速な開発とメンテナンス性の両立はいつも難しく、その上でスケーリング時の複雑な事象を解決する必要があるため、再現性のある開発環境を手に入れるまで時間がかかります。

そんな中、今もなお IT
リソース不足は加速しており、ほぼすべての現場で開発リソースが足りていません。

私達はアプリケーションの開発及びメンテナンスコストを下げることでこの問題に対処したいと考えています。

Skeet はオープンソースの TypeScript
製フルスタックサーバーレスアプリケーションフレームワークです。

少人数の開発者で素早くアプリを立ち上げ、長期的にメンテナンスしていくことを可能にします。

## 選ばれたのは TypeScript でした

Ruby から Rust
まで様々な言語を試し、それぞれに良し悪しを感じていましたが、TypeScript
は非常にバランスの良い言語だと感じています。スクリプト言語の扱いやすい側面がありながら、柔軟な型システムが全体に安全をもたらし、規模が大きくなっても開発・メンテナンスしやすいコードを保ちやすくしてくれます。それでいて高速に動作してくれるので、本当に感謝しています。

近年の Node.js エコシステムの発展には目覚ましいものがあります。

今や Prisma は非常に優れたデータ ORM
になっていて、スキーマ駆動の高速開発を可能にしてくれる上に N+1
問題等、結局対処しなければならない問題を自動的に最適化して解決くれます。今まで手間だった
DB マイグレーションも、Prisma
スキーマの変更に合わせて自動で対処することで簡潔化されました。Skeet は Nexus
と組み合わせて、Prisma スキーマから GraphQL
エンドポイント(リゾルバ)までを自動生成しています。

TypeScript x ESLint x Prettier とエディタ補完(VSCode
推奨)の相性は抜群で、高速かつミスを減らす開発環境を手に入れることができます。

## デプロイの準備はできています

デプロイはアプリケーション開発者を悩ませてきました。印象的にはローカル環境と本番環境とはいつも違うもののように感じます。ログはなぜデフォルトで生まれて来ないのでしょうか？？

Skeet
はこのあたりの問題を解消しています。プロジェクトは最初からデプロイ可能な状態で生まれ、すべてコンテナ化されています。GitHub
Actions による CI / CD
を標準装備しており、継続的に変更をテストし、通ったものはデプロイをしていく設計になっています。

ロードバランサーを用いた柔軟なアクセススケールとクラウドアーマーによるセキュリティに対応。自動スケールする
Cloud Run は API、Worker
共にプライベートネットワーク内で動作させることができます。タスク処理にはクラウドタスクを利用して通信を安定化させる設計になっていて、Skeet
CLI 上からすべてデプロイ・管理することができるようになっています。

これらすべてのログはクラウドログ(管理画面)に出力されるようになっているため、管理者はどこにいても安全にサービスの状態を確認することができます。

Skeet
ではデータモデルを設計したらすぐにビジネスモデルを書き始めることができ、継続デプロイと中規模までスケールするアプリの公開環境が手に入ります。

Skeet ドキュメント: https://skeet.dev/doc/

## ロードマップ

今後のロードマップとして、まずはドキュメントの充実を図ります。

Skeet
バックエンドはすでに利用可能な状態にあり、開発者のフィードバックを求めています。

Skeet フロントエンドは現在 React Native にて開発中ですが近日公開予定です。Web
メディア用の SSG テンプレートは CLI
に組み込まれ、コマンドから作成可能になる予定ですが、現在はテンプレートリポジトリを公開しています。(https://github.com/elsoul/skeet-web-template)

Skeet
を使って沢山の役に立つアプリケーションサービスが生まれていくことを願っています。
今後とも Skeet をよろしくお願いいたします。

Skeet Dev チーム一同
