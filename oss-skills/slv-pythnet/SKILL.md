---
name: slv-pythnet
description: Run a self-hosted Pythnet RPC node — the application-specific Solana fork operated by Pyth's data providers. Pythnet RPC is what `slv-hermes` reads from for accumulator messages; running it locally completes a fully self-hosted Pyth price feed stack. Recipe handles disk mount, sysctl tuning, Solana 1.14 fork build (with cstdint workaround for modern GCC), identity gen, and systemd. Snapshot fetch + catch-up typically finishes in 10-20 minutes.
---

# SLV Pythnet Skill

Ansible recipe + skill docs for running a self-hosted **Pythnet RPC**
node — the application-specific Solana fork operated by Pyth's data
providers.

## What is Pythnet?

> Pythnet is an application-specific blockchain operated by Pyth's data
> providers.  This blockchain is a computation substrate to securely
> combine the data provider's prices into a single aggregate price for
> each Pyth price feed.  Pythnet forms the core of Pyth's off-chain
> price feeds that serve all blockchains.
> — [pyth-network/pythnet README](https://github.com/pyth-network/pythnet)

It's a Solana 1.14.17 fork.  Running it as a no-voting RPC node lets you
serve Pythnet HTTP+WS directly to a self-hosted Hermes (see
`slv-hermes`), eliminating the dependency on public Pythnet endpoints
(Triton, P2P, Blockdaemon, Figment).

## Why self-host?

Pyth Network's documentation notes that running Pythnet RPC yourself is
"discouraged due to the potential high cost and maintenance involved" —
which is true relative to using a managed provider, but **wildly
overstated** when compared to running a Solana mainnet RPC.  Pythnet's
traffic is tiny: only Pyth oracle operations, ~21 validators, no DeFi
mints, no NFT spam.  Ledger growth is ~10 GB/day.  Catch-up from a fresh
snapshot fetch finishes in 10-20 minutes (vs hours on mainnet).

If you already run Solana RPC infrastructure, Pythnet RPC is an order of
magnitude smaller across every dimension.

## Hardware target

Pythnet is light enough that **mid-range commodity hardware suffices**:

| Resource | Recommended | Note |
|---|---|---|
| CPU | 16-32 cores | Solana validator binary is multi-threaded but Pythnet TPS is bounded by Pyth oracle ops only |
| RAM | 128 GB (256 GB safety margin) | AccountsDB + RocksDB block cache |
| Disk | 2 TB NVMe (single) | Mainnet needs 4-8 TB RAID0; Pythnet doesn't |
| Network | 1 Gbps | Mainnet needs 10 Gbps+; Pythnet doesn't |
| OS | Ubuntu 22.04 / 24.04 | — |

A second NVMe is optional — the recipe can format and mount it as
`/mnt/ledger` if you set `pythnet_format_disk=true`, otherwise it uses
whatever directory you point `pythnet_ledger_mount` at.

## Directory Structure

```
ansible/
  mainnet-pythnet/  — playbooks (init.yml + supporting + lifecycle)
  cmn/              — shared common (create_user, fix_permissions, etc.)
jinja/
  mainnet-pythnet/  — start-pythnet.sh.j2 + pythnet.service.j2
```

## CLI Command ↔ Playbook Mapping

The `slv pythnet` CLI commands map to these playbooks.

| CLI Command | Playbook | Description |
|---|---|---|
| `slv pythnet deploy` | `mainnet-pythnet/init.yml` | Full Pythnet RPC deployment |
| `slv pythnet start` | `mainnet-pythnet/start_node.yml` | Start validator |
| `slv pythnet stop` | `mainnet-pythnet/stop_node.yml` | Stop validator |
| `slv pythnet restart` | `mainnet-pythnet/restart_node.yml` | Restart validator |
| `slv pythnet update` | `mainnet-pythnet/update_pythnet.yml` | Pull pythnet_ref, rebuild, restart |

## Network parameters (fixed by Pyth)

These are immutable network constants — verifiable via the public
Pythnet RPC at any time:

```bash
curl -s https://pythnet.rpcpool.com -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
# → GLKkBUr6r72nBtGrtBPJLRqtsh8wXZanX4xfnqKnWwKq
```

| Constant | Value |
|---|---|
| `expected_genesis_hash` | `GLKkBUr6r72nBtGrtBPJLRqtsh8wXZanX4xfnqKnWwKq` |
| `expected_shred_version` | `35891` |
| `feature_set` | `1435444185` |
| Validator version | `1.14.180` (Pyth-built; `solana-v1.14.180` base) |

## Key Variables (extra_vars)

| Variable | Default | Description |
|---|---|---|
| `pythnet_repo` | `https://github.com/pyth-network/pythnet` | Upstream |
| `pythnet_ref` | `pyth-v1.14.17` | Branch — currently the only supported one |
| `pythnet_rust_toolchain` | `1.78.0` | Bootstrap toolchain (build itself pins 1.60.0 via rust-toolchain) |
| `pythnet_ledger_mount` | `/mnt/ledger` | Where ledger/accounts/snapshots live |
| `pythnet_ledger_device` | `/dev/nvme0n1` | Disk to format if `pythnet_format_disk=true` |
| `pythnet_format_disk` | `false` | Set true to mkfs.xfs the secondary disk |
| `pythnet_force_format` | `false` | Required to wipe a device that already has a filesystem |
| `pythnet_rpc_port` | `8899` | JSON-RPC HTTP |
| `pythnet_rpc_bind` | `0.0.0.0` | Bind address |
| `pythnet_dynamic_port_range` | `8000-8020` | TPU/QUIC port range |
| `pythnet_gossip_port` | `8001` | Gossip port |
| `pythnet_entrypoint` | `pythnet.rpcpool.com:8001` | Boot peer for gossip+snapshot |
| `pythnet_known_validators` | (2 published Pyth validators) | `--known-validator` list |
| `pythnet_genesis_hash` | (constant above) | Sanity gate against wrong cluster |
| `pythnet_shred_version` | `35891` | Sanity gate against wrong cluster |
| `pythnet_limit_ledger_size` | `50000000` | Shred count cap |

## Usage

### 1. Write inventory

```yaml
all:
  hosts:
    pythnet-1:
      ansible_host: "<bm-ip>"
      ansible_user: "solv"
      ansible_ssh_private_key_file: "~/.ssh/id_rsa"
  vars:
    pythnet_format_disk: true        # only if you want the recipe to mkfs nvme0n1
    pythnet_ledger_mount: "/mnt/ledger"
```

### 2. Deploy

```bash
slv pythnet deploy
# or:
ansible-playbook -i ~/.slv/inventory.mainnet.pythnet.yml \
  ~/.slv/mainnet-pythnet/init.yml
```

### 3. Watch catch-up

```bash
ssh solv@<bm-ip> 'tail -f /mnt/ledger/pythnet/log/validator.log | grep -E "snapshot|known validator|optimistic"'
```

### 4. Verify

```bash
curl -fsS http://<bm-ip>:8899 -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
# → {"jsonrpc":"2.0","result":"ok","id":1}
```

### 5. Point Hermes at it

In your hermes inventory:

```yaml
    hermes_pythnet_http_addr: "http://<bm-ip>:8899"
    hermes_pythnet_ws_addr:   "ws://<bm-ip>:8900"
```

Then `slv hermes restart`.

## Known gotchas

- **`--account-index program-id` is mandatory** on Pythnet — the
  validator panics on startup without it.  The recipe sets this; if you
  customize the start script, do not remove it.
- **rocksdb fails to build under GCC 13+** without
  `CXXFLAGS="-include cstdint"`.  The build playbook handles this; if
  you build by hand, copy that env var verbatim.  *Do not* set CFLAGS
  with the same flag — blake3's build script uses `cc` to assemble `.S`
  files and `-include cstdint` corrupts the assembly source.
- **sysctl rmem/wmem must be 128 MiB** — the validator's startup
  self-check fails fast otherwise.  The recipe writes
  `/etc/sysctl.d/99-pythnet.conf` to enforce this.
- **Identity key has no monetary value** — Pythnet RPC nodes run with
  `--no-voting`, the identity is just a gossip pubkey.  Losing it costs
  nothing; the validator rejoins under a new pubkey on next start.
- **Disk usage**: expect ~10 GB/day ledger growth.  With
  `--limit-ledger-size 50000000` the ledger holds ~30 days of slots
  before rotation.
