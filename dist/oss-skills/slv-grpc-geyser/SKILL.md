# SLV gRPC Geyser Skill

Ansible playbooks and Jinja2 templates for deploying and managing Solana gRPC Geyser streaming nodes.

## Supported Configurations

| Config | Description |
|---|---|
| Yellowstone gRPC | Standard Geyser gRPC plugin (Triton/rpcpool) |
| Richat gRPC | Richat Geyser plugin (lamports-dev) |

## Directory Structure

```
ansible/
  mainnet-rpc/   — Playbooks (gRPC Geyser uses mainnet-rpc playbooks)
  cmn/           — Shared common playbooks
jinja/
  mainnet-rpc/   — Jinja2 templates
  cmn/           — Shared templates
```

## CLI Command ↔ Playbook Mapping

gRPC Geyser nodes are managed via `slv r` (RPC) commands with `rpc_type` set to `Geyser gRPC` or `Index RPC + gRPC`.

| CLI Command | Playbook | Description |
|---|---|---|
| `slv r deploy` | `mainnet-rpc/init.yml` | Full gRPC Geyser node initialization |
| `slv r start` | `mainnet-rpc/start_node.yml` | Start node |
| `slv r stop` | `mainnet-rpc/stop_node.yml` | Stop node |
| `slv r restart` | `mainnet-rpc/restart_node.yml` | Restart node |
| `slv r build:solana` | `mainnet-rpc/install_solana.yml` | Build Solana from source |
| `slv r update:geyser` | `mainnet-rpc/update_geyser.yml` | Update Geyser plugin |
| `slv r update:script` | `mainnet-rpc/update_startup_config.yml` | Update start-validator.sh |
| `slv r setup:firedancer` | `mainnet-rpc/setup_firedancer.yml` | Setup Firedancer |

## Key Playbooks

| Playbook | Description |
|---|---|
| `init.yml` | Full gRPC Geyser node initialization |
| `init_richat_geyser.yml` | Richat Geyser initialization |
| `geyser_build.yml` | Build Yellowstone gRPC from GitHub source |
| `geyser_richat_build.yml` | Build Richat plugin from GitHub source |
| `install_richat.yml` | Install Richat plugin |
| `update_geyser.yml` | Update Geyser plugin |
| `restart_node.yml` | Restart node |
| `start_node.yml` / `stop_node.yml` | Start/stop node |
| `update_startup_config.yml` | Update start-validator.sh from template |
| `setup_firedancer.yml` | Setup Firedancer |
| `run_snapshot_finder.yml` | Find and download best snapshot |
| `run_restarter.yml` | Run restarter script |

## Geyser Build Details

### Yellowstone gRPC (`geyser_build.yml`)
- Clones from https://github.com/rpcpool/yellowstone-grpc
- Builds with `cargo build --release`
- Produces `libyellowstone_grpc_geyser.so`
- Config template: `jinja/mainnet-rpc/geyser.json.j2`

### Richat (`geyser_richat_build.yml`)
- Clones from https://github.com/lamports-dev/richat
- Builds with `cargo build --release`
- Produces `librichat_plugin_agave.so`
- Config template: `jinja/mainnet-rpc/geyser-richat.json.j2`
- Service template: `jinja/mainnet-rpc/richat.service.j2`
- Settings template: `jinja/mainnet-rpc/richat-setting.yml.j2`

## Key Variables (extra_vars)

| Variable | Description | Default |
|---|---|---|
| `rpc_type` | Must be `Geyser gRPC` or `Index RPC + gRPC` | — |
| `validator_type` | Client type (`agave`, `jito`, `firedancer-agave`, etc.) | — |
| `solana_version` | Solana/Agave version | — |
| `yellowstone_grpc_version` | Yellowstone gRPC version tag | — |
| `richat_version` | Richat plugin version (e.g. `richat-v8.1.0`) | — |
| `snapshot_url` | Snapshot download URL | — |
| `port_grpc` | gRPC listen port | `10000` |
| `limit_ledger_size` | Ledger size limit | `100000000` |

## Jinja Templates

