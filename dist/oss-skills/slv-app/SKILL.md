# SLV App Skill

Templates and tools for creating Solana bot and app projects.

## Available Template Types
| Type | Description |
|---|---|
| Geyser Stream Client | Real-time Solana data streaming via gRPC Geyser |
| Shreds Stream Client | Low-level shred stream templates |
| `trade-app` | Rust PumpSwap auto-trading bot with buy/sell/close lifecycle |

## trade-app Overview

The `trade-app` template is a Rust application for PumpSwap (Pump.fun AMM) trading automation.

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
- REST API with OpenAPI docs

## Quick Start
1. Run `slv bot init`
2. Select `trade-app`
3. `cp .env.sample .env`
4. Set `GRPC_ENDPOINT`, `SOLANA_RPC_ENDPOINT`, and `SOLANA_SEND_RPC_ENDPOINT`
5. Build and run the app
6. Fund the generated wallet
7. Start trading through the API

## trade-app Runtime Configuration

### Required env vars
- `GRPC_ENDPOINT`
- `SOLANA_RPC_ENDPOINT`

### Optional env vars
- `SOLANA_SEND_RPC_ENDPOINT`
- `X_TOKEN`
- `WEBHOOK_URL`
- `REDIS_URL`
- `API_TOKEN`
- `API_PORT`
- `CONFIG_PATH`

### Main API endpoints
- `GET /api/config`
- `PUT /api/config`
- `POST /api/trade/start`
- `POST /api/trade/stop`
- `GET /api/trade/status`
- `GET /api/logs`
- `GET /api/wallet`
- `POST /api/grpc/start`
- `POST /api/grpc/stop`
- `GET /api/trades/history`
- `GET /api/trades/{id}`
- `GET /api/trades/profit`

### Main trade config fields
- `buy_amount_lamports`
- `sell_multiplier`
- `slippage_bps`
- `max_positions`
- `min_pool_sol_lamports`
- `sell_timeout_secs`
- `exit_pool_sol_lamports`

## CLI Command → Action Mapping
| CLI | Action |
|---|---|
| `slv bot init` | Scaffold a bot/app project from template |
| `slv bot` / `slv b` | Bot management menu |
| `slv app` | App management |

## Operator Notes
- `wallet.json` contains a private key and must never be committed
- Keep examples OSS-safe: placeholders only, never real tokens or private endpoints
- For local API docs, use `http://localhost:3000/docs`
- Point users to the template README for full setup details
