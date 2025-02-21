<p align="center">
  <a href="https://slv.dev/" target="_blank">
    <img src="https://storage.slv.dev/SLVogp.jpg" alt="SLV" />
  </a>

<a href="https://twitter.com/intent/follow?screen_name=slvSOLANA" target="_blank">
    <img src="https://img.shields.io/twitter/follow/slvSOLANA.svg?label=Follow%20@slvSOLANA" alt="Follow @slvSOLANA" />
  </a>
<a aria-label="License" href="https://github.com/ValidatorsDAO/slv/blob/master/LICENSE.txt">
    <img alt="" src="https://badgen.net/badge/license/Apache/blue">
  </a>
    <a aria-label="Code of Conduct" href="https://github.com/ValidatorsDAO/slv/blob/master/CODE_OF_CONDUCT.md">
    <img alt="" src="https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg">
  </a>
</p>

**Everything you need for Solana development is here💃**

**Launch validators, RPCs, and dApps at blazing speed⚡️**

## The Toolkit for Solana Devs

SLV is a toolkit for Solana developers. It provides a set of tools to help
developers build, test, and deploy Solana Validators and Solana-based
applications.

In the newly revamped slv, you can complete all configurations from a remote
machine—no more direct node logins required. This approach ensures that only
essential packages are installed on the node, leaving behind no unnecessary
clutter. We’ve also introduced Ansible Playbooks & Jinja Template for Linux
configuration, allowing us to manage and migrate multiple validators with
greater efficiency and security.

Additionally, the new slv always uses a dummy key (an invalid key named
“unstaked-identity.json”) for its initial startup. Once you confirm everything
is running smoothly, you simply set the actual Identity and switch to the active
key. Following this consistent flow helps prevent double votes and ensures
you’re prepared in case the node ever becomes unreachable.

We’ll continue to provide method documentation along the way, and we look
forward to your ongoing support!

[Validators DAO Discord](https://discord.gg/C7ZQSrCkYR)

## Dependencies

### OS

MacOS or Linux

※ Please use WSL2 for Windows users.

Download WSL2 For Windows 10
[https://docs.microsoft.com/en-us/windows/wsl/install](https://docs.microsoft.com/en-us/windows/wsl/install)

### Libraries

- Python3 [Install](https://www.python.org/downloads/)
- Ansible
  [Install](https://docs.ansible.com/ansible/latest/installation_guide/index.html)

## Installation & Validator Launch

Install slv CLI

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

New slv Deployment is always use `unstaked-keypair.json` for the identity key.
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

※ Please set the path to your RSA key. The default path is `~/.ssh/id_rsa`.

```bash
? What's the path to your RSA key? (~/.ssh/id_rsa) › ~/.ssh/id_rsa
🔍 Checking SSH connection...
✔︎ SSH connection succeeded
```

Then slv will check the connection to the server. If the connection is
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
✔ Inventory updated to ~/.slv/inventory.testnet.validators.yml
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

$ slv v deploy -n testnet
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
│ Version        │ 0.305.20111                                  │
└────────────────┴──────────────────────────────────────────────┘
? Do you want to continue? (Y/n) › Yes
```

It's done! Your Solana Validator is now deployed. It will take some time to
catch up with the Solana network.

Next, You need to change the identity key from the unstaked key to the
authorized identity key.

### If your firedancer deployment freezes during firedancer compile

If your Firedancer deployment stops responding during the compile process, it
may be due to a network issue. To resolve this, please try setting it up again
by running the following command:

```bash
slv v setup:firedancer --pubkey <your-identity-pubkey>
```

(Please try a few times if the issue persists.)

And then, start firedancer.

You can run Ansible Playbook with the following command.

```bash
slv v apply -n testnet --pubkey <your-identity-pubkey> --yml <path-to-yml>
```

So start firedancer with the following command.

```bash
slv v apply -n testnet --pubkey <your-identity-pubkey> --yml ~/.slv/template/0.5.0/ansible/testnet-validator/start_firedancer.yml
```

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

### Update slv Template

If you want to update the slv template, you can use the following command.

```bash
slv upgrade
mkdir -p ~/.slv/testnet-validator
cp -r ~/.slv/template/$VERSION/jinja/testnet-validator/* ~/.slv/testnet-validator/
```

### slv Validator Commands

```bash
Usage:   slv validator
Version: 0.5.0        

Description:

  Manage Solana Validator Nodes

Options:

  -h, --help  - Show this help.  

Commands:

  init              - Initialize a new validator                                       
  deploy            - Deploy Validators                                                
  list              - List validators                                                  
  set:identity      - Set Validator Identity                                           
  set:unstaked      - Set Validator Identity to Unstaked Key Stop/Change Identity/Start
  restart           - Restart validator                                                
  setup:firedancer  - Setup Firedancer Validator                                       
  update:version    - Update Validator Version                                         
  apply             - Apply Ansible Playbook                                          
  codebot           - CodeBot Validator Config
```

### Community Support

If you have any questions or need help, please join our Discord community.

[Validators DAO Discord](https://discord.gg/C7ZQSrCkYR)

## Roadmap

- [x] Add `slv validator init` for Solana Validator Deploy (in progress)
- [] Add `slv rpc init` for Solana RPC Build (in progress)
- [] Add `slv validator setup --relayer` for Solana Validator Relayer Build (in
  progress)
- [] Add `slv validator setup --shredstream` for ShredStream Node Build (in
  progress)
- [] Add CI/CD pipeline (Github Actions) for `slv` Release (in progress)
- [] Add `slv bot` for gRPC Geyser Client (in progress)
- [] Add `slv swap` for Solana Token Swap (in progress)
- [] Add `slv cloud` for configuring Solana App on Cloud (in progress)
- [] Add `slv app` for Solana App Development (in progress)
- [] Add `slv app create --blinks` for Solana Blinks App Development (in
  progress)
- [] Add `slv ai` Fine-tuning AI Models for Solana Validator/RPC Debugging (in
  progress)
- [] Add `test` for keeping the codebase stable (in progress)

## For Developers

Install Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
```

Run slv CLI

```bash
git clone https://github.com/ValidatorsDAO/slv.git
deno task dev --help
```

Run Build

```bash
deno task build
```

Run Test

```bash
deno test -A
```

## Contributing

Bug reports and pull requests are welcome on GitHub at
https://github.com/ValidatorsDAO/slv This project is intended to be a safe,
welcoming space for collaboration, and contributors are expected to adhere to
the [Contributor Covenant](http://contributor-covenant.org) code of conduct.

## Dependencies for Development

- deno 2.x.x

## License

The package is available as open source under the terms of the
[Apache-2.0 License](https://www.apache.org/licenses/LICENSE-2.0).

## Code of Conduct

Everyone interacting in the SLV project’s codebases, issue trackers, chat rooms
and mailing lists is expected to follow the
[code of conduct](https://github.com/ValidatorsDAO/slv/blob/master/CODE_OF_CONDUCT.md).
