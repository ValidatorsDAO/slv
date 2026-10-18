# SLV Validator Skill

Ansible playbooks and Jinja2 templates for deploying and managing Solana validators (mainnet and testnet).

## Safe startup and activation

First confirm the network, exact inventory host name/address and whether the target
is local or remote. Use explicit `-n <network>` and `-p <host>` for host changes;
`-p` selects an inventory entry, not necessarily a public key or an IP.

Keyless deployment is the default: `slv v deploy` copies no staked private key
to the node, and there is no `--keyless` option. The node starts and restarts with
`/home/solv/identity.json` linked to `/home/solv/unstaked-identity.json`. A guard
refuses to start it if that path resolves to another identity. This is not voting
without a key. The operator still prepares public identity/vote account settings
and the controller key needed for later activation.

The staked key stays on the controller at `~/.slv/keys/<identity_account>.json`;
Agave-family `set:identity` and `switch` pass it on stdin to the node process.
Deploy can finish when that local key is absent, while its post-deploy BLS
registration is skipped for that host with a warning. Server-side
`/home/solv/testnet-validator-keypair.json` and
`/home/solv/mainnet-validator-keypair.json` are legacy files that may remain from
older deployments; they are not new-deploy prerequisites, and deploy does not
delete them. Do not ask the user to recreate them on the validator.

The AI must never read, create, copy, print or edit private keys or manually change
the identity symlink. The operator handles keys in their own terminal through the
supported CLI. Public keys and non-secret status are sufficient for planning.

Before promotion, verify synchronization, health, the target's active public
identity, the consensus-specific history file, and that no other node is voting
with the identity. Use the target's configured RPC port, not an assumed
localhost:8899 on the management machine. Start with
`slv v check:alpenglow -n <network> -p <host>` for cluster/inventory readiness;
that read-only report does not contact the validator or prove its local sync.
`slv v set:identity -n <network> -p <host>` promotes exactly one inventory host.

Identity changes stop before acting when consensus is unreadable, activation is
imminent, or the migration window is open. Mainnet promotion requires terminal
confirmation. `--first-activation` means never voted on TowerBFT, or no vote after
the Alpenglow genesis certificate on Alpenglow; the latter includes a vote
account that voted only under TowerBFT. `--peer-down-confirmed` can account for an
unreadable peer independently confirmed not to run this identity, but it does not
waive the history requirement or override a known-active peer.

`--primary-down` is a separate recovery path for an old primary that is stopped
and cannot vote. It needs a terminal on either network, the old primary's
inventory name typed as confirmation, and passing cluster/target checks. It
cannot be combined with `--first-activation`. None of these flags is a default.
Under Alpenglow, the missing vote-history protection is relaxed only through
that guarded recovery path; do not call lower-level bypass flags directly.
See workflow C for the consensus, history, recent-vote and stale-gossip details.

For an existing running identity, coordinate the handoff with
`slv v switch -n <network> -f <source-host> -t <target-host>` in the operator's
terminal after checking both hosts and target synchronization. Do not replace the
flow with manual key copying, identity symlinks or direct activation playbooks.

`slv v init`, deploy and switch are interactive. Init can also create the solv
user, prepare keys and tune/reboot the remote host; it is not a read-only wizard.
Use the operator's terminal for these steps. Deploy has no `--check`, `-y`,
`--force` or `--localhost` flag; `--localhost` belongs to init. Do not bypass CLI
confirmations or guards with direct `init.yml`, piped answers or all-host overrides.

## Supported Validator Types

| Type | Description |
|---|---|
| `jito` | Jito MEV client (default for mainnet) |
| `allnodes-jito` | Allnodes-Jito (jito fork with snapshot/voting/POH/SHA-NI patches) |
| `agave` | Standard Agave validator |
| `firedancer-agave` | Firedancer with Agave consensus. Testnet only: refused on mainnet during the Alpenglow migration |
| `firedancer-jito` | Firedancer with Jito consensus. Testnet only: refused on mainnet during the Alpenglow migration |

