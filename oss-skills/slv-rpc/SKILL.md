# SLV RPC Skill

Ansible playbooks and Jinja2 templates for deploying and managing Solana RPC nodes (mainnet, testnet, devnet).

## Supported RPC Types

| Type | Description |
|---|---|
| `RPC` | Standard RPC node |
| `Index RPC` | Full-index RPC node (with Old Faithful/yellowstone-faithful) |
| `Geyser gRPC` | RPC with Geyser gRPC streaming |
| `Index RPC + gRPC` | Full-index + gRPC streaming |

## Directory Structure

```
ansible/
  mainnet-rpc/   — Mainnet RPC playbooks
  testnet-rpc/   — Testnet RPC playbooks
  devnet-rpc/    — Devnet RPC playbooks
  cmn/           — Shared common playbooks
jinja/
  mainnet-rpc/   — Mainnet Jinja2 templates
  testnet-rpc/   — Testnet Jinja2 templates
  devnet-rpc/    — Devnet Jinja2 templates
  cmn/           — Shared templates
```

## CLI Command ↔ Playbook Mapping

The `slv r` CLI commands map directly to these playbooks. `{net}` = `mainnet-rpc`, `testnet-rpc`, or `devnet-rpc`.

| CLI Command | Playbook | Description |
|---|---|---|
| `slv r deploy` | `{net}/init.yml` | Full RPC node initialization and deployment |
| `slv r start` | `{net}/start_node.yml` | Start RPC node |
| `slv r stop` | `{net}/stop_node.yml` | Stop RPC node |
| `slv r restart` | `{net}/restart_node.yml` | Restart RPC node |
| `slv r build:solana` | `{net}/install_solana.yml` | Build Solana from source |
| `slv r install:solana` | `cmn/install_solana.yml` | Install Solana binary (deprecated, prefer build) |
| `slv r setup:firedancer` | `{net}/setup_firedancer.yml` | Setup Firedancer |
| `slv r update:firedancer` | `cmn/update_firedancer.yml` | Update Firedancer binary |
| `slv r update:script` | `{net}/update_startup_config.yml` | Update start-validator.sh from template |
| `slv r update:geyser` | `{net}/update_geyser.yml` | Update Geyser plugin |
| `slv r get:snapshot` | `{net}/wget_snapshot.yml` | Download snapshot via aria2c |
| `slv r cleanup` | `cmn/rm_ledger.yml` | Remove ledger/snapshot files |
| `slv r list` | *(no playbook)* | List RPC nodes (CLI only) |
| `slv r update:allowed-ips` | *(no playbook)* | Update allowed IPs (CLI only) |
| `slv r init` | *(no playbook)* | Interactive wizard (CLI only) |

## All Playbooks

### Mainnet RPC (`mainnet-rpc/`)

| Playbook | Description |
|---|---|
| `init.yml` | Full RPC node initialization |
| `init_richat_geyser.yml` | Initialize Richat Geyser configuration |
| `restart_node.yml` | Restart RPC node |
| `start_node.yml` | Start RPC node |
| `stop_node.yml` | Stop RPC node |
| `install_solana.yml` | Build Solana from source |
| `install_agave.yml` | Build Agave from source |
| `install_jito.yml` | Build Jito from source |
| `install_rust.yml` | Install Rust toolchain |
| `install_package.yml` | Install system packages |
| `install_richat.yml` | Install Richat gRPC plugin |
| `install_of1.yml` | Install Old Faithful (yellowstone-faithful) |
| `install_of1_service.yml` | Setup Old Faithful systemd service |
| `geyser_build.yml` | Build Yellowstone gRPC from source |
| `geyser_richat_build.yml` | Build Richat gRPC plugin from source |
| `update_geyser.yml` | Update Geyser plugin |
| `update_startup_config.yml` | Update start-validator.sh from template |
| `update_ubuntu.yml` | Update Ubuntu packages |
| `setup_firedancer.yml` | Setup Firedancer for RPC |
| `setup-solv-service.yml` | Setup systemd service |
| `start-solv-service.yml` | Start systemd service |
| `setup_ufw.yml` | Configure UFW firewall |
| `setup_logrotate.yml` | Setup log rotation |
| `setup_norestart.yml` | Disable auto-restart |
| `configure_hugetlbfs.yml` | Configure hugepages for Firedancer |
| `fail2ban_solana_rate_limit.yml` | Setup fail2ban rate limiting |
| `fail2ban_sshd.yml` | Setup fail2ban for SSH |
| `allow_ufw.yml` | Add UFW allow rules |
| `add_solv.yml` | Add solv user |
| `copy_keys.yml` | Copy node keys |
| `create-start-validator-sh.yml` | Generate start script from template |
| `create-symlink.yml` | Create version symlinks |
| `mount_disks.yml` | Mount and format disks |
| `optimize_system.yml` | Optimize system settings |
| `run_restarter.yml` | Run restarter script |
| `run_snapshot_finder.yml` | Find and download best snapshot |

