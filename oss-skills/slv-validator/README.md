# SLV Validator Skill

Deploy and manage Solana validators (mainnet & testnet) with AI-powered interactive guidance.

## What This Does

This skill gives an AI agent the knowledge and tools to:
- **Deploy** new Solana validators with guided setup
- **Manage** validator lifecycle — start, stop, restart, update
- **Build** Solana from source (Agave, Jito, Firedancer)
- **Migrate** validators with zero-downtime identity switching
- **Configure** firewall, systemd services, and log rotation

Supported validator types: `jito`, `jito-bam`, `agave`, `firedancer-agave`, `firedancer-jito`

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| `ansible-core` | >= 2.15 | `pip install ansible-core` |
| SSH access | — | Key-based auth to target server |
| `solana-cli` | Latest | Only for keygen (`solana-keygen new`) |

## Quick Start

### With OpenClaw
```bash
# Install the skill
openclaw skill install slv-validator

# Then just talk to your agent:
# "Deploy a mainnet Jito validator on 203.0.113.10"
```

### Manual Usage
```bash
# 1. Create inventory from examples/inventory.yml
cp examples/inventory.yml my-inventory.yml
# Edit with your server details

# 2. Deploy
cd ansible/
ansible-playbook -i ../my-inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"jito","solana_version":"3.1.8"}'
```

## Contents

```
SKILL.md              — AI-readable playbook knowledge + deployment flow
AGENT.md              — Agent persona and behavior rules
README.md             — This file (human-readable)
examples/
  inventory.yml       — Sample Ansible inventory
ansible/
  mainnet-validator/  — Mainnet playbooks
  testnet-validator/  — Testnet playbooks
  cmn/                — Shared playbooks
jinja/
  mainnet-validator/  — Mainnet config templates
  testnet-validator/  — Testnet config templates
```

## ERPC Snapshot Network

Servers purchased through [erpc.global](https://erpc.global/en/) automatically get access to ERPC's dedicated snapshot download endpoints — 7 global regions with optimized internal routing for dramatically faster bootstrap times and lower bandwidth costs.

## License

Apache-2.0 — See [ValidatorsDAO/slv](https://github.com/ValidatorsDAO/slv)