Alpenglow starts on mainnet at epoch 1064, and Firedancer and Frankendancer are not
supported during the migration. A mainnet voting validator is `agave`, `jito` or
`allnodes-jito`: mainnet `init.yml` and `init-firedancer.yml` refuse the Firedancer types
before anything is changed, and `slv v setup:firedancer` and `slv v update:firedancer`
refuse on mainnet. Testnet Firedancer setup can start unstaked, but testnet
`set:identity` and `switch` refuse Firedancer identity moves regardless of
consensus: those paths would need an on-node staked key. Do not work around that
refusal by copying one.

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
| `slv v init` | *(interactive setup, including user/key preparation and remote optimization)* | Prepare inventory and target; operator terminal required |
| `slv v deploy` | `{net}/init.yml` | Deploy and start unstaked; no staked key is copied to the node |
| `slv v start` | `{net}/start_node.yml` | Start validator |
| `slv v stop` | `{net}/stop_node.yml` | Stop validator |
| `slv v restart` | `{net}/restart_node.yml` | Graceful restart (`agave-validator exit`, then systemd) |
| `slv v build:solana` | `{net}/install_solana.yml` then `{net}/update_startup_config.yml` | Build Solana from source and render matching start script |
| `slv v install:solana` | `cmn/install_solana.yml` then `{net}/update_startup_config.yml` | Install Solana binary and render matching start script |
| `slv v setup:firedancer` | `{net}/setup_firedancer.yml` | Setup/update Firedancer. Testnet only: refused on mainnet (Alpenglow) |
| `slv v update:firedancer` | `{net}/update_firedancer.yml` | Update Firedancer binary. Testnet only: refused on mainnet (Alpenglow) |
| `slv v update:script` | `{net}/update_startup_config.yml` | Re-render start-validator.sh from template |
| `slv v set:identity -n <network> -p <host>` | `{net}/set_identity_key.yml` | Guarded activation on one host; exceptional flags are described in workflow C |
| `slv v set:unstaked` | `{net}/set_unstaked_key.yml` | Switch to unstaked identity |
| `slv v register:bls` | *(no playbook — solana CLI)* | Register the BLS pubkey on each vote account (SIMD-0387). After deploy, attempted only for hosts with a local identity key; otherwise skipped with a warning |
| `slv v check:alpenglow` | *(no playbook — reads the inventory, `versions.yml` and the public RPC; contacts no host)* | Read-only Alpenglow readiness check per validator (`-n mainnet` or `-n testnet`, `-p host[,host]`): OK / WARN / FAIL lines with the fix; exit code 1 on a FAIL (see "Alpenglow readiness") |
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
| `init-firedancer.yml` | Firedancer initialization. Refuses every host on mainnet (Alpenglow) |
| `restart_node.yml` | Restart validator |
| `start_node.yml` | Start validator |
| `stop_node.yml` | Stop validator |
| `install_solana.yml` | Build Solana from source |
| `install_agave.yml` | Build Agave from source |
| `install_jito.yml` | Build Jito from source |
| `install_rust.yml` | Install Rust toolchain |
| `setup_firedancer.yml` | Setup Firedancer binary and config. Refuses every host on mainnet, before anything is changed (Alpenglow); `slv v setup:firedancer -n mainnet` stops before the playbook runs |
| `update_firedancer.yml` | Update Firedancer binary. Refuses every host on mainnet, before anything is changed (Alpenglow); `slv v update:firedancer -n mainnet` stops before the playbook runs |
| `update_startup_config.yml` | Update start-validator.sh from Jinja template |
| `deploy-start-validator-sh.yml` | Deploy start script to remote |
| `create-start-validator-sh.yml` | Generate start script from template |
| `nodowntime_migrate.yml` | Zero-downtime identity migration between nodes |
| `set_identity_key.yml` | Set validator identity key |
| `set_identity_to_active.yml` | Retired, refuses for every host: it set the identity without the checks that `slv v set:identity` makes first (see Keys). The message starts with `SLV_KEYLESS_REFUSED`, nothing is changed, and it names `slv v set:identity -n mainnet -p <host>` and `slv v switch -n mainnet` |
| `set_unstaked_key.yml` | Switch to unstaked identity |
| `switch_on_identity.yml` | Enable identity (tower copy, or on Alpenglow the vote history file that the same `slv v switch` run took, + key deploy; on its own it refuses on Alpenglow) |
| `switch_off_identity.yml` | Disable identity (tower backup, or on Alpenglow the vote history file) |
| `switch_on_firedancer_identity.yml` | Enable Firedancer identity. Refused on mainnet in every state (Alpenglow): a Firedancer or Frankendancer host cannot take a mainnet identity |
| `switch_off_firedancer_identity.yml` | Disable Firedancer identity. On mainnet only while the cluster runs TowerBFT, to move a node off Firedancer before the activation; it stops before it changes anything in the migration window, shortly before the activation, when the cluster cannot be read, and on Alpenglow |
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
| `init.yml` | Full initialization (agave, jito, allnodes-jito; the Firedancer types set up and start Firedancer) |
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
| `nodowntime_migrate.yml` | Zero-downtime identity migration. Refuses a Firedancer source or target before it changes anything (`SLV_KEYLESS_REFUSED`, see Keys) |
| `set_identity_key.yml` | Set identity key. Refuses a Firedancer host before it changes anything (`SLV_KEYLESS_REFUSED`, see Keys) |
| `set_identity_to_active.yml` | Retired, refuses for every host: it set the identity without the checks that `slv v set:identity` makes first, and on a Firedancer host it read a key file on the node (see Keys). The message starts with `SLV_KEYLESS_REFUSED`, nothing is changed, and it names `slv v set:identity -n testnet -p <host>` and `slv v switch -n testnet` |
| `set_unstaked_key.yml` | Switch to unstaked identity |
| `switch_on_identity.yml` / `switch_off_identity.yml` | Toggle identity |
| `switch_on_firedancer_identity.yml` | Retired, refuses (`SLV_KEYLESS_REFUSED`): it took the staked key from a file on the node, which deploy never copies there (see Keys) |
| `switch_off_firedancer_identity.yml` | Disable Firedancer identity |
| `change_identity_and_restart.yml` | Retired, refuses (`SLV_KEYLESS_REFUSED`): it linked the identity of the node to a staked key on the node and restarted firedancer.service, so that every restart started with the staked identity (see Keys) |
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
| `assert_unstaked_identity.yml` | Stop the deploy, before the node starts, when `/home/solv/identity.json` does not resolve to `/home/solv/unstaked-identity.json` |
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
| `validator_type` | Validator type (`jito`, `allnodes-jito`, `agave`; `firedancer-agave` and `firedancer-jito` on testnet only, mainnet refuses them) | `jito` |
| `agave_version` | Agave version that `init.yml` builds for `validator_type` `agave` (and `firedancer-agave`): the git tag without its leading `v`, which the build adds. The host or `-e` first, else `version_agave` of the `mainnet_validators` or `testnet_validators` section of `~/.slv/versions.yml`; with neither the run stops before it builds. `init.yml` also stops, before it changes anything, on a client older than the floor of the network (mainnet 4.3.0, testnet 4.4.0-beta.0) | `version_agave` of `versions.yml` |
| `jito_version` | The same for `validator_type` `jito` (and `firedancer-jito`): the tag without its leading `v`, with its `-jito` suffix. Else `version_jito` of the section | `version_jito` of `versions.yml` |
| `allnodes_jito_version` | The same for `validator_type` `allnodes-jito`; the build adds the leading `v` and, to a version that does not contain it, `-allnodes`, to form the git tag. Else `version_allnodes_jito` of the section | `version_allnodes_jito` of `versions.yml` |
| `solana_version` | Not read by `init.yml` or by the builds. Read by `cmn/patch_sha256.yml` (the git ref it clones) and, on testnet, by the snapshot finder (`--version` in `setup_snapshot_finder.yml`, `restart_agave_with_rm_ledger.yml` and `restart_firedancer_with_rm_ledger.yml`, from the variable of the host) | none — `slv v patch:sha256` asks for it; a direct run of `cmn/patch_sha256.yml` stops without it |
| `firedancer_version` | Firedancer version | — |
| `snapshot_url` | Snapshot download URL | — |
| `identity_account` | Validator identity pubkey | — |
| `vote_account` | Vote account pubkey | — |
| `block_engine_url` | Jito block engine URL | `https://frankfurt.mainnet.block-engine.jito.wtf` |
| `shred_receiver_address` | Jito shred receiver. **Accepts a single string or a YAML list** — a list emits one `--shred-receiver-address` flag per entry | `64.130.50.14:1002` |
| `bam_url` | BAM scheduler URL — the validator starts with `--bam-url <value>` and joins the BAM pipeline. Applies to `jito` / `allnodes-jito` and must be paired with `block_engine_url` + `shred_receiver_address` (and the tip/merkle MEV flags). Can also be toggled at runtime without a restart: `agave-validator -l <ledger> set-bam-config --bam-url <url>` (empty to disable). Replaces the removed `jito-bam` validator_type | — |
| `commission_bps` | Commission in basis points | `0` |
| `dynamic_port_range` | Validator port range | `8000-8025` |
| `limit_ledger_size` | Ledger size limit | `200000000` |
| `expected_shred_version` | Expected shred version (testnet, epoch-dependent) | — |
| `expected_bank_hash` | **Cluster-restart only.** Emitted only when explicitly set (gated `is defined`). Do NOT set for normal operation — a stale value triggers a bank-hash-mismatch panic on restart | — |
| `wait_for_supermajority` | **Cluster-restart only.** Emitted only when explicitly set (gated `is defined`). Do NOT set for normal operation — a stale slot makes the validator hang/fail at startup | — |
| `xdp_enabled` | Enable XDP (eXpress Data Path) Turbine-retransmit acceleration. `agave` / `jito` only (Firedancer uses XDP natively). Gates the `--experimental-retransmit-xdp-*` flags and the systemd `CAP_NET_RAW/NET_ADMIN/BPF/PERFMON` capabilities. Per-host (NIC-/CPU-dependent) | `false` |
| `xdp_interface` | XDP NIC (bond member, e.g. the active data interface). Required when `xdp_enabled`; the flag block is skipped if blank | — |
| `xdp_cpu_cores` | XDP retransmit CPU core count | `1` |
| `xdp_zero_copy` | Enable `--experimental-retransmit-xdp-zero-copy`. Do NOT enable on `bnxt_en` / `ice` drivers | `false` |
| `xdp_poh_pinned_cpu_core` | Optional PoH pinned CPU core (`--experimental-poh-pinned-cpu-core`) | — |
| `source_host` | Source host for nodowntime migration | — |
| `target_host` | Target host for nodowntime migration | — |

