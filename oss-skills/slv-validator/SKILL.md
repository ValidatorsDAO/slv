# SLV Validator Skill

Ansible playbooks and Jinja2 templates for deploying and managing Solana validators (mainnet and testnet).

## Supported Validator Types

| Type | Description |
|---|---|
| `jito` | Jito MEV client (default for mainnet) |
| `allnodes-jito` | Allnodes-Jito (jito fork with snapshot/voting/POH/SHA-NI patches) |
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
| `slv v init` | *(no playbook — interactive prompts)* | Generate `~/.slv/inventory.<network>.validators.yml` |
| `slv v deploy` | `{net}/init.yml` | Full node initialization and deployment |
| `slv v start` | `{net}/start_node.yml` | Start validator |
| `slv v stop` | `{net}/stop_node.yml` | Stop validator |
| `slv v restart` | `{net}/restart_node.yml` | Graceful restart (`agave-validator exit`, then systemd) |
| `slv v build:solana` | `{net}/install_solana.yml` | Build Solana from source (dispatches by `validator_type`) |
| `slv v install:solana` | `cmn/install_solana.yml` | Install Solana binary (deprecated, prefer build) |
| `slv v setup:firedancer` | `{net}/setup_firedancer.yml` | Setup/update Firedancer |
| `slv v update:firedancer` | `{net}/update_firedancer.yml` | Update Firedancer binary |
| `slv v update:script` | `{net}/update_startup_config.yml` | Re-render start-validator.sh from template |
| `slv v set:identity` | `{net}/set_identity_key.yml` | Set validator identity key |
| `slv v set:unstaked` | `{net}/set_unstaked_key.yml` | Switch to unstaked identity |
| `slv v get:snapshot` | `{net}/wget_snapshot.yml` | Download snapshot via aria2c |
| `slv v cleanup` | `cmn/rm_ledger.yml` | Remove ledger/snapshot files |
| `slv disable pwd-login` | `cmn/disable_pwd_login.yml` | Disable SSH password authentication |
| `slv v switch` | `{net}/nodowntime_migrate.yml` | Zero-downtime identity migration (auto-swaps inventory) |
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
| `disable_pwd_login.yml` | Disable SSH password authentication and restart sshd |
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
| `validator_type` | Validator type (`jito`, `allnodes-jito`, `agave`, `firedancer-agave`, `firedancer-jito`) | `jito` |
| `solana_version` | Solana/Agave version to build (used when `validator_type == 'agave'`) | — |
| `jito_version` | Jito version to build (used when `validator_type == 'jito'`) | — |
| `allnodes_jito_version` | Allnodes-Jito version (used when `validator_type == 'allnodes-jito'`); template appends `-allnodes` to form the git tag | — |
| `firedancer_version` | Firedancer version | — |
| `snapshot_url` | Snapshot download URL | — |
| `identity_account` | Validator identity pubkey | — |
| `vote_account` | Vote account pubkey | — |
| `block_engine_url` | Jito block engine URL | `https://frankfurt.mainnet.block-engine.jito.wtf` |
| `shred_receiver_address` | Jito shred receiver. **Accepts a single string or a YAML list** — a list emits one `--shred-receiver-address` flag per entry | `64.130.50.14:1002` |
| `bam_url` | *Optional.* When set, the validator starts with `--bam-url <value>` and joins the BAM pipeline. Applies to both `jito` and `allnodes-jito`. Replaces the removed `jito-bam` validator_type | — |
| `commission_bps` | Commission in basis points | `0` |
| `dynamic_port_range` | Validator port range | `8000-8025` |
| `limit_ledger_size` | Ledger size limit | `200000000` |
| `expected_shred_version` | Expected shred version (testnet, epoch-dependent) | — |
| `expected_bank_hash` | Expected bank hash (testnet, optional) | — |
| `wait_for_supermajority` | Wait for supermajority slot (testnet, optional) | — |
| `source_host` | Source host for nodowntime migration | — |
| `target_host` | Target host for nodowntime migration | — |

