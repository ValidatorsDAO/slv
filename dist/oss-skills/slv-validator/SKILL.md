# SLV Validator Skill

Ansible playbooks and Jinja2 templates for deploying and managing Solana validators (mainnet and testnet).

## Supported Validator Types

| Type | Description |
|---|---|
| `jito` | Jito MEV client (default for mainnet) |
| `jito-bam` | Jito with Block Awareness Module |
| `agave` | Standard Agave validator |
| `firedancer-agave` | Firedancer with Agave consensus |
| `firedancer-jito` | Firedancer with Jito consensus |

## Directory Structure

```
ansible/
  mainnet-validator/   — Mainnet validator playbooks
  testnet-validator/   — Testnet validator playbooks
  cmn/                 — Shared common playbooks
jinja/
  mainnet-validator/   — Mainnet Jinja2 templates
  testnet-validator/   — Testnet Jinja2 templates
  cmn/                 — Shared templates
```

## CLI Command ↔ Playbook Mapping

The `slv v` CLI commands map directly to these playbooks. `{net}` = `mainnet-validator` or `testnet-validator`.

| CLI Command | Playbook | Description |
|---|---|---|
| `slv v deploy` | `{net}/init.yml` | Full node initialization and deployment |
| `slv v start` | `{net}/start_node.yml` | Start validator |
| `slv v stop` | `{net}/stop_node.yml` | Stop validator |
| `slv v restart` | `{net}/restart_node.yml` | Restart validator |
| `slv v build:solana` | `{net}/install_solana.yml` | Build Solana from source |
| `slv v install:solana` | `cmn/install_solana.yml` | Install Solana binary (deprecated, prefer build) |
| `slv v setup:firedancer` | `{net}/setup_firedancer.yml` | Setup/update Firedancer |
| `slv v update:firedancer` | `{net}/update_firedancer.yml` | Update Firedancer binary |
| `slv v update:script` | `{net}/update_startup_config.yml` | Update start-validator.sh from template |
| `slv v set:identity` | `{net}/set_identity_key.yml` | Set validator identity key |
| `slv v set:unstaked` | `{net}/set_unstaked_key.yml` | Switch to unstaked identity |
| `slv v get:snapshot` | `{net}/wget_snapshot.yml` | Download snapshot via aria2c |
| `slv v cleanup` | `cmn/rm_ledger.yml` | Remove ledger/snapshot files |
| `slv v switch` | `{net}/nodowntime_migrate.yml` | Zero-downtime identity migration |
| `slv v list` | *(no playbook)* | List validators (CLI only) |
| `slv v gen:vote-account` | *(no playbook)* | Create vote account (solana CLI) |

## All Playbooks

### Mainnet Validator (`mainnet-validator/`)

| Playbook | Description |
|---|---|
| `init.yml` | Full node initialization (Agave/Jito) |
| `init-jito.yml` | Jito-specific initialization |
| `init-firedancer.yml` | Firedancer initialization |
| `restart_node.yml` | Restart validator |
| `start_node.yml` | Start validator |
| `stop_node.yml` | Stop validator |
| `install_solana.yml` | Build Solana from source |
| `install_agave.yml` | Build Agave from source |
| `install_jito.yml` | Build Jito from source |
| `install_rust.yml` | Install Rust toolchain |
| `setup_firedancer.yml` | Setup Firedancer binary and config |
| `update_firedancer.yml` | Update Firedancer binary |
| `update_startup_config.yml` | Update start-validator.sh from Jinja template |
| `deploy-start-validator-sh.yml` | Deploy start script to remote |
| `create-start-validator-sh.yml` | Generate start script from template |
| `nodowntime_migrate.yml` | Zero-downtime identity migration between nodes |
| `set_identity_key.yml` | Set validator identity key |
| `set_identity_to_active.yml` | Activate identity key |
| `set_unstaked_key.yml` | Switch to unstaked identity |
| `switch_on_identity.yml` | Enable identity (tower copy + key deploy) |
| `switch_off_identity.yml` | Disable identity (tower backup) |
| `switch_on_firedancer_identity.yml` | Enable Firedancer identity |
| `switch_off_firedancer_identity.yml` | Disable Firedancer identity |
| `copy_keys.yml` | Copy validator keys to node |
| `copy_restart_sh.yml` | Copy restarter script |
| `create_overrides.yml` | Generate overrides.yml from template |
| `setup_solv_service.yml` | Setup systemd service |
| `start-solv-service.yml` | Start systemd service |
| `setup_ufw.yml` | Configure UFW firewall |
| `setup_fb_ufw.yml` | Configure Firedancer-specific UFW rules |
| `setup_logrotate.yml` | Setup log rotation |
| `configure_hugetlbfs.yml` | Configure hugepages for Firedancer |
| `fail2ban_solana_rate_limit.yml` | Setup fail2ban rate limiting |
| `run_snapshot_finder.yml` | Find and download best snapshot |