### Testnet RPC (`testnet-rpc/`)

| Playbook | Description |
|---|---|
| `init.yml` | Full testnet RPC initialization |
| `restart_node.yml` | Restart node |
| `start_node.yml` / `stop_node.yml` | Start/stop node |
| `install_solana.yml` | Build Solana from source |
| `install_agave.yml` / `install_jito.yml` | Build client from source |
| `install_richat.yml` | Install Richat plugin |
| `geyser_build.yml` | Build Yellowstone gRPC |
| `geyser_richat_build.yml` | Build Richat plugin from source |
| `update_geyser.yml` | Update Geyser plugin |
| `update_firedancer.yml` | Update Firedancer |
| `update_startup_config.yml` | Update start script |
| `setup_firedancer.yml` | Setup Firedancer |
| `setup_solv_service.yml` | Setup systemd service |
| `create-start-validator-sh.yml` | Generate start script |
| `wget_snapshot.yml` | Download snapshot |

### Devnet RPC (`devnet-rpc/`)

| Playbook | Description |
|---|---|
| `init.yml` | Full devnet RPC initialization |
| `restart_node.yml` | Restart node |
| `start_node.yml` / `stop_node.yml` | Start/stop node |
| `install_solana.yml` | Build Solana from source |
| `install_agave.yml` / `install_jito.yml` | Build client from source |
| `install_richat.yml` | Install Richat plugin |
| `geyser_build.yml` | Build Yellowstone gRPC |
| `geyser_richat_build.yml` | Build Richat plugin from source |
| `update_geyser.yml` | Update Geyser plugin |
| `update_startup_config.yml` | Update start script |
| `setup_firedancer.yml` | Setup Firedancer |
| `setup_solv_service.yml` | Setup systemd service |
| `create-start-validator-sh.yml` | Generate start script |

### Shared Common (`cmn/`)

| Playbook | Description |
|---|---|
| `build_solana.yml` | Build Solana from source (dispatches to build_agave/build_jito) |
| `build_agave.yml` | Build Agave from GitHub source |
| `build_jito.yml` | Build Jito from GitHub source |
| `install_solana.yml` | Install Solana binary (deprecated) |
| `install_package.yml` | Install system packages |
| `install_rust.yml` | Install Rust toolchain |
| `mount_disks.yml` / `mount-disks.yml` | Mount and format disks |
| `optimize_system.yml` | Optimize system settings |
| `disable_swap.yml` | Disable swap |
| `setup_logrotate.yml` | Configure log rotation |
| `setup_node_exporter.yml` | Setup Prometheus node exporter |
| `setup_norestart.yml` | Disable auto-restart |
| `setup_unstaked_identity.yml` | Setup unstaked identity keypair |
| `restart_solv.yml` | Restart solv service |
| `start_solv.yml` / `stop_solv.yml` | Start/stop solv service |
| `start_firedancer.yml` / `stop_firedancer.yml` | Start/stop Firedancer |
| `copy_restart_sh.yml` | Copy restarter script |
| `copy_rpc_keys.yml` | Copy RPC keys |
| `update_ubuntu.yml` | Update Ubuntu packages |
| `wget_snapshot.yml` | Download snapshot |
| `add_solv.yml` | Add solv user |
| `fix_permissions.yml` | Fix file permissions |