## Three Core Workflows

Almost every validator task is one of these three. Use the `slv v ...` shortcuts
where possible — they wrap the right ansible command and inventory lookup.

### A. Initial setup
```bash
slv v init                           # interactive — writes inventory
slv v deploy -n <network> -p <host>  # ansible: {net}-validator/init.yml
```
The `init.yml` playbook handles user creation, package install, disk mount,
performance tuning, source build, snapshot download, systemd setup, and start.

### B. Version / config update
```bash
# 1. Edit ~/.slv/versions.yml (e.g. version_jito: 3.1.13 -> 3.1.14)
# 2. Build new binary from source
slv v build:solana -n <network> -p <host>
# 3. Re-render start-validator.sh (picks up inventory changes such as bam_url
#    being added or shred_receiver_address turning into a list)
slv v update:script -n <network> -p <host>
# 4. Restart
slv v restart -n <network> -p <host>
```

### C. Zero-downtime identity migration
```bash
slv v switch -n <network> -f <from_host> -t <to_host>
```
Runs `{net}-validator/nodowntime_migrate.yml`:
1. `set-identity` to unstaked on `from_host`, copy tower file to local.
2. Upload tower to `to_host`, `set-identity` to the staked key, register as
   `authorized-voter`.
3. Swap the host entries in the inventory file (so `slv v ...` keeps targeting
   the right physical box afterward).

`from_host` / `to_host` are inventory keys (e.g. `validator-primary`,
`validator-spare`), not IPs. Both must have `validator_type` set
(`agave`, `jito`, or `allnodes-jito`), the local key file at
`~/.slv/keys/<identity_account>.json`, and `unstaked-identity.json` on each
remote box.

## Direct ansible invocation

If you need to bypass the `slv v` wrapper, the playbooks are designed to run
directly via `ansible-playbook` with `extra_vars`:

```bash
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"allnodes-jito","allnodes_jito_version":"3.1.14","snapshot_url":"https://..."}'
```

No `versions.yml` required when you pass everything via `extra_vars`.

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
| `validator_type` | "Which validator type?" | `jito`, `allnodes-jito`, `agave`, `firedancer-agave`, `firedancer-jito` |
| `solana_version` | "Solana version? (default: 3.1.8)" | Semver |
| `jito_version` | "Jito version?" (if jito/allnodes-jito) | Semver |
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

## Performance Tuning

The `init.yml` playbook automatically applies performance tuning during first deployment:

| Tuning | Description |
|---|---|
| SMT Disable | Disables Hyper-Threading via GRUB `nosmt` for better single-thread performance |
| IRQ Tuning | NIC IRQ 1:1 pinning + RPS/XPS optimization for balanced network interrupt distribution |
| CPU Boost | HWE kernel + AMD performance governor + boost + C-state optimization |

### Inventory Fields (auto-managed)

| Field | Type | Default | Description |
|---|---|---|---|
| `smt_disable` | bool | `false` | Set to `true` after SMT disable is applied |
| `irq_tuning` | bool | `false` | Set to `true` after IRQ tuning is applied |
| `cpu_boost` | bool | `false` | Set to `true` after CPU boost is applied |
| `need_reboot` | bool | `false` | Set to `true` when reboot is required |

### Reboot Flow

If performance tuning requires a reboot (kernel update, GRUB changes):
1. Deployment pauses with a message: "Reboot required"
2. User reboots the server
3. User re-runs `slv v deploy`
4. Tuning steps are skipped (already applied), deployment continues

### Standalone Usage

Performance tuning can also be run independently:
```bash
ansible-playbook -i inventory.yml cmn/performance_tune.yml
```

### CLI Command Mapping

| CLI Command | Playbook |
|---|---|
| `slv v deploy` | `{net}/init.yml` (includes performance_tune.yml) |
| *(standalone)* | `cmn/performance_tune.yml` |