### Testnet Validator (`testnet-validator/`)

| Playbook | Description |
|---|---|
| `init.yml` | Full initialization (Jito) |
| `init-agave.yml` | Agave-specific initialization |
| `init-firedancer.yml` | Firedancer initialization |
| `restart_node.yml` | Restart validator |
| `start_node.yml` | Start validator |
| `stop_node.yml` | Stop validator |
| `install_solana.yml` | Build Solana from source |
| `install_agave.yml` | Build Agave from source |
| `install_jito.yml` | Build Jito from source |
| `install_firedancer.yml` | Build Firedancer from source |
| `setup_firedancer.yml` | Setup Firedancer |
| `setup_firedancer_agave.yml` | Setup Firedancer with Agave |
| `setup_firedancer_jito.yml` | Setup Firedancer with Jito |
| `update_firedancer.yml` | Update Firedancer binary |
| `update_startup_config.yml` | Update start script from template |
| `deploy-start-validator-sh.yml` | Deploy start script |
| `create-start-validator-sh-agave.yml` | Generate Agave start script |
| `create-start-validator-sh-jito.yml` | Generate Jito start script |
| `nodowntime_migrate.yml` | Zero-downtime identity migration |
| `set_identity_key.yml` | Set identity key |
| `set_identity_to_active.yml` | Activate identity |
| `set_unstaked_key.yml` | Switch to unstaked identity |
| `switch_on_identity.yml` / `switch_off_identity.yml` | Toggle identity |
| `switch_on_firedancer_identity.yml` / `switch_off_firedancer_identity.yml` | Toggle Firedancer identity |
| `change_identity_and_restart.yml` | Change identity and restart in one step |
| `copy_keys.yml` | Copy keys to node |
| `rm_ledger.yml` | Remove ledger data |
| `restart_agave_with_rm_ledger.yml` | Restart with ledger removal |
| `restart_firedancer.yml` | Restart Firedancer |
| `restart_firedancer_with_rm_ledger.yml` | Restart Firedancer with ledger removal |
| `restart_solv.yml` | Restart solv service |
| `setup_agave.yml` | Setup Agave |
| `setup_agave_ufw.yml` | Agave UFW rules |
| `setup_solv_service.yml` | Setup systemd service |
| `setup_solv_service_init.yml` | Initialize systemd service |
| `setup_snapshot_finder.yml` | Setup snapshot finder |
| `add_solv.yml` | Add solv user |

### Shared Common (`cmn/`)

| Playbook | Description |
|---|---|
| `build_solana.yml` | Build Solana from source (dispatches to build_agave/build_jito) |
| `build_agave.yml` | Build Agave from GitHub source |
| `build_jito.yml` | Build Jito from GitHub source |
| `install_solana.yml` | Install Solana binary (deprecated) |
| `install_package.yml` | Install system packages |
| `install_rust.yml` | Install Rust toolchain |
| `mount_disks.yml` | Mount and format disks |
| `optimize_system.yml` | Optimize system settings (sysctl, limits) |
| `disable_swap.yml` | Disable swap |
| `setup_logrotate.yml` | Configure log rotation |
| `setup_node_exporter.yml` | Setup Prometheus node exporter |
| `setup_norestart.yml` | Disable auto-restart |
| `setup_ufw.yml` | Configure UFW firewall |
| `setup_unstaked_identity.yml` | Setup unstaked identity keypair |
| `restart_solv.yml` | Restart solv service |
| `copy_restart_sh.yml` | Copy restarter script |
| `update_ubuntu.yml` | Update Ubuntu packages |
| `wget_snapshot.yml` | Download snapshot |
| `add_solv.yml` | Add solv user |
| `rm_ledger.yml` | Remove ledger data |
| `fix_permissions.yml` | Fix file permissions |

## Key Variables (extra_vars)

