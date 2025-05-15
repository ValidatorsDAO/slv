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

<a href="https://solana.com/">
  <img src="https://storage.slv.dev/PoweredBySolana.svg" alt="Powered By Solana" width="200px" height="95px">
</a>

# SLV Official Documentation

Doc Link: [https://slv.dev/](https://slv.dev/)

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

- Python3 [Install](https://www.python.org/downloads/) (3.12 ~)
- Ansible 
  [Install](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (2.16 ~)
- Solana [Install](https://docs.anza.xyz/cli/install) 

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
Usage:   slv validator
Version: 0.9.26       

Description:

  🛠️ Manage Solana Validator Nodes 🛠️

Options:

  -h, --help  - Show this help.  

Commands:

  init                - 🚀 Initialize a new validator configuration                    
  deploy              - 📦 Deploy Validators                                           
  list                - 📋 List validators                                             
  set:identity        - 🪪  Set Validator Identity                                     
  set:unstaked        - 🔄 Set Validator Identity to Unstaked Key                      
  setup:firedancer    - 🔥 Setup/Update Firedancer Validator                           
  update:version      - ⬆️  Update Validator Version                                    
  update:script       - ⚙️  Update Validator Startup Config                             
  start               - 🟢 Start Validator                                             
  stop                - 🔴 Stop Validator                                              
  restart             - ♻️  Restart Validator                                           
  cleanup             - 🧹 Cleanup Validator - Remove Ledger/Snapshot Unnecessary Files
  get:snapshot        - ⚡️ Download Snapshot with aria2c ⚡️                            
  update:allowed-ips  - 🛡️  Update allowed IPs for mainnet validator nodes              
  switch              - 🔁 Switch Validator Identity - No DownTime Migration
```

### New Features - Snapshots Download with aria2

SLV now supports downloading snapshots with aria2.

```bash
slv v get:snapshot
```
This command will download the latest snapshot.

### New Features - Agave Testnet Validator Init & Deploy

Now you can deploy Solana Agave Testnet Validators with SLV.

```bash
slv v init
? Select Solana Network (testnet)
❯ testnet
  mainnet
? Select Validator Type (agave) › agave
> agave
  firedancer
```


### New Features - Firedancer Mainnet Validator Init & Deploy

Now you can deploy Solana Mainnet Validators with SLV.

```bash
slv v init
? Select Solana Network (testnet)
  testnet
❯ mainnet
? Select Validator Type (jito) › firedancer
  jito
> firedancer
```

### New Features - Solana RPC Init & Deploy (Geyser Yellowstone gRPC Plugin)

Now you can deploy Solana RPC nodes with SLV.
This feature includes the ability to deploy Geyser gRPC Plugin.

```bash
slv rpc init
```


### Introducing SLV Metal – Optimized Bare Metal for Solana Nodes ⚡️

SLV Metal is a high-performance bare metal server designed specifically for Solana nodes. 
Choosing the right server for Solana can be challenging, so we provide a curated list of fully optimized servers.

From hardware specs to network performance and Linux configuration, everything is fine-tuned for maximum efficiency. With SLV Metal, you can deploy Solana nodes in just a few commands.

```bash
slv metal list
? 🛡️ Select SLV BareMetal Type (validator)
❯ 🧪 For Solana Testnet Validator
  💰 For Solana Mainnet Validator
  ⚡️ RPC - For Solana RPC Node
  📦 APP - For Trade Bot, DApp and More!
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
```

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
slv v deploy -n testnet -p EjDwu2Czy8eWEYRuNwtjniYks47Du3KNJ6JY9rs3aFSV
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
│ Version        │ 0.406.20113                                  │
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

### Update slv

If you want to update the slv template, you can use the following command.

```bash
slv upgrade
```

### slv Validator Commands

```bash
Usage:   slv  
Version: 0.9.2

Description:

  slv is a Toolkit for Solana Developers

Options:

  -h, --help     - Show this help.                            
  -V, --version  - Show the version number for this program.  
  -P, --print    - Print slv ASCII Art                        

Commands:

  upgrade       - Upgrade slv to the latest version                                
  bot, b        - Manage Solana gRPC Geyser Client                                 
  app           - Manage Solana Applications                                       
  validator, v  - Manage Solana Validator Nodes                                    
  rpc, r        - Manage Solana RPC Nodes                                          
  cloud, c      - Manage Solana Cloud-based Applications                           
  swap, s       - Manage Solana Swap                                               
  metal, m      - 🚀 SLV BareMetal: High-Performance Servers Built for Solana Nodes
  signup        - Signup to SLV using Discord                                      
  login         - Login to SLV using Discord                                       
  check         - Check RPC and gRPC endpoints  
```

### Community Support

If you have any questions or need help, please join our Discord community.

[Validators DAO Discord](https://discord.gg/C7ZQSrCkYR)

## Roadmap

- [x] Add `slv validator init` for Solana Validator Deploy (in progress)
- [x] Add `slv rpc init` for Solana RPC Build (in progress)
- [x] Add CI/CD pipeline (Github Actions) for `slv` Release
- [] Add `slv bot` for gRPC Geyser Client (in progress)
- [] Add `slv swap` for Solana Token Swap (in progress)
- [] Add `slv cloud` for configuring Solana App on Cloud (in progress)
- [] Add `slv app` for Solana App Development (in progress)
- [x] Add `test` for keeping the codebase stable (in progress)

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

## Release Process

SLV uses GitHub Actions for automated releases. The process is as follows:

1. Update the version in `cmn/constants/version.ts`
2. Create and push a tag with the new version (e.g., `v0.6.1`)
3. GitHub Actions will automatically:
   - Run tests
   - Update all version references
   - Build the binaries
   - Upload artifacts to storage
   - Create a GitHub release

For heavy compilation tasks, SLV can use a remote build server:

1. Set up a Ubuntu 24.04 LTS server
2. Configure the server in `ansible/inventory.yml`
3. Use the remote build workflow:
   ```bash
   # Manually trigger the workflow
   gh workflow run slv-remote-build.yml -f version=0.6.1

   # Or push a tag
   git tag v0.6.1
   git push origin v0.6.1
   ```

See the `ansible/README.md` file for more details on remote builds. Improvements
are always welcome!

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
