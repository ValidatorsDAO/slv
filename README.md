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

# SLV — AI-Powered Solana Node Deployment

**Deploy Solana validators, RPC nodes, and gRPC streaming infrastructure through natural conversation with AI agents.**

SLV provides Ansible playbooks, Jinja2 templates, and AI agent skills that let you deploy and manage Solana nodes by simply describing what you need. No manual configuration files, no memorizing commands — just tell your AI agent what to do.

<a href="https://solana.com/">
  <img src="https://storage.slv.dev/PoweredBySolana.svg" alt="Powered By Solana" width="200px" height="95px">
</a>

## Quick Start — Deploy with AI

### 1. Install an AI Agent Skill

```bash
# Using OpenClaw
npx clawhub install slv-validator    # Validator deployment
npx clawhub install slv-rpc          # RPC node deployment
npx clawhub install slv-grpc-geyser  # gRPC Geyser streaming
```

### 2. Talk to Your Agent

```
You: Deploy a mainnet Jito validator on 203.0.113.10

Agent: I'll set up a mainnet Jito validator. Let me walk you through the configuration:
       - Server IP: 203.0.113.10
       - What SSH user should I use? (default: solv)
       - Do you have existing validator identity and vote account keys,
         or should we generate new ones?
       ...
```

The AI agent guides you through the entire process interactively:

1. **Collects configuration** — server details, validator type, keys, network settings
2. **Validates inputs** — checks SSH connectivity, key formats, version compatibility
3. **Generates inventory** — creates Ansible inventory from your responses
4. **Offers dry-run** — shows what will happen before executing
5. **Deploys** — runs the appropriate Ansible playbooks
6. **Monitors** — tracks startup progress and slot sync

### 3. Manage Your Nodes

```
You: Restart the validator on 203.0.113.10
You: Update Solana to v3.1.8 on my RPC node
You: What's the slot sync status?
You: Switch validator identity with zero downtime
```

## Available Skills

| Skill | Install | What It Does |
|---|---|---|
| **[slv-validator](dist/oss-skills/slv-validator/)** | `npx clawhub install slv-validator` | Deploy & manage mainnet/testnet validators (Jito, Agave, Firedancer) |
| **[slv-rpc](dist/oss-skills/slv-rpc/)** | `npx clawhub install slv-rpc` | Deploy & manage RPC nodes (Standard, Index, Geyser gRPC, Index+gRPC) |
| **[slv-grpc-geyser](dist/oss-skills/slv-grpc-geyser/)** | `npx clawhub install slv-grpc-geyser` | Deploy & manage gRPC Geyser streaming (Yellowstone, Richat) |

Each skill includes:
- **SKILL.md** — Complete playbook knowledge for the AI agent
- **AGENT.md** — Interactive deployment flows and behavior rules
- **setup.sh** — Auto-install prerequisites (ansible-core, SSH, solana-cli)
- **examples/** — Sample inventory files

## Prerequisites

- **ansible-core** >= 2.15 (`pip install ansible-core`)
- **SSH access** to target servers (key-based authentication)
- **solana-cli** (optional, for local key generation)

Run the setup script to auto-install:
```bash
bash scripts/setup.sh
```

## How It Works

SLV uses **Ansible playbooks** and **Jinja2 templates** to deploy Solana nodes. The AI agent skills wrap this infrastructure with conversational interfaces:

```
User request → AI Agent (SKILL.md knowledge) → Ansible playbooks → Target server
```

**Key design principles:**
- **Remote-only** — all configuration from your local machine, no direct node logins
- **Dummy key start** — validators always start with an unstaked identity, then switch
- **Source builds** — Solana binaries built from GitHub source (no pre-built downloads)
- **Firewall-first** — SSH IP restrictions and nftables configured during init

## Using Without AI (Direct Ansible)

You can also use the playbooks directly:

```bash
cd dist/oss-skills/slv-validator/ansible/

# Deploy a mainnet Jito validator
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"jito","solana_version":"v3.1.8-jito","snapshot_url":"https://..."}'

# Restart a validator
ansible-playbook -i inventory.yml mainnet-validator/restart_node.yml

# Build Solana from source
ansible-playbook -i inventory.yml cmn/build_solana.yml \
  -e '{"solana_version":"v3.1.8"}'
```

## Using the SLV CLI

SLV also includes a standalone CLI for interactive deployment:

```bash
curl -fsSL https://storage.slv.dev/slv/install | sh
slv validator init
slv validator deploy
```

See [slv.dev](https://slv.dev/) for full CLI documentation.

## ERPC Network Benefits

Servers purchased through [erpc.global](https://erpc.global/en/) automatically get:
- **Dedicated snapshot endpoints** — 7 global regions for fast node bootstrapping
- **Internal routing** — dramatically lower bandwidth costs
- **Auto-detection** — SLV automatically finds the nearest snapshot server via ping

## For Developers

```bash
# Clone and run locally
git clone https://github.com/ValidatorsDAO/slv.git
deno task dev --help

# Build
deno task build

# Test
deno test -A
```

## Community

- [Validators DAO Discord](https://discord.gg/C7ZQSrCkYR)
- [Documentation](https://slv.dev/)
- [Twitter @slvSOLANA](https://twitter.com/slvSOLANA)

## Contributing

Bug reports and pull requests are welcome. This project follows the [Contributor Covenant](http://contributor-covenant.org) code of conduct.

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