| Variable | Description | Default |
|---|---|---|
| `validator_type` | Validator type (`jito`, `jito-bam`, `agave`, `firedancer-agave`, `firedancer-jito`) | `jito` |
| `solana_version` | Solana/Agave version to build | — |
| `jito_version` | Jito version to build | — |
| `firedancer_version` | Firedancer version | — |
| `snapshot_url` | Snapshot download URL | — |
| `identity_account` | Validator identity pubkey | — |
| `vote_account` | Vote account pubkey | — |
| `block_engine_url` | Jito block engine URL | `https://frankfurt.mainnet.block-engine.jito.wtf` |
| `shred_receiver_address` | Jito shred receiver address | `64.130.50.14:1002` |
| `commission_bps` | Commission in basis points | `0` |
| `dynamic_port_range` | Validator port range | `8000-8025` |
| `limit_ledger_size` | Ledger size limit | `200000000` |
| `expected_shred_version` | Expected shred version (testnet, epoch-dependent) | — |
| `expected_bank_hash` | Expected bank hash (testnet, optional) | — |
| `wait_for_supermajority` | Wait for supermajority slot (testnet, optional) | — |
| `source_host` | Source host for nodowntime migration | — |
| `target_host` | Target host for nodowntime migration | — |

## Usage

All playbooks are designed to be run via `ansible-playbook` with `extra_vars`:

```bash
ansible-playbook -i inventory mainnet-validator/init.yml \
  -e '{"validator_type":"jito","solana_version":"3.1.8","snapshot_url":"https://..."}'
```

No `versions.yml` required — all variables can be passed via `extra_vars`.

## Interactive Deployment Flow

When deploying a new validator, the agent should guide the user through variable collection
in this order. See `AGENT.md` for the full step-by-step flow and `examples/inventory.yml`
for the generated output format.

### Required Variables (must collect)

| Variable | Prompt | Validation |
|---|---|---|
| `server_ip` | "Target server IP?" | Valid IPv4 |
| `network` | "Mainnet or testnet?" | `mainnet` or `testnet` |
| `region` | "Server region? (amsterdam, frankfurt, tokyo, ny, ...)" | String |
| `validator_type` | "Which validator type?" | `jito`, `jito-bam`, `agave`, `firedancer-agave`, `firedancer-jito` |
| `solana_version` | "Solana version? (default: 3.1.8)" | Semver |
| `jito_version` | "Jito version?" (if jito/jito-bam) | Semver |
| `firedancer_version` | "Firedancer version?" (if firedancer) | String |
| `identity_account` | "Validator identity pubkey? (or generate)" | Base58 pubkey or `generate` |
| `vote_account` | "Vote account pubkey? (or generate)" | Base58 pubkey or `generate` |
| `snapshot_url` | "Snapshot URL? (auto-detected for ERPC nodes)" | URL (cannot be empty for init) |

### Optional Variables (show defaults, confirm)

| Variable | Default | When Required |
|---|---|---|
| `ssh_user` | `solv` (`ubuntu` for fresh servers) | Always |
| `commission_bps` | `0` | Always |
| `dynamic_port_range` | `8000-8025` | Always |
| `limit_ledger_size` | `200000000` | Always |
| `allowed_ssh_ips` | — | Strongly recommended (UFW) |
| `allowed_ips` | — | Optional (UFW) |
| `block_engine_url` | Auto by region | Jito types only |
| `shred_receiver_address` | Auto by region | Jito types only |
| `expected_shred_version` | Epoch-dependent | Testnet only |
| `expected_bank_hash` | Epoch-dependent | Testnet (optional) |
| `wait_for_supermajority` | Epoch-dependent | Testnet (optional) |

### Optional: Reference RPC

| Variable | Description | Default |
|---|---|---|
| `reference_rpc_url` | Reference RPC endpoint for slot sync comparison (e.g., ERPC) | — |

ERPC API keys are free at https://erpc.global — enables full slot sync monitoring during deployment and updates.

### Pre-flight: Fresh Server Setup

If the target is a new server without a `solv` user:
```bash
ansible-playbook -i inventory.yml cmn/add_solv.yml \
  -e '{"ansible_user":"ubuntu"}' --become
```

### Deployment Command

All paths relative to skill's `ansible/` directory:
```bash
cd /path/to/slv-validator/ansible/
ansible-playbook -i inventory.yml {network}-validator/init.yml \
  -e '{"validator_type":"<type>","solana_version":"<version>","snapshot_url":"<url>"}'
```

### Dry-Run First

Always offer `--check` mode before actual deployment:
```bash
ansible-playbook -i inventory.yml {network}-validator/init.yml \
  -e '{"validator_type":"jito","solana_version":"3.1.8"}' --check
```
