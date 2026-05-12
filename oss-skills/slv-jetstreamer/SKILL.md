---
name: slv-jetstreamer
description: Build, configure, and run anza-xyz/jetstreamer + ClickHouse on a dedicated analytics node. Streams Old Faithful CAR archives at multi-million-TPS into ClickHouse so historical Solana data is queryable via SQL (program_invocations, slot_status, pubkey_mentions). Includes hourly backfill timer and a rolling-window retention option.
---

# SLV Jetstreamer Skill

`jetstreamer` is anza-xyz's high-throughput Solana ETL engine: it streams the Old
Faithful CAR archive directly into a local ClickHouse instance and produces
query-ready aggregations (program invocation counts, slot statuses, pubkey
mentions, …). Together with the `slv-rpc` of1 rolling cache, it gives a
clean separation:

| Layer | Component | Role |
|---|---|---|
| **JSON-RPC** (per-call) | `yellowstone-faithful` (Index RPC) + 30-epoch index cache | `getTransaction` / `getBlock` / `getBlockTime` etc. |
| **SQL analytics** (bulk) | `jetstreamer` + ClickHouse | Cross-epoch aggregations, program-level joins, MEV / DEX research |

Jetstreamer is **not** a server. It runs as a one-shot ETL per epoch and exits;
ClickHouse is the long-running query surface.

## Hardware target

| Resource | Recommended |
|---|---|
| CPU | AMD EPYC 64C+ (jetstreamer hits 2.7 M TPS+ ingest with all cores) |
| RAM | 128 GB+ (754 GB optimal for full-fat ClickHouse buffers) |
| Disk | 4-8 TB NVMe (RAID0 recommended for max write bandwidth — derived data is rebuildable from Old Faithful) |
| Network | 10 Gbps+ (50 Gbps demonstrated to fully saturate ingest path) |
| OS | Ubuntu 24.04, kernel 6.14+ |
| Toolchain | **Clang 16** (RocksDB compatibility — Clang 17/18 do *not* work), GCC 13, Rust (rustup, toolchain pinned by rust-toolchain.toml in jetstreamer repo) |

## Disk layout

The reference layout combines two NVMes into one mdadm RAID0 stripe:

```
/dev/nvme0n1 ─┐
              ├─ mdadm RAID0 (chunk=1M) ─► /dev/md0 ─► XFS @ /mnt/jetstreamer
/dev/nvme1n1 ─┘                                       (noatime,inode64,
                                                       logbufs=8,logbsize=256k)
```

Mount options chosen for sequential write bandwidth + many-small-files (CH parts):
`noatime,nodiratime,inode64,logbufs=8,logbsize=256k`. Format with
`mkfs.xfs -d agcount=64 -l size=1g` for parallel allocation groups + a 1 GiB
internal log (XFS log max).

Production benchmark on this layout: **8.1 GB/s sequential write, 13.0 GB/s
sequential read** (direct I/O).

## Components installed