## Keys

`slv v deploy` copies no staked key to the node. The node starts with `--identity /home/solv/identity.json`, a link to
`/home/solv/unstaked-identity.json` (`cmn/setup_unstaked_identity.yml`), and `cmn/assert_unstaked_identity.yml` stops
the deploy, before the node starts, when `identity.json` resolves to anything else. The staked key stays on the
controller at `~/.slv/keys/<identity_account>.json` and reaches the node only on stdin, during `slv v set:identity` and
`slv v switch`. A node that restarts comes back on its unstaked identity; `slv v set:identity -n <network> -p <host>`
puts the staked identity on it again.

Deploy does not remove a staked key either: a node that an earlier slv deployed may still hold
`/home/solv/<network>-validator-keypair.json`, and the DoubleZero deposit and withdrawal playbooks sign with it when it
is there (they stop without calling the signer when it is not).

Three playbooks are retired and refuse now. `set_identity_to_active.yml` (both networks) set the identity without the
checks that `slv v set:identity` makes first (that nothing votes with the identity, that the host has caught up, where
the identity is in gossip, and that the tower or vote history file of the identity is there); for a jito host (on
testnet also an agave host) it read the staked key on the controller and passed it on stdin, and on testnet a Firedancer
host read a key file on the node. `switch_on_firedancer_identity.yml` and `change_identity_and_restart.yml` on testnet read the staked key from a
file on the node. Each fails in its first task, with a message that starts with `SLV_KEYLESS_REFUSED` and names
`slv v set:identity` and `slv v switch`; nothing else runs.

