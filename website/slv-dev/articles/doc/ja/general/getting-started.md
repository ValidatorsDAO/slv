---
id: general-getting-started
title: SLV - Getting Started
description: SLV - Getting Started
---

![SLV](https://storage.slv.dev/SLVogp.jpg)

## The Toolkit for Solana Devs

SLVはSolana開発者向けのツールキットです。SolanaバリデータやRPC、Solanaベースのアプリケーションを開発、テスト、デプロイするためのツール一式を提供します。

リニューアルされた新しい SLV では、リモートマシンからすべての設定を完結できるようになり、ノードへの直接ログインが不要になりました。この方法により、ノードには必要最低限のパッケージのみがインストールされるため、不要なものが一切残りません。また、Linuxの設定にAnsible PlaybooksとJinja Templateを導入し、複数のバリデーターをより効率的かつ安全に管理・移行できるようになりました。

さらに、新しい SLV は起動時に常にダミーキー（「unstaked-identity.json」という無効なキー）を使用します。すべてが問題なく動作していることを確認したら、本番用のIdentityを設定し、アクティブキーに切り替えるだけです。この流れを徹底することで二重投票を防止し、ノードにアクセスできなくなった場合等の非常事態に備えることができます。

## Dependencies

### OS

MacOS または Linux

※ WindowsユーザーはWSL2をご利用ください。

Windows 10向け WSL2のインストール: https://docs.microsoft.com/en-us/windows/wsl/install

### Libraries

- Python3 [Install](https://www.python.org/downloads/)
- Ansible [Install](https://docs.ansible.com/ansible/latest/installation_guide/index.html)

## Installation

```bash
curl -fsSL https://storage.slv.dev/slv/install | sh
```
