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
│   ├── init.yml            # Full initialization (agave, jito, allnodes-jito; refuses the Firedancer types)
│   ├── init-jito.yml       # Jito-specific init
│   ├── init-firedancer.yml # Firedancer-specific init (refuses every host: Firedancer is not supported on mainnet)
│   └── ...
├── testnet-rpc/            # Testnet RPC
├── testnet-validator/      # Testnet Validator
├── devnet-rpc/             # Devnet RPC
jinja/                      # Jinja2 templates for config generation
```

### Key Concepts

1. **`validator_type`** — Controls the node software stack:
   - `agave` | `jito` | `allnodes-jito` | `firedancer-agave` | `firedancer-jito`
   - a mainnet voting validator is `agave`, `jito` or `allnodes-jito`: `mainnet-validator/init.yml` refuses the Firedancer types (see 6)

2. **`rpc_type`** — (Mainnet RPC only) Controls RPC features:
   - `Index RPC` | `Geyser gRPC` | `Index RPC + gRPC`

3. **`geyser_plugin`** — (RPC `init.yml`, inventory variable) The Geyser plugin of `Geyser gRPC` and `Index RPC + gRPC` nodes on agave or jito:
   - `yellowstone` — the default when the variable is absent; built by `geyser_build.yml` at `<network>_rpcs.geyser_version` of `versions.yml`
   - `richat` — richat has no release for agave 4.3 or later yet, so `init.yml` stops, before it changes anything, on a node that is set to run such an agave. The richat playbooks stay for when a release exists.
   - any other value stops `init.yml`. A node that ran richat gets `richat.service` stopped and disabled, and its plugin library moved aside (`librichat_plugin_agave.so` becomes `librichat_plugin_agave.so.disabled`; nothing is deleted, and `mv` returns it), when it is initialised with Yellowstone.

4. **All variables can be passed via `extra_vars`** — No need to edit `versions.yml`.

5. **`build_solana.yml` is preferred** over `install_solana.yml` (source build vs pre-built binary). It builds the `agave_version`, `jito_version` or `allnodes_jito_version` of the host or of `-e`, else `version_agave`, `version_jito` or `version_allnodes_jito` of the section of `versions.yml` that the calling playbook passes as `versions_section` (`mainnet_validators`, `testnet_validators`, `mainnet_rpcs`, `testnet_rpcs` or `devnet_rpcs`). With neither it stops, before it builds anything.

6. **`init.yml` of the validator and RPC networks stops, before it changes anything, on a client that Alpenglow does not run on.** `cmn/check_alpenglow_floor.yml` reads the versions that the init builds (the client of `validator_type` as in 5, and for an RPC node that gets the Yellowstone plugin the `geyser_version` of the host or of `-e`, else of the section) and compares them with the floor of the network: 4.3.0 on mainnet, 4.4.0-beta.0 on testnet and devnet. A version is read like the CLI reads it (`tests/alpenglow_floor_vectors.json` lists the cases): `4.2` is 4.2.0, `4.2.1.1` is 4.2.1, `3.1.10-bam` is 3.1.10, a `-jito` or `-allnodes` tag does not change the release, and a Yellowstone tag is read by the solana release it is built for (`+solana.4.4.0.beta.0` is 4.4.0-beta.0). A version with no X.Y in it (`latest`, `main`, a commit hash) stops a mainnet init and is only warned about on testnet and devnet. `mainnet-validator/init.yml` also refuses `firedancer-agave`, `firedancer-jito` and `frankendancer` (Alpenglow starts on mainnet at epoch 1064 and does not support them yet).

   The older entry points begin the same way: `mainnet-validator/init-jito.yml` and `init-allnodes-jito.yml`, `testnet-validator/init-agave.yml` and `init-firedancer.yml`, and `mainnet-rpc/init-old.yml` carry the type gate of their network's `init.yml` and the floor check, which reads the client that the entry point installs (`floor_client`) and the version its installer installs. `mainnet-validator/init-firedancer.yml` only sets up Firedancer, so it refuses every host on mainnet, and so do `mainnet-validator/setup_firedancer.yml` and `update_firedancer.yml`, which set up and update Firedancer.

   The playbooks that a CLI command runs on their own check the version they will install, before they change anything. `install_solana.yml`, `install_agave.yml` and `install_jito.yml` of the validator and RPC networks import the check and read the version the way the installer does (`-e`, else the pin of the section for a validator network; the host or `-e`, else the pin of the section for an RPC network); an RPC installer builds no plugin, so only its client is checked. `cmn/install_solana.yml`, which installs the `version` of the host or `-e` on a host of any of the five sections, checks that version, and has no default version any more: with none it stops. `mainnet-validator/install_allnodes_jito.yml` run on its own is not checked; it is checked when `mainnet-validator/install_solana.yml` runs it.

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