On testnet a Firedancer host (`firedancer-agave`, `firedancer-jito`) takes the staked key from a file on the node, and a
deploy never copies one there. `set_identity_key.yml` refuses such a host, and `nodowntime_migrate.yml` refuses a Firedancer
source or target: both fail right after the check of the validator type, with a message that starts with
`SLV_KEYLESS_REFUSED` that says nothing was changed. `slv v switch` refuses before it demotes the source, so no node is
left unstaked. The staked identity moves between `agave`, `jito` and `allnodes-jito` hosts.

## Three Core Workflows

Almost every validator task is one of these three. Use the `slv v ...` shortcuts
for operations; they preserve target resolution, version checks and confirmations.

### A. Initial setup
```bash
slv v init                          # operator terminal; may change target state
slv v deploy -n <network> -p <host> # operator terminal; confirms deployment
```
The `init.yml` playbook handles user creation, package install, disk mount,
performance tuning, source build, snapshot download, systemd setup, and start. The
node starts on its unstaked identity: no staked key is copied to it (see Keys).

### B. Version / config update
```bash
# 1. Edit ~/.slv/versions.yml (e.g. set version_jito: 4.3.2-jito)
# 2. Build new binary from source
slv v build:solana -n <network> -p <host>
# 3. The build also renders start-validator.sh. For config-only changes use:
# slv v update:script -n <network> -p <host>
# 4. Restart only after the build and render succeed
slv v restart -n <network> -p <host>
```

### C. Zero-downtime identity migration

The following sequence describes the supported CLI implementation. The operator
runs the CLI in their terminal; the AI does not execute raw identity commands,
read private keys or call activation playbooks directly. History-file recovery
must follow the reported failure state and preserve the same guards.

```bash
slv v switch -n <network> -f <from_host> -t <to_host>
```
Runs `{net}-validator/nodowntime_migrate.yml`. Before it changes anything it asks
the cluster RPC which consensus the cluster runs (`getAgGenesisCert` and the
Alpenglow feature account) and takes one of these paths:

**TowerBFT (Alpenglow not active)**
1. `set-identity` to unstaked on `from_host`, copy tower file to local.
2. Upload tower to `to_host`, `set-identity --require-tower` to the staked key,
   register as `authorized-voter`.
3. Swap the host entries in the inventory file (so `slv v ...` keeps targeting
   the right physical box afterward).

After the source was demoted, a cluster RPC that cannot be read does not leave both
nodes unstaked right away: the probe of `to_host` retries for up to 60 seconds
(`slv_alpenglow_patience_seconds`). If the cluster stays unreadable and the reading
right before the demotion was less than half of `slv_alpenglow_margin_slots` slots
ago at the fastest slot time that is assumed (`slv_alpenglow_min_slot_seconds`, 0.2
by default; about 0.22 is measured on mainnet and testnet), which is 300 seconds for
the 3000 slots of the default margin, the promotion goes on and the output says so: with the tower after a TowerBFT reading (while the Alpenglow
feature account was pending at that reading, an activation cannot have started in
that time; while it was absent, one can have been scheduled since, the reading does
not rule that out, and the output says so), with the vote history file after an
Alpenglow reading (Alpenglow does not revert; not with a Firedancer or Frankendancer
host). agave still checks the tower or the vote history file itself when the
identity is set. A cluster that is between the activation and the certificate
(`window`), or that turned Alpenglow after a TowerBFT reading, stops the promotion,
and the message says that both hosts are unstaked and what to do by hand.

**Alpenglow (the cluster has its genesis certificate)** - the vote history file
`/mnt/ledger/vote_history-<identity_account>.bin` takes the place of the tower
file. Votor needs it to keep from voting twice in a slot.
1. Before the demotion: `from_host` must hold that file, or the switch stops with
   nothing changed. `from_host` and `to_host` must carry the same
   `identity_account` in the inventory, and the `vote_account` of `from_host` must
   belong to it (the cluster names that identity as its `nodePubkey`). The switch
   stops there too, with nothing changed, when the cluster cannot be read or does not
   list the vote account.
