# SLV Validator Skill

Ansible playbooks and Jinja2 templates for deploying and managing Solana validators (mainnet and testnet).

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
refuse on mainnet.

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
| `slv v setup:firedancer` | `{net}/setup_firedancer.yml` | Setup/update Firedancer. Testnet only: refused on mainnet (Alpenglow) |
| `slv v update:firedancer` | `{net}/update_firedancer.yml` | Update Firedancer binary. Testnet only: refused on mainnet (Alpenglow) |
| `slv v update:script` | `{net}/update_startup_config.yml` | Re-render start-validator.sh from template |
| `slv v set:identity -p <host>` | `{net}/set_identity_key.yml` | Set validator identity key on one host (`--first-activation`, `--primary-down`; see workflow C) |
| `slv v set:unstaked` | `{net}/set_unstaked_key.yml` | Switch to unstaked identity |
| `slv v register:bls` | *(no playbook — solana CLI)* | Register the BLS pubkey on each vote account (SIMD-0387). Also auto-runs at the end of `slv v deploy` |
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
| `set_identity_to_active.yml` | Activate identity key (TowerBFT only: on Alpenglow it refuses and points to `slv v set:identity -n <network> -p <host>`) |
| `set_unstaked_key.yml` | Switch to unstaked identity |
| `switch_on_identity.yml` | Enable identity (tower copy, or on Alpenglow the vote history file that the same `slv v switch` run took, + key deploy; on its own it refuses on Alpenglow) |
| `switch_off_identity.yml` | Disable identity (tower backup, or on Alpenglow the vote history file) |
| `switch_on_firedancer_identity.yml` | Enable Firedancer identity. Refused on mainnet in every state (Alpenglow): a Firedancer or Frankendancer host cannot take a mainnet identity |
| `switch_off_firedancer_identity.yml` | Disable Firedancer identity. On mainnet only while the cluster runs TowerBFT, to move a node off Firedancer before the activation; it stops before it changes anything in the migration window, shortly before the activation, when the cluster cannot be read, and on Alpenglow |
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
| `set_identity_to_active.yml` | Activate identity (TowerBFT only; on Alpenglow use `slv v set:identity`) |
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
# 1. Edit ~/.slv/versions.yml (e.g. set version_jito: 4.3.2-jito)
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
   belong to it (the cluster names that identity as its `nodePubkey`), or the switch
   stops there too.
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
TowerBFT.

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
(`agave`, `jito`, or `allnodes-jito`; Firedancer types on TowerBFT only), the
local key file at `~/.slv/keys/<identity_account>.json`, and
`unstaked-identity.json` on each remote box.

#### Setting the identity on one host, and when the primary is dead

```bash
slv v set:identity -n <network> -p <host>                  # needs the vote history file on <host> (Alpenglow) or the tower (TowerBFT)
slv v set:identity -n <network> -p <host> --first-activation  # an identity that has never voted
slv v set:identity -n <network> -p <host> --primary-down      # the old primary is stopped and cannot vote
```
On Alpenglow `set_identity_key.yml` needs `/mnt/ledger/vote_history-<identity>.bin`
on the host (unless `--first-activation` or `--primary-down`) and never passes
`--require-tower`. Copy the file from the host that last ran the identity (a switch
does that).

The file does not show that nobody else votes with the identity: it can be older
than the last vote of the node that held the identity. So on every Alpenglow run
that is not a first activation, with the file or without it, the playbook asks
the cluster before it sets anything, and stops with nothing changed when one of
these fails or cannot be read (the vote account has to belong to the identity as well:
its `nodePubkey` in `getVoteAccounts` is the `identity_account`, or the play stops):
1. Nothing votes with the identity: the last vote of the vote account
   (`getVoteAccounts`, `lastVote`) is more than 270 slots before the current slot
   of the cluster (`getSlot`). The last vote is also asked of the RPC of `<host>`, and
   the larger of the two counts, because a public RPC behind a load balancer can
   answer from a backend that is far behind. The check cannot tell which node votes. If `<host>`
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
for one host at a time. `--first-activation` skips the checks, and so the playbook
asks the cluster for the vote account with `keepUnstakedDelinquents` and refuses
it when the last vote is above 0 (the identity has voted), when the answer cannot
be read, or when the vote account is not on the cluster. A vote account that exists
and has never voted is listed with a last vote of 0, and the first activation goes on.

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
FAILs. Run it before epoch 1064 and again after the genesis certificate exists
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
(Alpenglow voting) activates. The authorized voter defaults to the validator
identity, so the identity keypair signs and fills the derived BLS key:

