---
id: general-getting-started
title: Getting Started
description: SLV - Getting Started
---

![SLV](https://storage.slv.dev/SLVogp.jpg)

## 🔨 ソラナ開発者のためのツールキット

SLVはSolana開発者向けのツールキットです。SolanaバリデータやRPC、Solanaベースのアプリケーションを開発、テスト、デプロイするためのツール一式を提供します。

リニューアルされた新しい SLV では、リモートマシンからすべての設定を完結できるようになり、ノードへの直接ログインが不要になりました。この方法により、ノードには必要最低限のパッケージのみがインストールされるため、不要なものが一切残りません。

## 🔑 キーレスオペレーション標準化

新規SLVデプロイでは、安全確保のため最初は常に **unstaked-keypair.json** がアイデンティティキーとして使用されます。

これは二重投票など重大な問題を防止するためのベストプラクティスです。

すべてが問題なく動作していることを確認したら、本番用のIdentityを設定し、アクティブキーに切り替えるだけです。
この流れを徹底することで二重投票を防止し、ノードにアクセスできなくなった場合等の非常事態に備えることができます。

鍵に関する情報はバリデータノード内には一切保存されません。🛡️

## ♻️ ノーダウンタイム移行

もうメンテナンスのためにノードを停止する必要はありません！
SLVでデプロイされたバリデーターノードなら、Solanaのバリデーターをダウンタイムなしでシームレスに移行可能です。

シンプルなコマンドひとつで、安全かつスムーズなサーバー移転が実現します。

```bash
slv v switch
```

🔍 移行手順の詳細は [こちらのドキュメント](/ja/doc/mainnet-validator/migrate/)をご覧ください。

## 🌐 複数ノードの管理

Linuxの設定にAnsible PlaybooksとJinja Templateを導入し、複数のバリデーターをより効率的かつ安全に管理・移行できるようになりました。

### OS

MacOS または Linux

※ WindowsユーザーはWSL2をご利用ください。

Windows 10向け WSL2のインストール: https://docs.microsoft.com/en-us/windows/wsl/install

### 必要パッケージ

- Python3 [Install](https://www.python.org/downloads/) (3.12 ~)
- Ansible
  [Install](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (2.16 ~)
- Solana [Install](https://docs.anza.xyz/cli/install)

## SLV インストール

```bash
curl -fsSL https://storage.slv.dev/slv/install | sh
```

## バリデーターのデプロイ

バリデーターを起動するのに必要な設定を入力します。

```bash
slv v init
```

### デフォルトのユーザー名を入力

通常、デフォルトのユーザー名は `ubuntu` または `root` であることが多いです。

```bash
slv v init
? What's the user for the server? (ubuntu) › ubuntu
```

### サーバーの IP アドレスを入力

サーバーの IP アドレスを入力します。

```bash
? What's the IP address of the server? ›
```

### SSH 用の RSA キーを設定

※ ご自身の RSA キーのパスを設定してください。デフォルトのパスは `~/.ssh/id_rsa` です。

```bash
? What's the path to your RSA key? (~/.ssh/id_rsa) › ~/.ssh/id_rsa
🔍 Checking SSH connection...
✔︎ SSH connection succeeded
```

その後、SLV がサーバーへの接続をチェックします。接続が成功すると、次のステップへ進みます。

### solv ユーザーのパスワードを設定

サーバー上の `solv` ユーザー用のパスワードを設定してください。

8文字以上で、数字・大文字・小文字の英字を含めてください。

```bash
? Please enter your password › *********
? Please confirm your password › *********
✔︎ Password saved to ~/.slv/config.pwd.yml
```

暗号化されたパスワードは `~/.slv/config.pwd.yml` に保存されます。


### Vote アカウントの作成

ノードをバリデータとして稼働させる場合は、Vote アカウントを作成する必要があります。

```bash
slv v gen:vote-account
```

Vote アカウントの作成には、以下の情報が必要です。
- **Identity**: バリデーターの Identity アカウント
- **Vote**: バリデーターの Vote アカウント
- **Authority**: Vote アカウントの権限を持つアカウント
- **Commission**: バリデーターの手数料率（0 ~ 100%）

上記コマンドで対話式に入力することもできますが、コマンドライン引数で指定することも可能です。

```bash
slv v gen:vote-account --pubkey <identity> --vote-account <vote> --auth-account <authority> --commission <commission>
```

Vote アカウントにはバリデータの手数料率が含まれています。
手数料率は 0 ~ 100% の範囲で指定できます。


### Solana ノードのデプロイ

- メインネットバリデーターをデプロイする方はこちら: [メインネットバリデーターのデプロイ](/ja/doc/mainnet-validator/quickstart)

- テストネットバリデーターをデプロイする方はこちら: [テストネットバリデーターのデプロイ](/ja/doc/testnet-validator/quickstart)

- RPCサーバーをデプロイする方はこちら: [RPCサーバーのデプロイ](/ja/doc/mainnet-rpc/quickstart)