2. `set-identity` to unstaked on `from_host`. The admin RPC returns before Votor
   has handled the change, so the switch waits (60 seconds at most) for Votor's
   log line `set-identity: from <identity> to ...` in the validator log and for
   the file to stop changing (two sha256 reads a few seconds apart are equal).
   Only then it copies the file to the controller: `~/.slv/vote_history/`, folder
   `0700`, file `0600`.
3. Upload the file to `to_host` with the owner and mode agave gives it,
   `set-identity` to the staked key **without** `--require-tower` (agave then
   refuses unless the vote history file is there), `authorized-voter add` (it has
   to succeed; "already present" counts as success), then wait (60 seconds at
   most) until `to_host` votes: its vote history file changes, which Votor
   does only when it casts a vote, and the last vote of the vote account
   (`getVoteAccounts`, `lastVote`) moves on the cluster. `rootSlot` is no sign of
   life under Votor: it moves in bursts and stays behind for some validators
   that vote every slot.
4. The copy on the controller is removed when all of that worked. If a step
   fails the copy stays, and the message says where it is, which hosts are
   unstaked right now and what is left to do by hand: copy the file to
   `/mnt/ledger` on `to_host`, wait until the vote account has not voted for 270
   slots (about one minute), and run `slv v set:identity -n <network> -p <to_host>`.
   Nothing is promoted automatically.
   `switch_on_identity.yml` run on its own refuses on Alpenglow: it puts a vote
   history file on a host only when the same run took it off the source (it compares
   the sha256 of the copy with the one the take recorded), because a copy left on
   the controller by an earlier run can be older than the last vote of the node that
   ran the identity. `slv v set:identity` is the command for any other case.
5. Swap the host entries in the inventory file.

Firedancer and Frankendancer hosts (`firedancer-agave`, `firedancer-jito`,
`frankendancer`) cannot be the source or the target of a switch, or take an
identity with `set:identity`, while the cluster runs Alpenglow: where they keep
the vote history file is not confirmed. The same switch works for them on
TowerBFT, except on testnet: a Firedancer host there is refused as the source or the
target of a switch, and by `set:identity`, whatever the cluster runs (see Keys).

**Between the Alpenglow activation and the genesis certificate (`window`), shortly
before the activation (`imminent`: the feature is pending and fewer than 3000
slots are left in the epoch), or when the state cannot be read (`unknown`)**: every
identity change (`switch`, `set:identity`, `set:unstaked`) that has not demoted
anything yet stops with nothing changed, on both networks. Run it again once
`getAgGenesisCert` returns a certificate. A switch that has already demoted
`from_host` stops the promotion instead when the state turns `window` or `imminent`,
or stays `unknown` and the rules above do not let it go on: both hosts are unstaked
then, and the message says what is left to do by hand.

`from_host` / `to_host` are inventory keys (e.g. `validator-primary`,
`validator-spare`), not IPs. Both must have `validator_type` set
(`agave`, `jito`, or `allnodes-jito`; Firedancer types on TowerBFT only, and not on
testnet), the
local key file at `~/.slv/keys/<identity_account>.json`, and
`unstaked-identity.json` on each remote box.

#### Setting the identity on one host, and when the primary is dead

```bash
slv v set:identity -n <network> -p <host>                  # needs the vote history file on <host> (Alpenglow) or the tower (TowerBFT)
slv v set:identity -n <network> -p <host> --first-activation  # Alpenglow: the vote account has not voted since the genesis certificate; TowerBFT: the identity has never voted
slv v set:identity -n <network> -p <host> --primary-down      # the old primary is stopped and cannot vote
```
On Alpenglow `set_identity_key.yml` needs `/mnt/ledger/vote_history-<identity>.bin`
on the host (unless `--first-activation` or `--primary-down`) and never passes
`--require-tower`. Copy the file from the host that last ran the identity (a switch
does that).

The file does not show that nobody else votes with the identity: it can be older
than the last vote of the node that held the identity. So on every Alpenglow run,
with the file or without it and a first activation included, the playbook asks
the cluster before it sets anything, and stops with nothing changed when one of
these fails or cannot be read (the vote account has to belong to the identity as well:
its `nodePubkey` in `getVoteAccounts` is the `identity_account`, or the play stops):
1. Nothing votes with the identity: the last vote of the vote account
   (`getVoteAccounts`, `lastVote`) is more than 270 slots before the current slot
   of the cluster (`getSlot`). The last vote is also asked of the RPC of `<host>`, and
   the larger of the two counts, because a public RPC behind a load balancer can
   answer from a backend that is far behind. A running validator answers
   `getVoteAccounts`, so the check fails when `<host>` gives no readable answer or does
   not list the vote account, instead of going on with the value of the cluster alone.
   The check cannot tell which node votes. If `<host>`
   already runs the identity it fails too, and the message says so: look at the
   identity `<host>` runs (its own RPC, `getIdentity`) before you run the command
   again, because then there is nothing to set.
