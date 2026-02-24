# SLV AI Agent Skills

Self-contained skill packages that give AI agents the ability to deploy and manage Solana infrastructure.

Each skill includes Ansible playbooks, Jinja2 templates, interactive deployment flows, and agent behavior definitions — everything an AI needs to operate Solana nodes.

## Available Skills

| Skill | Description | Use Case |
|---|---|---|
| [**slv-validator**](slv-validator/) | Solana validator deployment & management | Mainnet/testnet validators (Jito, Agave, Firedancer) |
| [**slv-rpc**](slv-rpc/) | Solana RPC node deployment & management | Standard RPC, Index RPC, Geyser gRPC, Index+gRPC |
| [**slv-grpc-geyser**](slv-grpc-geyser/) | gRPC Geyser streaming node specialist | Yellowstone gRPC, Richat high-throughput streaming |

## How It Works

1. **Install a skill** into your AI coding agent (OpenClaw, Codex, Claude Code, etc.)
2. **Talk to your agent** — describe what you want to deploy
3. **The agent guides you** through an interactive setup, collecting server details and configuration
4. **Ansible deploys** your Solana node with production-ready settings

## Quick Start (OpenClaw)

```bash
# Install a skill
openclaw skill install slv-validator

# Deploy a validator
"Deploy a mainnet Jito validator on 203.0.113.10"
```

## Quick Start (Manual)

```bash
# Use the Ansible playbooks directly
cd slv-validator/ansible/
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"jito","solana_version":"3.1.8","snapshot_url":"https://..."}'
```

## Prerequisites

- **ansible-core** >= 2.15
- **SSH access** to target servers (key-based authentication)
- **solana-cli** (optional, for key generation)

## ERPC Network Benefits

Servers purchased through [erpc.global](https://erpc.global/en/) automatically benefit from:
- **Dedicated snapshot endpoints** — 7 global regions for fast node bootstrapping
- **Internal routing** — dramatically lower bandwidth costs vs public internet
- **Optimized throughput** — dedicated bandwidth for snapshot downloads (50-100+ GB)

## License

Apache-2.0 — [ValidatorsDAO/slv](https://github.com/ValidatorsDAO/slv)
