---
name: slv-nftables
description: Deploy an OSS-clean nftables ruleset to any slv-managed host (Hermes, Pythnet RPC, validator, RPC, …). Inventory-driven — mgmt IPs, public ports, and per-port allow lists all come from `~/.slv/inventory.{network}.{role}.yml`, nothing is hardcoded. Atomic + rollback-safe (failed validation restores the previous config) and persistent across reboot. Used by `slv hermes firewall` and `slv pythnet firewall`; the same `cmn/deploy_nftables.yml` playbook works against any inventory.
---

# SLV nftables Skill

Inventory-driven nftables ruleset deployer.  One playbook
(`cmn/deploy_nftables.yml`) serves every slv role — Hermes, Pythnet
RPC, Solana RPC, validators — by reading the firewall description from
the same inventory that already configures the service itself.

## What it does

1. Renders `/etc/nftables.conf` + fragments under `/etc/nftables.d/`
   and `/etc/nftables.sets.d/` from Jinja2 templates.
2. Validates the rendered config (`nft -c`) before applying.  If
   validation fails, the previous config is restored and the playbook
   aborts — you cannot lock yourself out via a bad template.
3. Applies atomically (`nft -f`).
4. Seeds allowlist sets with IPs from inventory, preserving any
   elements added at runtime with `nft add element …` so re-running the
   playbook never wipes manual additions.
5. Exports the live ruleset back into `/etc/nftables.conf` and enables
   `nftables.service` so the same ruleset is restored on reboot.

## Ruleset shape

```
chain input  (default: drop)
  ├─ accept loopback
  ├─ accept established/related
  ├─ accept icmp / icmpv6
  ├─ banAll_v4 drop                       (highest priority)
  ├─ mgmt_ips_v4 accept                   (full access)
  ├─ allowAll_v4 accept                   (runtime additions, full access)
  ├─ mgmt_ips_v4 → tcp dport ssh_port accept   (belt-and-suspenders)
  ├─ public_tcp_ports / public_udp_ports accept
  └─ restricted_ports[]: allow_<port>_v4 accept else drop
```

## Inventory variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `mgmt_ips_v4` | **yes** | — | List of IPv4/CIDR with full access.  Empty list aborts the playbook. |
| `mgmt_ips_v6` | no | `[]` | Same for IPv6 |
| `ban_ips_v4` | no | `[]` | Hard-deny list (evaluated first) |
| `ssh_port` | no | `22` | SSH port to keep open from mgmt |
| `public_tcp_ports` | no | `[]` | TCP ports/ranges accepted from any source |
| `public_udp_ports` | no | `[]` | UDP ports/ranges accepted from any source |
| `restricted_ports` | no | `[]` | Per-port allowlist (see below) |
| `disable_ufw` | no | `true` | Stop/disable ufw to avoid conflict |
| `preserve_existing` | no | `true` | Preserve runtime `nft add element` additions |

### `restricted_ports` schema

```yaml
restricted_ports:
  - port: 8899              # int or range string ("8000-8020")
    tcp: true               # default true
    udp: false              # default false
    allow_ipv4:
      - "203.0.113.10"
      - "198.51.100.0/24"
```

Set + counter names are derived from `port` automatically:

| `port` | set | counter (allow / drop) |
|---|---|---|
| `8899` | `allow_8899_v4` | `c_8899_allow` / `c_8899_drop` |
| `"8000-8020"` | `allow_8000_8020_v4` | `c_8000_8020_allow` / `c_8000_8020_drop` |

## Runtime management

```bash
# Add an IP to an allow list (effective immediately, no playbook re-run)
sudo nft add element inet filter allowAll_v4 { 198.51.100.42 }
sudo nft add element inet filter allow_8899_v4 { 203.0.113.10 }

# Remove
sudo nft delete element inet filter allowAll_v4 { 198.51.100.42 }

# Inspect
sudo nft list set inet filter allow_8899_v4

# Counter check (how many packets dropped / accepted per port)
sudo nft list counter inet filter c_8899_drop
sudo nft list counter inet filter c_8899_allow
```

Runtime changes survive reboot **only after** the next playbook run,
which re-exports the live ruleset back into `/etc/nftables.conf`.  If
you need an addition to persist immediately, run the playbook again
(it's idempotent and preserves runtime state by design).

## CLI Command ↔ Playbook Mapping

| CLI Command | Inventory | Description |
|---|---|---|
| `slv hermes firewall` | `mainnet_hermes` | Apply to Hermes hosts |
| `slv pythnet firewall` | `mainnet_pythnet` | Apply to Pythnet RPC hosts |

The playbook itself (`cmn/deploy_nftables.yml`) is role-agnostic.
Adding a `slv <other> firewall` subcommand is one TypeScript dispatch
+ an `InventoryType` variant — see how `slv hermes firewall` is wired
in `cli/src/hermes/index.ts`.

## Example: Hermes node (public API)

```yaml
all:
  hosts:
    hermes-1:
      ansible_host: "<vps-ip>"
      ansible_user: "solv"
  vars:
    mgmt_ips_v4: ["<your-admin-ip>"]
    public_tcp_ports: [7575]         # REST/WS API
    public_udp_ports: [8999]         # Wormhole P2P
```

## Example: Pythnet RPC (restricted JSON-RPC + public gossip)

```yaml
all:
  hosts:
    pythnet-1:
      ansible_host: "<bm-ip>"
      ansible_user: "solv"
  vars:
    mgmt_ips_v4: ["<your-admin-ip>"]
    public_tcp_ports: [8001, "8000-8020"]   # gossip + TPU
    public_udp_ports: [8001, "8000-8020"]
    restricted_ports:
      - port: 8899
        tcp: true
        allow_ipv4: ["<hermes-vps-ip>"]
      - port: 8900
        tcp: true
        allow_ipv4: ["<hermes-vps-ip>"]
```

## Safety properties

- **Lockout-resistant.** `mgmt_ips_v4` empty → playbook aborts before
  any change.
- **Atomic.** `nft -c` validates before `nft -f` applies.
- **Rollback.** Validation failure restores `/etc/nftables.conf.bak`.
- **Idempotent.** Re-runs preserve runtime allowlist additions.
- **Reboot-survivable.** Live ruleset exported back to
  `/etc/nftables.conf`; `nftables.service` enabled.

## Known gotchas

- **UFW conflicts.**  `disable_ufw: true` (default) stops + disables
  ufw before applying.  If you have a custom ufw setup you want to
  keep, set `disable_ufw: false` — but at that point you should
  probably not be using nftables directly anyway.
- **`ssh_port` ≠ inventory's `ansible_port`.**  If you SSH on a
  non-default port, set `ssh_port` to match — the playbook only
  carves out the value you pass it.
- **Set names with hyphens are illegal in nftables.**  We derive set
  names from `port` by `regex_replace('[^0-9]+', '_')`, so any range
  string (`"8000-8020"`) becomes a valid identifier (`allow_8000_8020_v4`).
