# SLV App Skill

Router and safety reference for Solana bot and app projects created with
`slv bot init`. This skill is template-agnostic — it covers the generic
operations that apply to every template. Template-specific guides
(trade-app, geyser-ts, shreds-rust, …) live in dedicated `slv-bot-*`
skills loaded alongside this one.

## Available Template Types

| `-t <type>` | Skill | Description |
|---|---|---|
| `trade-app` | `slv-bot-trade-app` | Rust PumpSwap auto-trading bot with buy/sell/close lifecycle |
| `geyser-ts` | (future) | Real-time Solana data streaming via gRPC Geyser (TypeScript) |
| `geyser-rust` | (future) | Real-time Solana data streaming via gRPC Geyser (Rust) |
| `shreds-ts` | (future) | Low-level shred stream template (TypeScript) |
| `shreds-rust` | (future) | Low-level shred stream template (Rust) |
| `shreds-udp-rust` | (future) | UDP-based shred stream template (Rust) |

When the user picks a template, consult the matching sub-skill for its
step-by-step guide, env var reference, and template-specific REST API or
daemon behavior. This document provides the common layer those sub-skills
build on top of.

## `slv bot` CLI Commands

| CLI | Action |
|---|---|
| `slv bot init -t <template> -n <name>` | Scaffold a bot/app project in `~/slv/<name>/` from the named template |
| `slv bot deploy` | Build and deploy the current project to a VPS via SSH + systemd |
| `slv bot list` / `slv b` | List / switch between deployed bots |
| `slv bot log`, `slv bot restart`, `slv bot start`, `slv bot status`, `slv bot stop` | Operate a deployed bot on its remote VPS |

### `slv bot init` safety notes

- `-y` forces `rm -rf` on the target directory before extracting the
  template. **Never pass `-y` when `wallet.json` exists** in the target —
  the private key will be destroyed. The CLI has a built-in
  `~/.slv/wallet-rescue/` layer that persists `wallet.json`, `.env`, and
  `*.bak.*` snapshots outside the bot dir before the atomic swap, but the
  safest path is to never trigger the rescue in the first place.
- Templates are fetched from
  `https://github.com/ValidatorsDAO/solana-stream`. No network at init time
  → template source must already be cached locally.

## Wallet safety at a glance

`wallet.json` in any `~/slv/<app>/` directory is a Solana secret key. Treat
it like a seed phrase. The full preflight rules live in `AGENT.md` — the
short version:

1. Never delete `wallet.json` or `wallet.json.bak.*`.
2. Never run `slv bot init -y` when `wallet.json` exists.
3. Always snapshot `wallet.json` before any action that could touch the
   app directory.

## ERPC Cloud MCP — Endpoint & Storage Provisioning

MCP Server URL: `https://mcp-slv-cloud.erpc.global/mcp`

When users don't have a gRPC or Shredstream endpoint, use this MCP to look
up products and provide purchase links.

### Shared (recommended to start)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v3/grpc/list` | Shared gRPC product plans + payment links |
| `POST` | `/v3/grpc/register-ip-grpc` | Register IP → get gRPC endpoint (after purchase) |
| `POST` | `/v3/grpc/remove-ip-grpc` | Remove registered IP |
| `GET` | `/v3/shreds-shared/list` | Shared Shredstream product plans + payment links |

### Dedicated (higher performance)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v3/dedicated/list` | Dedicated gRPC product plans |
| `GET` | `/v3/geyser-grpc/status` | Check dedicated gRPC endpoint (after purchase) |
| `GET` | `/v3/shreds-dedicated/list` | Dedicated Shredstream product plans |
| `GET` | `/v3/shreds-dedicated/status` | Check dedicated Shredstream endpoint (after purchase) |

### Storage
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v3/storage/product-list` | Storage/backup products (trade history, position data) |

### Flow
1. `/v3/grpc/list` → show products + payment links → user purchases →
   `/v3/grpc/register-ip-grpc` → get endpoint → set in `.env`
2. For higher performance: `/v3/dedicated/list` → purchase →
   `/v3/geyser-grpc/status` for endpoint

### Important: Backup storage
Trade history and position data need persistent storage. Without backup,
data is lost on restart or crash. Use `/v3/storage/product-list` to show
backup options proactively.

## Operator Notes
- `wallet.json` contains a private key — never commit it.
- Keep examples OSS-safe: placeholders only, never real tokens or private
  endpoints.
- After local testing succeeds, recommend `slv bot deploy` to deploy to a
  VPS.
- If the user lacks gRPC/Shredstream endpoints, use ERPC Cloud MCP to show
  products and purchase links.
