# SLV Ansible Template — Agent Guide

## ⚠️ SECURITY — READ FIRST

**This is a public OSS repository (ValidatorsDAO/slv).**

- **NEVER commit secrets, API keys, tokens, passwords, or private IPs**
- **NEVER commit .env files, credentials, or internal infrastructure details**
- **Double-check every diff before committing** — if in doubt, don't commit
- Use placeholder values (e.g., `YOUR_API_KEY`, `x.x.x.x`) in examples
- Ansible `extra_vars` are passed at runtime, not stored here

## Overview

This directory contains Ansible playbooks and Jinja2 templates for deploying and managing Solana nodes.

### Directory Structure

```
ansible/
├── cmn/                    # Common tasks (shared across all types)
│   ├── build_solana.yml    # Build Solana from source (preferred)
│   ├── create_user.yml     # Create solv user
│   ├── optimize_system.yml # System tuning
│   ├── mount_disks.yml     # Disk partitioning & mount
│   └── ...
├── mainnet-rpc/            # Mainnet RPC (Index RPC & Geyser gRPC)
│   ├── init.yml            # Full initialization playbook
│   ├── geyser_build.yml    # Yellowstone Geyser plugin build (the default of init.yml)
│   ├── geyser_richat_build.yml  # Richat Geyser build (geyser_plugin: richat; no richat release for agave 4.3+ yet)
│   └── ...
├── mainnet-validator/      # Mainnet Validator
│   ├── init.yml            # Full initialization (supports all validator_types)
│   ├── init-jito.yml       # Jito-specific init
│   ├── init-firedancer.yml # Firedancer-specific init
│   └── ...
├── testnet-rpc/            # Testnet RPC
├── testnet-validator/      # Testnet Validator
├── devnet-rpc/             # Devnet RPC
jinja/                      # Jinja2 templates for config generation
```

### Key Concepts

1. **`validator_type`** — Controls the node software stack:
   - `agave` | `jito` | `firedancer-agave` | `firedancer-jito` | `frankendancer`

2. **`rpc_type`** — (Mainnet RPC only) Controls RPC features:
   - `Index RPC` | `Geyser gRPC` | `Index RPC + gRPC`

3. **`geyser_plugin`** — (RPC `init.yml`, inventory variable) The Geyser plugin of `Geyser gRPC` and `Index RPC + gRPC` nodes on agave or jito:
   - `yellowstone` — the default when the variable is absent; built by `geyser_build.yml` at `<network>_rpcs.geyser_version` of `versions.yml`
   - `richat` — richat has no release for agave 4.3 or later yet, so `init.yml` stops, before it changes anything, on a node that is set to run such an agave. The richat playbooks stay for when a release exists.
   - any other value stops `init.yml`. A node that ran richat gets `richat.service` stopped and disabled when it is initialised with Yellowstone.

4. **All variables can be passed via `extra_vars`** — No need to edit `versions.yml`.

5. **`build_solana.yml` is preferred** over `install_solana.yml` (source build vs pre-built binary).

### Agent Assignments

| Agent | Specialty | Scope |
|-------|-----------|-------|
| **Cecil** | Validator | `mainnet-validator/`, `testnet-validator/` |
| **Tina** | RPC | `mainnet-rpc/`, `testnet-rpc/`, `devnet-rpc/` (except geyser) |
| **Cloud** | gRPC Geyser | Geyser-related files in all rpc dirs |

### Execution Pattern

```
API → kafka queue → ansible-api POST /apply
  → ansible-playbook -i "{ip}," -u solv {playbookPath} --extra-vars '{json}'
```