## Key Variables (extra_vars)

| Variable | Description | Default |
|---|---|---|
| `rpc_type` | RPC node type (`RPC`, `Index RPC`, `Geyser gRPC`, `Index RPC + gRPC`) | `RPC` |
| `validator_type` | Client type (`agave`, `jito`, `firedancer-agave`, `firedancer-jito`) | — |
| `solana_version` | Solana/Agave version | — |
| `jito_version` | Jito version | — |
| `firedancer_version` | Firedancer version | — |
| `yellowstone_grpc_version` | Yellowstone gRPC version | — |
| `richat_version` | Richat plugin version (e.g. `richat-v8.1.0`) | — |
| `snapshot_url` | Snapshot download URL | — |
| `tpu_peer_address` | TPU peer address (for Index RPC transaction forwarding) | — |
| `limit_ledger_size` | Ledger size limit | `200000000` (Index), `100000000` (others) |
| `dynamic_port_range` | Port range | `8000-8025` |
| `port_rpc` | RPC port | `8899` |
| `port_grpc` | gRPC port | `10000` |

## Geyser Plugin Sources

Both plugins are built from source (no binary downloads):
- **Yellowstone gRPC**: https://github.com/rpcpool/yellowstone-grpc
- **Richat**: https://github.com/lamports-dev/richat

## Usage

```bash
ansible-playbook -i inventory mainnet-rpc/init.yml \
  -e '{"rpc_type":"Index RPC","solana_version":"3.1.8","snapshot_url":"https://..."}'
```

No `versions.yml` required — all variables can be passed via `extra_vars`.

## Interactive Deployment Flow

See `AGENT.md` for the full step-by-step flow and `examples/inventory.yml` for output format.

### Required Variables

| Variable | Prompt | Validation |
|---|---|---|
| `server_ip` | "Target server IP?" | Valid IPv4 |
| `network` | "mainnet, testnet, or devnet?" | `mainnet`, `testnet`, `devnet` |
| `region` | "Server region?" | String |
| `rpc_type` | "RPC type?" | `RPC`, `Index RPC`, `Geyser gRPC`, `Index RPC + gRPC` |
| `validator_type` | "Underlying client?" | `agave`, `jito`, `jito-bam`, `firedancer-agave` |
| `solana_version` | "Solana version? (default: 3.1.8)" | Semver |
| `identity_account` | "Node identity pubkey?" | Base58 pubkey |
| `snapshot_url` | "Snapshot URL? (auto for ERPC)" | URL (cannot be empty for init) |

### Conditionally Required Variables

| Variable | Default | When Required |
|---|---|---|
| `jito_version` | Matches solana_version | jito/jito-bam types |
| `firedancer_version` | — | firedancer types |
| `yellowstone_grpc_version` | — | Yellowstone gRPC plugin |
| `richat_version` | — | Richat plugin |
| `of1_version` | — | Index RPC (Old Faithful) |
| `epoch` | — | Index RPC (faithful service) |
| `faithful_proxy_target_url` | — | Index RPC |

### Optional Variables

| Variable | Default | When Required |
|---|---|---|
| `ssh_user` | `solv` | Always |
| `port_rpc` | `8899` (ERPC: `7211`) | Always |
| `limit_ledger_size` | `100000000` | Always |
| `dynamic_port_range` | `8000-8025` | Always |
| `port_grpc` | `10000` | gRPC types only |
| `tpu_peer_address` | — | Index RPC (tx forwarding) |
| `allowed_ssh_ips` | — | Strongly recommended (UFW) |
| `allowed_ips` | — | Optional (UFW) |
| `expected_shred_version` | Epoch-dependent | Testnet only |

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
cd /path/to/slv-rpc/ansible/
ansible-playbook -i inventory.yml {network}-rpc/init.yml \
  -e '{"rpc_type":"<type>","solana_version":"<version>"}'
```
