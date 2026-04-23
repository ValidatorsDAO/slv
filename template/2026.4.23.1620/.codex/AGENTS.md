# Codex Agent Instructions — SLV Ansible Templates

## ⚠️ SECURITY — PUBLIC OSS REPOSITORY
- **NEVER commit secrets, API keys, tokens, passwords, or private IPs**
- Review every diff before committing

## Project
SLV Ansible playbooks for deploying Solana nodes (Validator, RPC, gRPC Geyser).

## Structure
- `ansible/cmn/` — Shared tasks
- `ansible/mainnet-rpc/` — Mainnet RPC (Index + gRPC)
- `ansible/mainnet-validator/` — Mainnet Validators
- `ansible/testnet-*` / `ansible/devnet-*` — Other networks
- `jinja/` — Jinja2 config templates

## Key Variables
- `validator_type`: agave | jito | firedancer-agave | firedancer-jito | frankendancer
- `rpc_type`: "Index RPC" | "Geyser gRPC" | "Index RPC + gRPC"
- All passed as `extra_vars` at runtime

## Conventions
- `init.yml` = full node initialization
- `build_solana.yml` preferred over `install_solana.yml`
- User: `solv`
