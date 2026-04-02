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

# SLV — Solana Node Manager with AI Console

**Deploy and manage Solana validators, RPC nodes, and gRPC streaming in 3 commands.**

SLV is a CLI tool that handles the full lifecycle of Solana infrastructure — from bare metal to running node. The built-in AI Console lets you deploy and operate nodes through natural conversation.

<a href="https://solana.com/">
  <img src="https://storage.slv.dev/PoweredBySolana.svg" alt="Powered By Solana" width="200px" height="95px">
</a>

## 🆕 What's New

- **🟢 DoubleZero support** — First-class integration with the [DoubleZero](https://doublezero.xyz/) low-latency network
- **AI Console** — Deploy nodes through conversation with specialist AI agents
- **Performance tuning** — Automated CPU governor, IRQ pinning, and kernel optimization
- **Multi-region snapshots** — 7 global snapshot endpoints for fast node bootstrapping

## Quick Start

```bash
# 1. Install SLV
curl -fsSL https://storage.slv.dev/slv/install | sh

# 2. Configure your environment (AI provider, SSH keys, API keys)
slv onboard

# 3. Launch the AI Console
slv c
```

That's it. The AI Console guides you through everything:

```
You: Deploy a mainnet Jito validator on 203.0.113.10

Agent: I'll set up a mainnet Jito validator. Let me walk you through:
       - Checking SSH connectivity...
       - Generating validator identity and vote keys...
       - Building Solana from source...
       - Downloading snapshot from nearest region...
       - Starting validator and monitoring slot sync...
```

## What Can SLV Do?

| Task | Command |
|---|---|
| **Install SLV** | `curl -fsSL https://storage.slv.dev/slv/install \| sh` |
| **Initial setup** | `slv onboard` |
| **AI Console** (interactive) | `slv c` |
| **Check node status** | `slv check` |
| **Update Solana version** | `slv update` |
| **Server health** | `slv check grpc` / `slv check shreds` |

### Supported Node Types

- **Validators** — Jito, Agave, Firedancer (mainnet & testnet)
- **RPC Nodes** — Standard, Index, Geyser gRPC, Index+gRPC
- **gRPC Geyser Streaming** — Yellowstone, Richat

## AI Console Agents

The AI Console (`slv c`) includes specialist agents for different tasks:

| Agent | Role |
|---|---|
| **Cecil** | Validator deployments (Jito, Agave, Firedancer) |
| **Tina** | RPC & gRPC Geyser deployments |
| **Figaro** | Server procurement and pricing |
| **Setzer** | Trading bots and Solana apps |

Just describe what you need in plain language. The agent handles SSH, keys, builds, snapshots, firewall, and monitoring.

## How It Works

SLV uses **Ansible playbooks** and **Jinja2 templates** under the hood:

```
Your request → AI Agent → Ansible playbooks → Target server
```

**Design principles:**
- **Remote-only** — manage everything from your local machine, no SSH into nodes
- **Dummy key start** — validators start with unstaked identity, then hot-switch
- **Source builds** — Solana binaries built from GitHub source
- **Firewall-first** — SSH restrictions and nftables from day one
- **DoubleZero ready** — opt-in low-latency networking for validators and RPC

## Using AI Agent Skills (Advanced)

SLV also provides standalone AI agent skills that work with **any AI coding agent** — OpenClaw, Claude Code, Codex, Cursor, Windsurf, and more.

| Skill | What It Does |
|---|---|
| **[slv-validator](dist/oss-skills/slv-validator/)** | Deploy & manage validators |
| **[slv-rpc](dist/oss-skills/slv-rpc/)** | Deploy & manage RPC nodes |
| **[slv-grpc-geyser](dist/oss-skills/slv-grpc-geyser/)** | Deploy & manage gRPC Geyser streaming |

```bash
# OpenClaw (via ClawHub)
npx clawhub install slv-validator

# Claude Code — copy skill into your project
cp -r dist/oss-skills/slv-validator /your/project/.claude/skills/

# Any agent — add SKILL.md to your agent's context
cp dist/oss-skills/slv-validator/SKILL.md /your/project/AGENTS.md
```

Each skill includes SKILL.md (AI knowledge), Ansible playbooks, setup scripts, and example inventories. No lock-in — they're plain Markdown + Ansible.

## Using Without AI (Direct Ansible)

```bash
cd dist/oss-skills/slv-validator/ansible/

# Deploy a mainnet Jito validator
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"jito","solana_version":"v3.1.8-jito"}'

# Restart a validator
ansible-playbook -i inventory.yml mainnet-validator/restart_node.yml

# Build Solana from source
ansible-playbook -i inventory.yml cmn/build_solana.yml \
  -e '{"solana_version":"v3.1.8"}'
```

## ERPC Network Benefits

Servers from [erpc.global](https://erpc.global/en/) automatically get:
- **Dedicated snapshot endpoints** — 7 global regions
- **Internal routing** — lower bandwidth costs
- **Auto-detection** — SLV finds the nearest snapshot server via ping

## Prerequisites

- **ansible-core** >= 2.15 (`pip install ansible-core`)
- **SSH access** to target servers (key-based auth)
- **solana-cli** (optional, for local key generation)

`slv onboard` handles most of this automatically.

## For Developers

```bash
git clone https://github.com/ValidatorsDAO/slv.git
deno task dev --help
deno task build
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