| Path | Purpose |
|---|---|
| `/mnt/jetstreamer/jetstreamer/` | git clone of `anza-xyz/jetstreamer` |
| `/usr/local/bin/jetstreamer` | symlink → `target/release/jetstreamer` |
| `/usr/local/bin/clickhouse` | bundled binary extracted from jetstreamer's first run |
| `/usr/local/bin/jetstreamer-backfill.sh` | rolling backfill script |
| `/etc/clickhouse-server/config.xml` | base CH config (jetstreamer's preprocessed copy) |
| `/etc/clickhouse-server/config.d/01-perf.xml` | tuned memory + concurrency + merge_tree |
| `/etc/clickhouse-server/config.d/02-users.xml` | redirect users_xml → /etc/clickhouse-server/users.xml |
| `/etc/clickhouse-server/users.d/01-perf.xml` | per-query profile (max_memory_usage, threads) |
| `/etc/systemd/system/clickhouse-server.service` | persistent CH server |
| `/etc/systemd/system/jetstreamer-backfill.{service,timer}` | hourly ingest of new epochs |
| `/mnt/jetstreamer/clickhouse-data/` | persistent CH data (~50-200 GB / epoch in storage tables) |

## ClickHouse tuning highlights

For a 754 GB-RAM 64-core node:
- `max_server_memory_usage_to_ram_ratio = 0.65` → ~490 GiB
- `background_pool_size = 32`, `background_merges_mutations_concurrency_ratio = 4`
- `merge_tree.parts_to_throw_insert = 10000`, `parts_to_delay_insert = 8000`
- per-query: `max_memory_usage = 30 GiB`, `max_threads = 32`
- sysctl: `vm.max_map_count=2097152`, `vm.swappiness=1`, `net.core.somaxconn=4096`
- LimitNOFILE=1048576

## Jetstreamer tuning highlights

| Variable | Value | Why |
|---|---|---|
| `JETSTREAMER_THREADS` | `120` | leave 8 logical cores for OS + ClickHouse merges |
| `JETSTREAMER_BUFFER_WINDOW` | `64GiB` | aggressive ripget prefetch for high-bandwidth links |
| `JETSTREAMER_CLICKHOUSE_MODE` | `remote` | use the persistent systemd CH; do not spawn helper |
| `JETSTREAMER_CLICKHOUSE_DSN` | `http://localhost:8123` | local CH HTTP endpoint |

## Hourly rolling backfill

`jetstreamer-backfill.timer` fires `OnCalendar=hourly` and:
1. Asks `api.mainnet-beta.solana.com` for the current epoch.
2. Probes Old Faithful for the latest *published* epoch (one or two below tip).
3. Queries ClickHouse for slot ranges that already have ≥ 99% coverage.
4. Runs `jetstreamer <epoch>` for each missing epoch (in order).
5. Optional: `WINDOW=N` env enables `ALTER TABLE … DELETE WHERE slot < (latest-N)*432000` to drop old epochs.

## Querying

ClickHouse listens on `:8123` (HTTP) and `:9000` (native).  Query examples:

```sql
-- Top 10 non-vote programs by invocation count, last fully-ingested epoch
SELECT
  base58Encode(toString(program_id)) AS program,
  sum(count) AS invocations,
  formatReadableQuantity(sum(total_cus)) AS total_cus
FROM program_invocations
WHERE is_vote = 0
GROUP BY program_id
ORDER BY invocations DESC
LIMIT 10;

-- Slots ingested per epoch
SELECT intDiv(slot, 432000) AS epoch, count() AS slots
FROM jetstreamer_slot_status
GROUP BY epoch
ORDER BY epoch;

-- Total transaction throughput per epoch
SELECT
  intDiv(slot, 432000) AS epoch,
  sum(transaction_count) AS txs,
  sum(non_vote_transaction_count) AS non_vote_txs
FROM jetstreamer_slot_status
GROUP BY epoch
ORDER BY epoch;
```

ClickHouse has built-in `base58Encode` / `base58Decode` — no UDF needed for
displaying Solana addresses.

## Ansible entrypoint

`template/<VERSION>/ansible/cmn/install_jetstreamer.yml`. Key inventory vars:

| Variable | Default | Notes |
|---|---|---|
| `jetstreamer_data_dir` | `/mnt/jetstreamer` | Where RAID0 + XFS mount, repo, CH data live |
| `jetstreamer_raid_devices` | `['/dev/nvme0n1', '/dev/nvme1n1']` | Will be wiped+combined |
| `jetstreamer_raid_chunk_kb` | `1024` | mdadm chunk size |
| `jetstreamer_window_epochs` | `0` | `0` = no rotation; `>0` enables `ALTER … DELETE` |
| `jetstreamer_threads` | `120` | `JETSTREAMER_THREADS` |
| `jetstreamer_buffer_window` | `64GiB` | `JETSTREAMER_BUFFER_WINDOW` |
| `jetstreamer_max_server_memory` | `536870912000` (~500 GiB) | `<max_server_memory_usage>` |
| `jetstreamer_run_initial_ingest` | `false` | If `true`, foreground-runs the first backfill (heavy; days) |

The playbook is destructive on the first run (RAID0 reformats the listed
NVMes). Only target nodes that are dedicated jetstreamer hosts.

## Known throughput (production)

- Cold ingest of one recent epoch (~500 M txs): **8 min** with bundled CH, **5 min** with persistent CH (38% faster).
- Sustained ingest throughput: **1.7 M TPS** sustained, **2.8 M TPS** peak ramp.
- Per-epoch CH storage: ~2-3 GB compressed for `program_invocations` + `jetstreamer_slot_status` tables.

## Known ClickHouse pitfalls

- `<users_xml><path>` in the bundled config defaults to the data dir — must override to `/etc/clickhouse-server/users.xml` via a `replace="replace"` `<user_directories>` block in `config.d/`.
- `discard=async` mount option for XFS is rejected by some kernels; use plain mount opts.
- ClickHouse RuntimeDirectory needs `/run/clickhouse-server`; declare in the unit (`RuntimeDirectory=clickhouse-server`).
- `/mnt` defaulting to mode 0700 (some Solana host images) blocks the `clickhouse` system user from traversing — `chmod 0755 /mnt`.
