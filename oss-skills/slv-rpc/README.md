# SLV RPC Skill

Deploy and manage Solana RPC nodes (mainnet, testnet, devnet) with AI-powered interactive guidance.

## What This Does

This skill gives an AI agent the knowledge and tools to:
- **Deploy** Solana RPC nodes with guided setup
- **Manage** node lifecycle — start, stop, restart, update
- **Configure** multiple RPC types in a single skill
- **Build** Solana from source (Agave, Jito, Firedancer)
- **Install** Geyser plugins (Yellowstone gRPC, Richat)
- **Setup** Old Faithful for full-index RPC

Supported RPC types: `RPC`, `Index RPC`, `Geyser gRPC`, `Index RPC + gRPC`

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| `ansible-core` | >= 2.15 | `pip install ansible-core` |
| SSH access | — | Key-based auth to target server |

## Quick Start

### With OpenClaw
```bash
openclaw skill install slv-rpc

# "Deploy a mainnet Index RPC on 203.0.113.10"
```

### Manual Usage
```bash
cp examples/inventory.yml my-inventory.yml
# Edit with your server details

cd ansible/
ansible-playbook -i ../my-inventory.yml mainnet-rpc/init.yml \
  -e '{"rpc_type":"Index RPC","solana_version":"3.1.8"}'
```

## Contents

```
SKILL.md              — AI-readable playbook knowledge + deployment flow
AGENT.md              — Agent persona and behavior rules
README.md             — This file
examples/
  inventory.yml       — Sample Ansible inventory
ansible/
  mainnet-rpc/        — Mainnet playbooks
  testnet-rpc/        — Testnet playbooks
  devnet-rpc/         — Devnet playbooks
  cmn/                — Shared playbooks
jinja/
  mainnet-rpc/        — Mainnet config templates
  testnet-rpc/        — Testnet config templates
  devnet-rpc/         — Devnet config templates
```

## ERPC Snapshot Network

Servers purchased through [erpc.global](https://erpc.global/en/) automatically get access to ERPC's dedicated snapshot download endpoints — 7 global regions for fast node bootstrapping.

## License

Apache-2.0 — See [ValidatorsDAO/slv](https://github.com/ValidatorsDAO/slv)
