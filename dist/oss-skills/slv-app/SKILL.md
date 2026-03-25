# SLV App Skill

Templates and tools for creating Solana trade bot applications.

## App Types
| Type | Description |
|---|---|
| Solana Stream Client | Real-time Solana data streaming (gRPC Geyser) |
| Trade Bot | Automated trading bot with strategy framework |

## Quick Start
1. `slv bot init` — Creates a new project from template
2. Configure `.env` with RPC endpoint and keypair
3. `deno task dev` — Run locally
4. Deploy to server with `slv app deploy`

## CLI Command → Action Mapping
| CLI | Action |
|---|---|
| `slv bot init` | Scaffold new bot project |
| `slv bot` / `slv b` | Bot management menu |
| `slv app` | App management |

## Template Structure
The generated project includes:
- Deno runtime configuration
- gRPC Geyser streaming client
- Transaction builder utilities
- Strategy framework
- Environment configuration (.env)
