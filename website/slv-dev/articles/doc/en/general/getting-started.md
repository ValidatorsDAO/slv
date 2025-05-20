---
id: general-getting-started
title: Getting Started
description: SLV - Getting Started
---

![SLV](https://storage.slv.dev/SLVogp.jpg)

## 🔨 The Toolkit for Solana Devs

SLV is a toolkit for Solana developers. It provides a complete set of tools for developing, testing, and deploying Solana validators, RPCs, and Solana-based applications.

The renewed SLV allows you to complete all configurations from a remote machine, eliminating the need to log in directly to the node. With this method, only the minimum necessary packages are installed on the node, leaving nothing unnecessary behind.

## 🔑 Keyless Operation Standardization

For new SLV deployments, **unstaked-keypair.json** is always used initially as the identity key for security purposes.

This is a best practice to prevent serious issues such as double voting.

Once you've confirmed that everything is working properly, you can set up your production Identity and switch to the active key.
By thoroughly following this process, you can prevent double voting and prepare for emergencies such as when you lose access to your node.

No key information is stored on the validator node. 🛡️

## ♻️ Zero-Downtime Migration
No more stopping your nodes for maintenance!
Validator nodes deployed with SLV can seamlessly migrate your Solana validator without any downtime.

A simple command ensures a safe, smooth, and uninterrupted server migration:

```bash
slv v switch
```

🔍 For detailed migration instructions, see the migration documentation.

## 🌐 Multiple Node Management

By introducing Ansible Playbooks and Jinja Templates for Linux configuration, you can now manage and migrate multiple validators more efficiently and securely.

### OS

MacOS or Linux

※ Windows users should use WSL2.

WSL2 installation for Windows 10: https://docs.microsoft.com/en-us/windows/wsl/install

### Libraries

- Python3 [Install](https://www.python.org/downloads/) (3.12 ~)
- Ansible
  [Install](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (2.16 ~)
- Solana [Install](https://docs.anza.xyz/cli/install)

## Installation

```bash
curl -fsSL https://storage.slv.dev/slv/install | sh
```

## Validator Deployment

Enter the necessary settings to start a validator.

```bash
slv v init
```

### Enter the default username

Typically, the default username is often `ubuntu` or `root`.

```bash
slv v init
? What's the user for the server? (ubuntu) › ubuntu
```

### Enter the server's IP address

Enter the IP address of your server.

```bash
? What's the IP address of the server? ›
```

### Set up RSA key for SSH

※ Please set the path to your RSA key. The default path is `~/.ssh/id_rsa`.

```bash
? What's the path to your RSA key? (~/.ssh/id_rsa) › ~/.ssh/id_rsa
🔍 Checking SSH connection...
✔︎ SSH connection succeeded
```

After that, SLV will check the connection to the server. If the connection is successful, you will proceed to the next step.

### Set a password for the solv user

Please set a password for the `solv` user on the server.

It should be at least 8 characters and include numbers, uppercase and lowercase letters.

```bash
? Please enter your password › *********
? Please confirm your password › *********
✔︎ Password saved to ~/.slv/config.pwd.yml
```

The encrypted password is saved to `~/.slv/config.pwd.yml`.


### Creating a Vote Account

To run a node as a validator, you must create a Vote account.

```bash
slv v gen:vote-account
```

To create a Vote account, the following information is required:

- **Identity**: The validator's identity account

- **Vote**:  The validator's vote account

- **Authority**: The account that holds authority over the vote account

- **Commission**: The validator's commission rate (0 ~ 100%)

You can enter this information interactively using the command above, or you can specify it directly through command-line arguments:

```bash
slv v gen:vote-account --pubkey <identity> --vote-account <vote> --auth-account <authority> --commission <commission>
```

The Vote account includes the validator's commission rate.
The commission rate can be specified within the range of 0 to 100%.


### Deploy a Solana node

- To deploy a mainnet validator: [Deploy a Mainnet Validator](/en/doc/mainnet-validator/quickstart)

- To deploy a testnet validator: [Deploy a Testnet Validator](/en/doc/testnet-validator/quickstart)

- To deploy an RPC server: [Deploy an RPC Server](/en/doc/mainnet-rpc/quickstart)