```bash
slv v register:bls -n <network> -p <host>   # all hosts if -p omitted
```

- Runs `solana vote-authorize-voter-checked <vote> <identity> <identity> --use-v2-instruction`.
  Forcing the v2 instruction means that while the feature gate is still inactive
  the tx fails cleanly at simulation **without mutating state** (no wasted
  voter re-authorization). The authorized voter is unchanged.
- Idempotent: skips hosts whose on-chain `blsPubkeyCompressed` is already set and
  re-reads it to confirm success.
- Auto-runs (non-fatal) at the end of `slv v deploy`. Re-run manually after the
  feature activates on the target cluster.
- Requires a solana/agave CLI new enough to expose `vote-authorize-voter-checked
  --use-v2-instruction` and `solana-keygen bls_pubkey` (v4.x).

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

## Direct ansible invocation

If you need to bypass the `slv v` wrapper, the playbooks are designed to run
directly via `ansible-playbook` with `extra_vars`:

```bash
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"allnodes-jito","allnodes_jito_version":"4.3.2-allnodes","snapshot_url":"https://..."}'
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
| `validator_type` | "Which validator type?" | `jito`, `allnodes-jito`, `agave`; `firedancer-agave` and `firedancer-jito` on testnet only (mainnet refuses them) |
| `agave_version` | "Solana version?" (if agave; default: 4.3.2 on mainnet, the `version_agave` pin of `~/.slv/versions.yml`; testnet reads its own section) | Semver, no leading `v` |
| `jito_version` | "Jito version?" (if jito; default: 4.3.2-jito on mainnet, the `version_jito` pin of `~/.slv/versions.yml`; testnet reads its own section) | Semver with the `-jito` suffix, no leading `v` |
| `allnodes_jito_version` | "Allnodes-Jito version?" (if allnodes-jito; default: 4.3.2-allnodes on mainnet, the `version_allnodes_jito` pin of `~/.slv/versions.yml`; testnet reads its own section) | Semver, with or without `-allnodes`, no leading `v` |
| `firedancer_version` | "Firedancer version?" (testnet, if firedancer) | String |
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
| `bam_url` | — | Jito types joining BAM |
| `expected_shred_version` | Epoch-dependent | Testnet only |
| `expected_bank_hash` | — | Cluster restart only (leave unset normally) |
| `wait_for_supermajority` | — | Cluster restart only (leave unset normally) |
| `xdp_enabled` (+ `xdp_interface`, `xdp_cpu_cores`, `xdp_zero_copy`, `xdp_poh_pinned_cpu_core`) | `false` | agave/jito, per-host |

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
  -e '{"validator_type":"<type>","<version variable>":"<version>","snapshot_url":"<url>"}'
```
`<version variable>` is `agave_version` for `agave`, `jito_version` for `jito` and
`allnodes_jito_version` for `allnodes-jito`. Write `<version>` without a leading `v` (the
build adds it), at or above the floor of the network (mainnet 4.3.0, testnet 4.4.0-beta.0):
`init.yml` stops before it changes anything on an older one. Leave the variable out to build
the pin of `~/.slv/versions.yml`.

### Dry-Run First

Always offer `--check` mode before actual deployment:
```bash
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"jito","jito_version":"4.3.2-jito"}' --check
```

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