2. `<host>` has caught up: its finalized slot (its own RPC, `getSlot` with
   commitment `finalized`) is at least 270 slots past that last vote.
3. Gossip: the cluster (`getClusterNodes`) lists the identity at no gossip address
   but the one of `<host>` and `primary_down_address`, compared by IP (an
   `ansible_host` that is a name is looked up on the controller). The gossip address
   is the `gossip` socket of the entry of the identity, the field the CLI reads. The
   other sockets of the entry are not compared: a validator connected to BAM
   advertises some of them at the BAM node.

After the old primary stopped, or was switched to its unstaked identity, give it
about one minute (270 slots at about 0.22 seconds a slot) before you run the command.

A play that holds more than one host with the same `identity_account` stops on
Alpenglow: each host would pass the checks before any host sets the identity. Run it
for one host at a time.

On Alpenglow, `--first-activation` is for a vote account that has not voted since the
genesis certificate: a new one, or one that voted only under TowerBFT, so that no vote
history file exists to copy (a single host that restarted unstaked before the
activation is the usual case). agave asks for the file only when the last vote of the
vote account is after the slot of the genesis certificate
(`should_require_vote_history_file`, which also needs the vote account to name this
identity), and the playbook mirrors it: it reads that slot from `getAgGenesisCert`
first and the last vote from `getVoteAccounts` (with `keepUnstakedDelinquents`), and
refuses the first activation when the last vote is after the genesis slot, when either
cannot be read, or when the vote account is not on the cluster. A vote account that
exists and has never voted is listed with a last vote of 0. The three checks above run
for a first activation too.

On TowerBFT, `--first-activation` only waives the tower file, and it is for an identity
that has never voted: without it the playbook stops when neither the tower file nor a
vote history file is on the host, and with it the playbook sets the identity without a
tower file (no `--require-tower`). There is no genesis certificate on TowerBFT, so
nothing is compared with one.

A staked node can stay in the gossip table for a long time after it stops, so an
entry of the identity at the address of the old primary does not show that it runs;
a vote does. The CLI reads gossip before it starts the playbook. It lets one such
entry pass when the address belongs to an inventory host that is stopped (named with
`--primary-down`, confirmed with `--peer-down-confirmed`, or read as running another
identity) and nothing votes with the identity, and hands that address to the playbook
as `primary_down_address`. With `--primary-down` it also passes
`primary_down_confirmed=true`. The playbook allows the identity at that one address
only because check 1 shows that nothing votes there. Without `primary_down_address`,
an entry at any address but the one of `<host>` stops the play.

When the old primary is dead and its vote history file went with it, use
`--primary-down` (on every network a terminal is needed: the CLI asks you to type
the old primary's inventory name to confirm that it is stopped, powered off if
need be, and cannot vote). If `<host>` has no vote history file the playbook then
passes `--do-not-require-vote-history` to `set-identity`, after the checks above. If
the file is there it is used and the flag is not passed, whatever
`primary_down_confirmed` says. `--do-not-require-vote-history` skips the protection
against voting twice in a slot: use it only for a primary that is really down. On
TowerBFT the playbook ignores `primary_down_confirmed` and `primary_down_address`.

## Alpenglow readiness, before and after epoch 1064

```bash
slv v check:alpenglow -n mainnet                     # every validator of the inventory
slv v check:alpenglow -n testnet -p host-a,host-b    # some of them
```
Read-only: it reads the inventory, `~/.slv/versions.yml` and the public RPC of the
network, contacts no host and makes no transaction. For each validator it prints one
line per check, `OK`, `WARN` or `FAIL`, with the fix, and it exits with 1 when a check
FAILs. A WARN about consensus still means identity changes are blocked; exit code
0 alone is not permission to promote. Funding, voter changes and signing fixes
are separate operator actions outside AI key handling. Run it before epoch 1064 and again after the genesis certificate exists
(`getAgGenesisCert` returns one).

| Check | What it looks at | Fix |
|---|---|---|
| `client` | `validator_type` (mainnet: `agave`, `jito` or `allnodes-jito`) and the version pinned in `~/.slv/versions.yml`, against the floor of the network | set the pin in `versions.yml`, then `slv v build:solana`, `slv v update:script`, `slv v restart` |
| `running` | the version the node advertises in gossip, against the floor and the pin. A standby on its unstaked key is not visible in gossip and does not fail | as for `client`: pin, build, update the script, restart |
| `bls` | the vote account has a BLS public key | `slv v register:bls -n <net> -p <host>` |
| `vat` | the vote account holds the Validator Admission Ticket, 0.8 SOL per epoch, on top of its rent-exempt minimum. FAIL below 0.8 SOL above the rent exemption, WARN below 3 epochs of it | send SOL to the vote account, not to the identity |
| `identity` | the identity pays the TowerBFT vote fees, about 1 SOL per epoch. WARN below 3 SOL while TowerBFT runs; under Alpenglow votes are not transactions and these fees go away | send SOL to the identity |
| `voter` | the authorized voter of the vote account is the identity that slv adds to the validator | `solana vote-authorize-voter-checked <vote> <current voter or withdraw authority keypair> ~/.slv/keys/<identity>.json`, then `slv v register:bls` |
| `cluster` | what the cluster runs: TowerBFT, activation about to start, migration window, Alpenglow, or unreadable. The WARN states (about to start, window, unreadable) mean that identity changes are refused | run the check again after the genesis certificate exists |

