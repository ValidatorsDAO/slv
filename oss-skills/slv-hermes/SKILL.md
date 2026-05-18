---
name: slv-hermes
description: Deploy a self-hosted Pyth Hermes price feed API stack (NATS + Beacon + Hermes) on a VPS. Hermes serves Pyth Network's REST/WS price feeds (`/v2/updates/price/latest`, `/v2/price_feeds`, `/ws`) by listening to Pythnet for accumulator messages and to the Wormhole network (via Beacon, a highly-available spy) for VAAs. The recipe builds all three components from source, drops systemd units, and validates `/v2/price_feeds` returns 200.
---

# SLV Hermes Skill

Ansible recipe + skill docs for deploying a self-hosted Pyth Hermes API
(REST + WebSocket price feeds) on a single VPS.

## What is Hermes?

> Hermes is a web service designed to monitor both Pythnet and the
> Wormhole Network for the next generation of Pyth price updates.
> It supersedes the Pyth Price Service, offering these updates through
> a user-friendly web API.
> — [hermes server README](https://github.com/pyth-network/pyth-crosschain/blob/main/apps/hermes/server/README.md)

Public endpoint is `https://hermes.pyth.network` (10 req/10s/IP rate
limit).  Self-hosting removes the rate limit, lets you pin a region, and
— combined with `slv-pythnet` — gives you full control over the data path.

## Stack components

```
┌──────────────────────────────────────────────────────────────┐
│ VPS (single host)                                            │
│                                                              │
│  nats-server :4222 ◄──┐                                      │
│  (JetStream)          │ writes VAAs                          │
│                       │                                      │
│                  ┌────┴──────────┐         REST/WS           │
│                  │ beacon         │◄────────────────────┐   │
│                  │  spy gRPC :7072│                     │   │
│                  └────┬───────────┘                     │   │
│                       │                                 │   │
│                       │ reads accumulator               │   │
│                       │                            ┌────┴───┐│
│                       └────► Pythnet HTTP/WS ────► │ hermes ││ ◄── clients
│                              (public or self-hosted) │ :7575 ││
│                                                    └────────┘│
└──────────────────────────────────────────────────────────────┘
                       ▲
                       │ Wormhole P2P gossip
                       ▼
                Wormhole guardian network
                (3 bootstrap peers, UDP :8999)
```

| Component | Purpose | Port |
|---|---|---|
| `nats-server` (JetStream) | VAA dedup/stream broker for Beacon | `:4222` |
| `pyth-network/beacon` | HA rewrite of Wormhole `spy`; writes VAAs to NATS, exposes spy gRPC | `:7072` (loopback), `:8999/udp` (P2P) |
| `pyth-network/pyth-crosschain` (apps/hermes/server) | Rust REST/WS API | `:7575` |

## VPS sizing

Hermes is light — the whole stack idles under 1 core and ~1 GB resident.
The constraint is network: Wormhole P2P + Pythnet WS combined run at a
few Mbps each way.

| Spec | Recommended | Minimum |
|---|---|---|
| vCPU | 4 | 2 |
| RAM | 8 GB | 4 GB |
| Disk | 80 GB SSD | 40 GB |
| Network | 1 Gbps (effective 100 Mbps suffices) | 100 Mbps |
| OS | Ubuntu 22.04 / 24.04 | — |

## Directory Structure

```
ansible/
  mainnet-hermes/  — orchestrator + lifecycle playbooks
  cmn/             — shared common playbooks (install_hermes_stack.yml lives here)
jinja/
  mainnet-hermes/  — systemd unit templates (nats/beacon/hermes)
```

## CLI Command ↔ Playbook Mapping

The `slv hermes` (alias `slv h`) CLI commands map to these playbooks.

| CLI Command | Playbook | Description |
|---|---|---|
| `slv h deploy` | `mainnet-hermes/init.yml` | Full Hermes stack deployment |
| `slv h start` | `mainnet-hermes/start_node.yml` | Start NATS → Beacon → Hermes |
| `slv h stop` | `mainnet-hermes/stop_node.yml` | Stop in reverse order |
| `slv h restart` | `mainnet-hermes/restart_node.yml` | Restart all three |
| `slv h update` | `mainnet-hermes/update_hermes.yml` | Rebuild from `hermes_repo_ref` and restart |

## Key Variables (extra_vars)

All optional — defaults work for a public-Pythnet bootstrap.

| Variable | Default | Description |
|---|---|---|
| `hermes_repo` | `https://github.com/pyth-network/pyth-crosschain` | Upstream repo |
| `hermes_repo_ref` | `main` | Branch / tag / SHA |
| `beacon_repo` | `https://github.com/pyth-network/beacon` | Upstream repo |
| `beacon_repo_ref` | `main` | Branch / tag / SHA |
| `nats_version` | `v2.10.22` | nats-server release tag |
| `hermes_rust_toolchain` | `1.82.0` | Rust toolchain for hermes build |
| `hermes_pythnet_http_addr` | `https://pythnet.rpcpool.com` | Pythnet HTTP RPC URL |
| `hermes_pythnet_ws_addr` | `wss://pythnet.rpcpool.com` | Pythnet WS RPC URL |
| `hermes_wormhole_env` | `mainnet` | `mainnet` or `testnet` |
| `hermes_rpc_listen_addr` | `0.0.0.0:7575` | REST/WS bind |
| `hermes_metrics_listen_addr` | `127.0.0.1:7576` | Prometheus metrics bind |
| `beacon_listen_port` | `8999` | UDP/QUIC port for Wormhole P2P |
| `beacon_spy_grpc_addr` | `127.0.0.1:7072` | spy gRPC bind (loopback recommended) |
| `nats_port` | `4222` | NATS client port |

## Usage

### 1. Write inventory

Copy `examples/inventory.yml` to `~/.slv/inventory.mainnet.hermes.yml` and
fill in your VPS:

```yaml
all:
  hosts:
    hermes-1:
      ansible_host: "<vps-ip>"
      ansible_user: "solv"
      ansible_ssh_private_key_file: "~/.ssh/id_rsa"
  vars:
    # Bootstrap with public Pythnet first, swap to self-hosted later.
    hermes_pythnet_http_addr: "https://pythnet.rpcpool.com"
    hermes_pythnet_ws_addr: "wss://pythnet.rpcpool.com"
```

### 2. Deploy

```bash
slv hermes deploy
# or directly:
ansible-playbook -i ~/.slv/inventory.mainnet.hermes.yml \
  ~/.slv/mainnet-hermes/init.yml
```

### 3. Verify

```bash
SOL_USD=ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
curl -s "http://<vps-ip>:7575/v2/updates/price/latest?ids[]=${SOL_USD}" \
  | jq '.parsed[0] | {price: .price.price, expo: .price.expo, time: .price.publish_time}'
```

### 4. (Optional) Switch to self-hosted Pythnet

After deploying a Pythnet RPC node via the `slv-pythnet` skill, edit the
inventory:

```yaml
    hermes_pythnet_http_addr: "http://<pythnet-rpc-ip>:8899"
    hermes_pythnet_ws_addr:   "ws://<pythnet-rpc-ip>:8900"
```

Then redeploy or restart:

```bash
slv hermes restart
```

## API surface

The standard Hermes API spec applies — anything the public
`hermes.pyth.network` endpoint serves works against the self-hosted
instance.  Common endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /v2/price_feeds` | List all feed IDs + metadata (~3000 entries) |
| `GET /v2/updates/price/latest?ids[]=<id>` | Latest parsed price + binary VAA for given feed ID(s) |
| `GET /v2/updates/price/<publish_time>?ids[]=<id>` | Historical update at a unix timestamp |
| `GET /ws` (WebSocket) | Subscribe to price updates |

Reference: <https://hermes.pyth.network/docs/>

## Known gotchas

- **UDP port `:8999` must be reachable from the public internet.**
  Wormhole P2P uses QUIC over UDP and the gossip mesh expects this peer
  to be externally addressable.  If your VPS provider has a firewall by
  default, add an allow rule for UDP/8999 inbound.
- **Beacon auto-generates `/home/solv/beacon-node.key`** on first start.
  This is a libp2p identity, not a wallet — you can delete it to rotate.
- The receive-buffer warning `failed to sufficiently increase receive
  buffer size (was: 208 kiB, wanted: 2048 kiB, got: 416 kiB)` is benign
  but indicates UDP throughput is suboptimal; bump
  `net.core.rmem_max=2097152` if you want it gone.