| Template | Description |
|---|---|
| `start-validator.sh.j2` | Main start script (branches by `rpc_type`) |
| `start-mainnet-rpc-grpc.sh.j2` | gRPC-specific start script |
| `geyser.json.j2` | Yellowstone gRPC config |
| `geyser-richat.json.j2` | Richat gRPC config |
| `richat-setting.yml.j2` | Richat settings |
| `richat.service.j2` | Richat systemd service |
| `firedancer-config.toml.j2` | Firedancer config |
| `firedancer.service.j2` | Firedancer systemd service |
| `solv.service.j2` | Solv systemd service |
| `generate_configs.sh.j2` | Config generation script |

## Geyser Plugin Sources

Both plugins are built from source (no binary downloads):
- **Yellowstone gRPC**: https://github.com/rpcpool/yellowstone-grpc
- **Richat**: https://github.com/lamports-dev/richat

## Usage

```bash
# Deploy a new gRPC Geyser node
ansible-playbook -i inventory mainnet-rpc/init.yml \
  -e '{"rpc_type":"Geyser gRPC","solana_version":"3.1.8","yellowstone_grpc_version":"v6.0.0","snapshot_url":"https://..."}'

# Build/update Richat plugin
ansible-playbook -i inventory mainnet-rpc/geyser_richat_build.yml \
  -e '{"richat_version":"richat-v8.1.0"}'
```

No `versions.yml` required — all variables can be passed via `extra_vars`.

## Interactive Deployment Flow

See `AGENT.md` for the full step-by-step flow and `examples/inventory.yml` for output format.

### Required Variables

| Variable | Prompt | Validation |
|---|---|---|
| `server_ip` | "Target server IP?" | Valid IPv4 |
| `region` | "Server region?" | String |
| `rpc_type` | "Geyser gRPC or Index RPC + gRPC?" | `Geyser gRPC`, `Index RPC + gRPC` |
| `validator_type` | "Underlying client?" | `agave`, `jito`, `jito-bam`, `firedancer-agave` |
| `solana_version` | "Solana version? (default: 3.1.8)" | Semver |
| `identity_account` | "Node identity pubkey?" | Base58 pubkey |
| `snapshot_url` | "Snapshot URL? (auto for ERPC)" | URL (cannot be empty for init) |

### Plugin Selection (choose ONE)

| Plugin | Version Variable | Source | Output |
|---|---|---|---|
| Yellowstone gRPC | `yellowstone_grpc_version` | github.com/rpcpool/yellowstone-grpc | `libyellowstone_grpc_geyser.so` |
| Richat | `richat_version` | github.com/lamports-dev/richat | `librichat_plugin_agave.so` |

Both are built from source (no pre-built binaries). Build time: ~15-30 min.
**Only collect the version variable for the selected plugin.**

### Conditionally Required Variables

| Variable | When Required |
|---|---|
| `jito_version` | jito/jito-bam types |
| `firedancer_version` | firedancer types |
| `shred_receiver_address` | jito/jito-bam (auto by region) |
| `block_engine_url` | jito/jito-bam (auto by region) |

### Optional Variables

| Variable | Default | When Required |
|---|---|---|
| `ssh_user` | `solv` | Always |
| `port_grpc` | `10000` | Always |
| `port_rpc` | `8899` (ERPC: `7211`) | Always |
| `limit_ledger_size` | `100000000` | Always |
| `dynamic_port_range` | `8000-8025` | Always |
| `allowed_ssh_ips` | — | Strongly recommended (UFW) |
| `allowed_ips` | — | Optional (UFW) |

### Optional: Reference RPC

| Variable | Description | Default |
|---|---|---|
| `reference_rpc_url` | Reference RPC endpoint for slot sync comparison (e.g., ERPC) | — |

ERPC API keys are free at https://erpc.global — enables full slot sync monitoring during deployment and updates.

### Pre-flight: Fresh Server Setup

```bash
ansible-playbook -i inventory.yml cmn/add_solv.yml \
  -e '{"ansible_user":"ubuntu"}' --become
```

### Deployment Command

All paths relative to skill's `ansible/` directory:
```bash
cd /path/to/slv-grpc-geyser/ansible/
ansible-playbook -i inventory.yml mainnet-rpc/init.yml \
  -e '{"rpc_type":"Geyser gRPC","solana_version":"<version>","richat_version":"<version>"}'
```
