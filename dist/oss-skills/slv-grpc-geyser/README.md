# SLV gRPC Geyser Skill

Deploy and manage Solana gRPC Geyser streaming nodes with AI-powered interactive guidance.

## What This Does

This skill gives an AI agent the knowledge and tools to:
- **Deploy** high-performance gRPC Geyser streaming nodes
- **Build** the Yellowstone gRPC Geyser plugin from source (Richat too, once a release supports agave 4.3 or later)
- **Manage** node lifecycle — start, stop, restart, update
- **Configure** gRPC ports, plugin settings, and streaming filters

Supported plugins:
- **Yellowstone gRPC** — Standard Geyser gRPC plugin ([rpcpool/yellowstone-grpc](https://github.com/rpcpool/yellowstone-grpc)); the default
- **Richat** — High-throughput Geyser plugin ([lamports-dev/richat](https://github.com/lamports-dev/richat)); chosen with `geyser_plugin: richat` in the inventory. Richat has no release for agave 4.3 or later yet, so `init.yml` stops on a node that is set to run such an agave.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| `ansible-core` | >= 2.15 | `pip install ansible-core` |
| SSH access | — | Key-based auth to target server |

## Quick Start

### With OpenClaw
```bash
openclaw skill install slv-grpc-geyser

# "Deploy a gRPC Geyser node on 203.0.113.10"
```

### Manual Usage
```bash
cp examples/inventory.yml my-inventory.yml
# Edit with your server details

cd ansible/
ansible-playbook -i ../my-inventory.yml mainnet-rpc/init.yml \
  -e '{"rpc_type":"Geyser gRPC","solana_version":"4.3.2"}'
```

## Contents

```
SKILL.md              — AI-readable playbook knowledge + deployment flow
AGENT.md              — Agent persona and behavior rules
README.md             — This file
examples/
  inventory.yml       — Sample Ansible inventory
ansible/
  mainnet-rpc/        — Playbooks (gRPC Geyser uses mainnet-rpc)
  cmn/                — Shared playbooks
jinja/
  mainnet-rpc/        — Config templates
```

## ERPC Snapshot Network

Servers purchased through [erpc.global](https://erpc.global/en/) automatically get access to ERPC's dedicated snapshot download endpoints — 7 global regions for fast node bootstrapping.

## License

Apache-2.0 — See [ValidatorsDAO/slv](https://github.com/ValidatorsDAO/slv)
