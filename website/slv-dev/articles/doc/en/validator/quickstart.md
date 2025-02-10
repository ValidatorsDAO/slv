---
id: validator-quickstart
title: Solana Validator Quickstart
description: SLV - Solana Validator Quickstart
---

## Installation & Validator Launch

```bash
curl -fsSL https://storage.slv.dev/slv/install | sh
slv validator init
slv validator deploy
```

## Usage

```bash
slv v --help
```

## Deploy Solana Validator Testnet with Firedancer

You must have Ubuntu 24.04 LTS clean installed on your server.

This command will prompt you to provide necessary information to deploy.

New SLV Deployment is always use `unstaked-keypair.json` for the identity key.
This is the best practice to avoid double voting, and etc.

So Please make sure to set the authorized identity key with `slv v set:identity`
after the deployment.

### Input Server's Default Username

Most of the time, the default username is `ubuntu`.

```bash
slv v init
? What's the user for the server? (ubuntu) › ubuntu
```

### Input Server's IP Address

Input the IP address of the server.

```bash
? What's the IP address of the server? ›
```

### Set RSA Key for SSH

※ Please set the path to your RSA key. The default path is `~/.ssh/id_rsa`. ※
Currently, only the default path is supported.Please set the path to your RSA
key. The default path is `~/.ssh/id_rsa`.

```bash
? What's the path to your RSA key? (~/.ssh/id_rsa) › ~/.ssh/id_rsa
🔍 Checking SSH connection...
✔︎ SSH connection succeeded
```

Then SLV will check the connection to the server. If the connection is
successful, the next step will be prompted.

### Set the solv user password

Please set the password for the `solv` user of the server.

**8 characters or more, including numbers, uppercase and lowercase letters**

```bash
? Please enter your password › *********
? Please confirm your password › *********
✔︎ Password saved to ~/.slv/config.pwd.yml
```

Encrypted password will be saved to `~/.slv/config.pwd.yml`.

### Select the Solana Network

Select the Solana Network you want to deploy. ※ Currently, only the testnet is
supported.

```bash
? Select Solana Network (testnet)
❯ testnet
  mainnet
```

### Generate or Set the Solana Validator Identity

You can generate a new identity key or set an existing identity key. This
example shows how to set an existing identity key.

```bash
? Do you want to create a new identity key now? (Y/n) › No
? Please Enter Your Identity Public Key › EjDwu2Czy8eWEYRuNwtjniYks47Du3KNJ6JY9rs3aFSV
⚠️ Please place your identity key in

  ~/.slv/keys/EjDwu2Czy8eWEYRuNwtjniYks47Du3KNJ6JY9rs3aFSV.json
.
.
✔︎ Success
✔ Inventory updated to ~/.slv/inventory.yml
✔ Successfully created solv user on x.x.x.x
```

Please place your identity key in `~/.slv/keys/<your-pubkey>.json`. Then, slv
will create solv user with your password.

### Generate or Set the Solana Vote Account

You can generate a new vote account key or set an existing vote account key.
This example shows how to set an existing vote account key.

```bash
? Do you want to create a new vote account key now? (Y/n) › No
? Please Enter Your Vote Account Public Key > <your-vote-account>
⚠️ Please place your voteAccount pubkey in

  ~/.slv/keys/<your-vote-account>.json
```

Please place your vote account key in `~/.slv/keys/<your-vote-account>.json`.

### Set Your Authority Public Key

Please input your authority public key. This key is used to withdraw rewards
from the vote account.

```bash
? Please Enter Your Vote Account's Authority Key › <your-authority-pubkey>
✔︎ Validator testnet config saved to ~/.slv/inventory.testnet.validators.yml

Now you can deploy with:

$ SLV v deploy -n testnet
```

Now your configuration is saved to `~/.slv/inventory.testnet.validators.yml`.

### Deploy the Solana Validator

Once you confirm the configuration, the deployment will start.

```bash
slv v deploy -n testnet
Your Testnet Validators Settings:
┌────────────────┬──────────────────────────────────────────────┐
│ Identity Key   │ EjDwu2Czy8eWEYRuNwtjniYks47Du3KNJ6JY9rs3aFSV │
├────────────────┼──────────────────────────────────────────────┤
│ Vote Key       │ EwoVPLUhdhm722e7QWk8GMQ43917qRXiC9HFyefEMiSV │
├────────────────┼──────────────────────────────────────────────┤
│ Authority Key  │ EcT4NsMPwxanusdy3dza5nznqwuKo9Pz3GzW5GPD32SV │
├────────────────┼──────────────────────────────────────────────┤
│ IP             │ x.x.x.x                                      │
├────────────────┼──────────────────────────────────────────────┤
│ Validator Type │ firedancer                                   │
├────────────────┼──────────────────────────────────────────────┤
│ Version        │ 0.302.20104                                  │
└────────────────┴──────────────────────────────────────────────┘
? Do you want to continue? (Y/n) › Yes
```

It's done! Your Solana Validator is now deployed. It will take some time to
catch up with the Solana network.

Next, You need to change the identity key from the unstaked key to the
authorized identity key.

### Change the Identity Key from Unstaked Key to Authorized Identity Key

After the deployment, you need to change the identity key from the unstaked key

to the authorized identity key.

```bash
slv v set:identity -n testnet --pubkey <your-identity-pubkey>
```

Then, the identity key will be changed to the authorized identity key. This
command will stop firedancer, change the identity key, and restart the
firedancer.

※ No downtime Migration is not available with Firedancer yet. We will updated as
soon as it's available.

### Restart Firedancer

If you have any issues with the validator, you can restart the firedancer with
the following command.

If you use the `--rm` option, the validator will be stopped and removed ledger
and snapshot dirs, and Download Snapshot with the snapshot finder and start the
validator.

```bash
slv v restart -n testnet --pubkey <your-identity-pubkey> --rm
```

### SLV Validator Commands

```bash
Usage:   SLV validator
Version: 0.3.1

Description:

  Manage Solana Validator Nodes

Options:

  -h, --help  - Show this help.

Commands:

  init          - Initialize a new validator
  deploy        - Deploy Validators
  list          - List validators
  set:identity  - Set Validator Identity
  set:unstaked  - Set Validator Identity to Unstaked Key Stop/Change Identity/Start
  restart       - Restart validator
```
