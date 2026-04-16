# SLV Bot — trade-app Skill

Reference material for the `trade-app` template. This skill is paired with
`slv-app` and always loaded together in the Setzer agent prompt. If you are
reading this as the main agent, treat this document as the authoritative
reference for the `trade-app` template and fall back to `slv-app` for
cross-template operations (inventory scan, wallet preflight, MCP flow).

## trade-app Overview

The `trade-app` template is a Rust application for PumpSwap (Pump.fun AMM)
trading automation.

### Lifecycle
`pool detected -> buy -> tx confirm -> sell monitor -> sell -> burn if needed -> ATA close -> notify`

### Main features
- Real-time pool detection via Geyser gRPC
- Automatic buy on matching new pool
- Profit target selling with retry support
- Timeout-based forced retreat
- Liquidity collapse retreat
- Dust burn and ATA close for rent recovery
- Discord webhook notifications
- Redis-backed trade history
- REST API with OpenAPI docs at `/docs`

## Quick Start

### 1. Create the project
```bash
slv bot init -t trade-app -n solana-trade-bot
```
Options: `-t` template type, `-n` app name. **Do NOT pass `-y`** unless the
directory does not exist — see `slv-app` Wallet Preflight for the full rule.

### 2. Configure environment
```bash
cd ~/slv/solana-trade-bot
cp .env.sample .env
# Edit .env — set at minimum: GRPC_ENDPOINT (leave optional fields blank unless needed)
```

### 3. Build
macOS:
```bash
brew install llvm   # if not already installed
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/opt/llvm/lib cargo build -r
```
Linux:
```bash
cargo build -r
```

### 4. Run (background, with PID file and bounded readiness check)
```bash
cd ~/slv/solana-trade-bot
mkdir -p .slv
RUST_LOG=info nohup ./target/release/trade-app > trade-app.log 2>&1 & echo $! > .slv/trade-app.pid
for i in 1 2 3 4 5; do
  curl -fsS http://localhost:3000/api/wallet && break
  sleep 1
done
```
- Save the PID to `.slv/trade-app.pid` so the process can be stopped cleanly
- If readiness fails, inspect `trade-app.log` instead of waiting forever
- `wallet.json` is auto-generated on first start
- API docs: `http://localhost:3000/docs`
- **NEVER run with `run_command` directly** or in a way that waits on the
  backgrounded process forever

### 5. Fund wallet and start trading
```bash
# Check wallet pubkey
curl -s http://localhost:3000/api/wallet
# Send SOL to the wallet pubkey (min 0.013 SOL)
# Then start trading:
curl -X POST http://localhost:3000/api/trade/start
# Check status:
curl -s http://localhost:3000/api/trade/status
```

### Stop the bot
Preferred:
```bash
cd ~/slv/solana-trade-bot
kill "$(cat .slv/trade-app.pid)" && rm -f .slv/trade-app.pid
```
Fallback:
```bash
pkill -f trade-app
```

### 6. Deploy to VPS
```bash
slv bot deploy
```
Builds, uploads via SCP, creates systemd service on the remote server.

## Environment Variables (`.env`)

### Required
| Variable | Description |
|----------|-------------|
| `GRPC_ENDPOINT` | Geyser gRPC endpoint |

### Optional
| Variable | Default | Description |
|----------|---------|-------------|
| `X_TOKEN` | — | Optional gRPC auth token, only needed when the endpoint requires it |
| `SOLANA_RPC_ENDPOINT` | `https://edge.erpc.global?api-key=<API_KEY>` | RPC for reads. Reuse the API key from `~/.slv/api.yml` automatically when available |
| `SOLANA_SEND_RPC_ENDPOINT` | same as read RPC | RPC for sending TXs. Reuse the same ERPC endpoint automatically when available |
| `API_PORT` | `3000` | HTTP API port |
| `API_TOKEN` | — | Bearer token for API auth |
| `WEBHOOK_URL` | — | Discord Webhook URL. If `notifications.discord_webhook` exists in `~/.slv/api.yml`, reuse it automatically |
| `REDIS_URL` | — | Redis URL for trade history. For non-engineer users, prefer installing Redis locally and configuring this automatically instead of asking up front |
| `CONFIG_PATH` | `config.jsonc` | Geyser filter config file |

When setting up `.env`, prefer automatic configuration over user questions
whenever possible. Reuse existing local configuration automatically when
available: the SLV API key from `~/.slv/api.yml` for
`https://edge.erpc.global?api-key=<API_KEY>` RPC defaults, and
`notifications.discord_webhook` from `~/.slv/api.yml` for `WEBHOOK_URL`. For
non-engineer users, prefer installing and wiring Redis automatically when
local persistence is useful.

## Trade Configuration (via API)

`GET /api/config` to read, `PUT /api/config` to update.

| Field | Default | Description |
|-------|---------|-------------|
| `buy_amount_lamports` | `100000` (0.0001 SOL) | Amount to spend per buy |
| `sell_multiplier` | `1.1` | Take profit at buy_price x this |
| `slippage_bps` | `500` (5%) | Slippage tolerance |
| `max_positions` | `1` | Max concurrent positions |
| `min_pool_sol_lamports` | `100000` (0.0001 SOL) | Min pool liquidity to trigger buy |
| `sell_timeout_secs` | `300` (5 min) | Force exit after timeout |
| `exit_pool_sol_lamports` | `1000000` (0.001 SOL) | Retreat if pool WSOL drops below |

## REST API

Base URL: `http://localhost:3000` | OpenAPI docs: `http://localhost:3000/docs`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get current trade config |
| `PUT` | `/api/config` | Partial update trade config |
| `POST` | `/api/trade/start` | Start trading |
| `POST` | `/api/trade/stop` | Stop trading |
| `GET` | `/api/trade/status` | Running state, positions, balance |
| `GET` | `/api/wallet` | Wallet pubkey and SOL balance |
| `GET` | `/api/logs` | Trade logs |
| `GET` | `/api/trades/history` | Trade history from Redis |
| `GET` | `/api/trades/{id}` | Single trade by ID |
| `GET` | `/api/trades/profit` | Buy-Sell pair P&L summary |
| `POST` | `/api/grpc/start` | Start gRPC stream |
| `POST` | `/api/grpc/stop` | Stop gRPC stream |

## Common Build Issues

### macOS: `libclang.dylib` not found
```
error: failed to run custom build command for `librocksdb-sys`
dyld: Library not loaded: @rpath/libclang.dylib
```
**Fix:**
```bash
brew install llvm
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/opt/llvm/lib cargo build -r
```

## Runtime Facts

- **Binary path**: `target/release/trade-app`
- **Default port**: `3000`
- **PID file**: `.slv/trade-app.pid`
- **Log file**: `trade-app.log`
- **Generated on first start**: `wallet.json` (private key — handle with care)
- **Discord notification marker**: `.discord-init-notified` (preserved across re-inits)

For wallet safety, inventory scan, MCP endpoint acquisition, and generic
per-app operations (start / stop / restart / modify config / delete) see the
`slv-app` skill — those procedures apply to every template including
`trade-app`.