The `client` check reads the version pinned for the host, the `running` check what
gossip shows for it.

## Validator Requirements: BLS (SIMD-0387), XDP, BAM

### BLS public key (SIMD-0387)

Voting validators must register the BLS public key derived from their authorized
voter keypair. Without it the vote account behaves as **unstaked** once SIMD-0357
(Alpenglow voting) activates. SIMD-0387 is active on mainnet and testnet, so the
key can be registered now. The authorized voter defaults to the validator
identity, so the identity keypair signs and fills the derived BLS key:

```bash
slv v register:bls -n <network> -p <host>   # all hosts if -p omitted
```

- Runs `solana vote-authorize-voter-checked <vote> <identity> <identity> --fee-payer <identity> --use-v2-instruction`
  with the identity key file in `~/.slv/keys`. `--use-v2-instruction` forces the
  instruction that carries the BLS public key. The identity signs, is the new
  voter and pays the fee, so it needs SOL, and the solana CLI needs no default
  keypair of its own. The identity becomes the authorized voter, or stays it when
  it already is.
- Idempotent: skips hosts whose on-chain `blsPubkeyCompressed` is already set and
  re-reads it to confirm success.
- A registration that does not happen is an error: the command prints it and
  exits with code 1. That is a send that fails, a transaction that leaves the vote
  account without a BLS public key, a solana that cannot be started, a host that
  the inventory does not have or that has no `vote_account` or
  `identity_account`, no host to register, a network other than testnet or
  mainnet, and an unset `HOME`. After a failed send the error lists what to
  check: the key file is the key of the authorized voter or the authorized
  withdrawer of the vote account, the solana CLI is 4.1.0 or higher, the identity
  has SOL for the fee, and the voter of the vote account was not changed in this
  epoch (one voter change is accepted per epoch, and this registration is one).
  Then run the command again.
- Auto-runs at the end of `slv v deploy` for the hosts whose identity key file is
  on the machine that runs slv; for the others it prints the command to run
  later. It prints the same error lines when a registration does not happen, but
  it does not change the exit code of the deploy.
- Requires `solana` version 4.1.0 or higher (`solana --version`).

### XDP retransmit acceleration

`agave` / `jito` only — Firedancer uses XDP natively. Set the per-host
`xdp_*` inventory vars (see Key Variables); `slv v init` prompts for them. When
`xdp_enabled` + a non-empty `xdp_interface` are present, the start script gains
`--experimental-retransmit-xdp-*` flags and the systemd unit gets
`CAP_NET_RAW CAP_NET_ADMIN CAP_BPF CAP_PERFMON`. Needs kernel 6.8+ (igb: 6.14+).
Do not enable `xdp_zero_copy` on `bnxt_en` / `ice` drivers. Flags are
`--experimental-` in current Agave and may be renamed upstream.

### BAM (jito)

Joining BAM needs `bam_url` **plus** `block_engine_url` and
`shred_receiver_address` (BAM runs alongside the block engine, it does not
replace it), and the MEV flags (`--tip-payment-program-pubkey`,
`--tip-distribution-program-pubkey`, `--merkle-root-upload-authority`,
`--commission-bps`) — all already emitted by the jito start template. A relayer
URL is not used with BAM. BAM can be enabled/disabled at runtime without a
restart via `agave-validator -l <ledger> set-bam-config --bam-url [<url>]`.
A validator only connects to BAM while it is in the leader schedule.

## Runtime commands and templates

Use the installed CLI's focused `--help` to verify flags. Runtime templates are
selected from `~/.slv/template/<CLI version>/`; the skill's playbooks are reference
copies. Do not choose a directory by sorting version names, or call `init.yml`
directly to work around CLI target, version, identity or confirmation guards.

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
| `validator_type` | "Which validator type?" | `jito`, `allnodes-jito`, `agave`; `firedancer-agave` and `firedancer-jito` on testnet only (mainnet refuses them) |
| `agave_version` | "Solana version?" (if agave; default: 4.3.2 on mainnet, the `version_agave` pin of `~/.slv/versions.yml`; testnet reads its own section) | Semver, no leading `v` |
| `jito_version` | "Jito version?" (if jito; default: 4.3.2-jito on mainnet, the `version_jito` pin of `~/.slv/versions.yml`; testnet reads its own section) | Semver with the `-jito` suffix, no leading `v` |
| `allnodes_jito_version` | "Allnodes-Jito version?" (if allnodes-jito; default: 4.3.2-allnodes on mainnet, the `version_allnodes_jito` pin of `~/.slv/versions.yml`; testnet reads its own section) | Semver, with or without `-allnodes`, no leading `v` |
| `firedancer_version` | "Firedancer version?" (testnet, if firedancer) | String |
| `identity_account` | "Existing identity public key, or prepare one in your terminal?" | Public key only; operator handles private material |
| `vote_account` | "Existing vote account public key, or prepare one in your terminal?" | Public key only; operator handles private material |
| `snapshot_url` | "How will this network obtain a snapshot?" | Use the network-specific CLI/template path; testnet init may leave it empty for discovery |

