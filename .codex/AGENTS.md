# AGENTS.md — SLV Repository (OSS)

## ⚠️ THIS IS AN OPEN-SOURCE REPOSITORY

**Every file, commit, PR, and comment is publicly visible.**
Treat every character you write as if it will be read by the entire world — because it will be.

## Security Rules (MANDATORY — NO EXCEPTIONS)

### 🚫 NEVER include in any file, commit message, PR, or comment:
- API keys, tokens, secrets, passwords, or credentials
- Internal or private API endpoints
- Internal hostnames, IPs of private infrastructure
- Authentication headers (e.g., `Authorization: Bearer ...`)
- Private environment variable values
- Internal database URLs or connection strings
- References to internal tools, dashboards, or monitoring systems
- Customer data, user IDs, or personally identifiable information

### ✅ Safe to include:
- Publicly documented API endpoints
- Public documentation URLs (erpc.global, docs, GitHub)
- Generic placeholder values (e.g., `YOUR_TOKEN_HERE`, `<server-ip>`)
- Ansible playbook usage with generic examples
- Architecture descriptions without internal implementation details

### External Communication
- **HTTP requests in code**: Any `fetch()`, `curl`, or HTTP call MUST use only public endpoints
- **Tokens in code**: Use placeholder constants (e.g., `EPRC_ZERO_BLOCK`), never real credentials
- **Environment variables**: Reference by name only (`$SOLANA_RPC_URL`), never embed actual values
- **Webhook URLs, callback URLs**: Never hardcode internal URLs

### Before Every Commit
1. `grep -r 'Bearer ' --include='*.ts' --include='*.yml'` — check for leaked tokens
2. `grep -r 'erpc.global' --include='*.ts' --include='*.yml'` — verify only publicly documented endpoints are referenced
3. Review any new HTTP calls — ensure they target only public endpoints
4. If any check fails → **DO NOT COMMIT**. Remove the reference first.

## Repository Overview

SLV is an open-source toolkit for Solana validator and RPC node deployment and management.

- **CLI**: `cli/` — Deno-based CLI tool (`slv` command)
- **Ansible**: `template/{version}/ansible/` — Deployment playbooks
- **Jinja**: `template/{version}/jinja/` — Configuration templates
- **Skills**: `dist/oss-skills/` — Self-contained AI agent skill packages

## Development Flow

1. Branch from `main` → implement → PR
2. All PRs require review before merge
3. Automated tests must pass
4. Security scan on every PR (no secrets, no internal refs)

## Skill Packages (`dist/oss-skills/`)

Each skill is a self-contained package with:
- `SKILL.md` — AI-readable playbook knowledge + interactive deployment flow
- `AGENT.md` — Agent persona and behavior rules
- `ansible/` — Playbooks with resolved dependencies
- `jinja/` — Configuration templates
- `examples/` — Sample inventory files

These are designed to be installed by AI coding agents (OpenClaw, Codex, Claude Code, etc.)
to enable automated Solana infrastructure management.

## Bot Templates (`slv bot init`)

Available templates in `ValidatorsDAO/solana-stream` → `temp-release/`:

| Template | Language | Description |
|----------|----------|-------------|
| `geyser-ts` | TypeScript | Geyser gRPC stream base template |
| `geyser-rust` | Rust | Geyser gRPC stream base template |
| `shreds-ts` | TypeScript | Shreds stream base template |
| `shreds-rust` | Rust | Shreds stream base template |
| `shreds-udp-rust` | Rust | Shreds UDP stream base template |
| `trade-app` | Rust | **PumpSwap auto-trading bot** (full lifecycle) |

### Trade App (`trade-app`)

PumpSwap (Pump.fun AMM) new pool detection and auto-trading bot.

**Lifecycle**: Pool detected → Buy → TX confirm → Sell monitor → Sell → Drain → ATA close → Profit notification

**Required env vars** (`.env`):
- `GRPC_ENDPOINT` — Geyser gRPC endpoint
- `SOLANA_RPC_ENDPOINT` — Solana RPC (reads)
- `SOLANA_SEND_RPC_ENDPOINT` — Solana RPC (TX send, separate recommended)

**Optional**:
- `WEBHOOK_URL` — Discord notifications
- `REDIS_URL` — Trade history persistence
- `API_TOKEN` — API authentication

**Trade config** (`PUT /api/config`):

| Field | Default | Description |
|-------|---------|-------------|
| `buy_amount_lamports` | `100000` (0.0001 SOL) | Buy amount |
| `sell_multiplier` | `1.1` | Take profit multiplier |
| `slippage_bps` | `500` (5%) | Slippage tolerance |
| `max_positions` | `1` | Max concurrent positions |
| `min_pool_sol_lamports` | `100000` | Min pool liquidity to buy |
| `sell_timeout_secs` | `300` (5 min) | Force retreat after timeout |
| `exit_pool_sol_lamports` | `1000000` (0.001 SOL) | Retreat on liquidity collapse |

**Setup**:
```bash
slv bot init          # → select "trade-app"
cd ~/slv/<app-name>
cp .env.sample .env   # → configure env vars
cargo build --release
./target/release/trade-app
# Fund wallet with at least 0.013 SOL
curl -X POST http://localhost:3000/api/trade/start
```

**API**: OpenAPI docs at `http://localhost:3000/docs`

**Discord notifications**: ✅ Buy Confirmed / 🟢🔴 Trade Complete / ⚠️ Retreat Burn

**Warning**: `wallet.json` contains your private key. Never commit it.

See `temp-release/trade-app/README.md` for full details.