### Optional Variables (show defaults, confirm)

| Variable | Default | When Required |
|---|---|---|
| `ssh_user` | Confirm the actual login user; `solv` is prepared by setup | Always |
| `commission_bps` | Read saved inventory; init uses `1000` for testnet and prompts Jito mainnet | Review before voting |
| `dynamic_port_range` | Read saved inventory; current init writes `8900-8930` | Verify role-specific firewall |
| `limit_ledger_size` | `200000000` | Always |
| `allowed_ssh_ips` | — | Strongly recommended (UFW) |
| `allowed_ips` | — | Optional (UFW) |
| `block_engine_url` | Auto by region | Jito types only |
| `shred_receiver_address` | Auto by region | Jito types only |
| `bam_url` | — | Jito types joining BAM |
| `expected_shred_version` | Epoch-dependent | Testnet only |
| `expected_bank_hash` | — | Cluster restart only (leave unset normally) |
| `wait_for_supermajority` | — | Cluster restart only (leave unset normally) |
| `xdp_enabled` (+ `xdp_interface`, `xdp_cpu_cores`, `xdp_zero_copy`, `xdp_poh_pinned_cpu_core`) | `false` | agave/jito, per-host |

### Optional: Reference RPC

| Variable | Description | Default |
|---|---|---|
| `reference_rpc_url` | Reference RPC endpoint for slot sync comparison (e.g., ERPC) | — |

Use an operator-configured reference RPC for the same network when checking
synchronization. Keep any credential-bearing URL outside chat and logs; SLV AI
account access itself uses `slv login` OAuth, not an RPC API key.

### Run setup and deployment in a terminal

After reviewing the target and intended changes, have the operator run:

```bash
slv v init
slv v deploy -n <network> -p <host>
```

Select the desired network in init. It prepares inventory, keys through the
operator's prompts, the solv user and remote optimization. The deploy command
selects the matching runtime template and asks for confirmation. For local setup,
use `slv v init --localhost` and then deploy the resulting named inventory entry.

The CLI enforces mainnet 4.3.0 and testnet 4.4.0-beta.0 minimum client versions.
Read the current network-specific pins rather than assuming example versions
are current. If the user is uncertain, review the plan and stop before execution;
there is no deploy `--check` flag, and a direct playbook is not a safe replacement
for the CLI's checks.

## Performance Tuning

`slv v init` automatically applies node-level performance tuning **after the SSH
connection check** and **before** `slv v deploy`. The orchestrator playbook
(`cmn/optimize_node.yml`) chains three sub-skills and reboots the node once
when GRUB / kernel changes require it.

| Sub-skill | Playbook | Description | Reboot |
|---|---|---|---|
| `slv-smt-disable` | `cmn/smt_disable.yml` | Disables Hyper-Threading via GRUB `nosmt=force` | **Yes** (first run) |
| `slv-irq-tuning` | `cmn/irq_tune.yml` | NIC IRQ 1:1 pin + RPS/XPS + ring 8192 + sysctl + ulimit + THP off + NVMe queue=ncores | Only if NVMe GRUB changed |
| `slv-performance-boost` | `cmn/boost_performance.yml` | HWE kernel install + amd_pstate=active + governor=performance + EPP + boost + cpuidle disable + scaling_max_freq | **Yes** if AMD < 6.14 or AMD GRUB updated |

### Idempotency markers

Each sub-skill writes a marker file so subsequent runs no-op safely:

| Marker | Skill |
|---|---|
| `/var/lib/slv/.smt_disabled` | smt_disable |
| `/var/lib/slv/.irq_tuned` | irq_tune |
| `/var/lib/slv/.boost_applied` | boost_performance |

### Reboot Flow

`cmn/optimize_node.yml` runs the three sub-playbooks, collects each one's
`need_reboot` fact, then calls `ansible.builtin.reboot` once if any of them
requested it (waits up to 15 min for the host to come back). No manual user
intervention is required.

### Standalone Usage

```bash
# Run full optimization stack
ansible-playbook -i inventory.yml cmn/optimize_node.yml --limit <host>

# Or run a single sub-skill
ansible-playbook -i inventory.yml cmn/smt_disable.yml --limit <host>
ansible-playbook -i inventory.yml cmn/irq_tune.yml --limit <host>
ansible-playbook -i inventory.yml cmn/boost_performance.yml --limit <host> -e amd_pstate_mode=active
```

### CLI Command Mapping

| CLI Command | Playbook |
|---|---|
| `slv v init` (after SSH check) | `cmn/optimize_node.yml` (auto-reboot if needed) |
| `slv v deploy` | `{net}/init.yml` |
| *(standalone optimization)* | `cmn/optimize_node.yml` |
