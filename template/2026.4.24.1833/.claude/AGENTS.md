# Claude Agent Instructions — SLV Ansible Templates

## ⚠️ SECURITY — PUBLIC OSS REPOSITORY
- **NEVER commit secrets, API keys, tokens, passwords, or private IPs**
- Review every diff before committing

## Project
SLV (Solana Validator Launcher) Ansible playbooks. OSS: https://github.com/ValidatorsDAO/slv

## Structure
- `ansible/cmn/` — Shared tasks
- `ansible/mainnet-rpc/` — Mainnet RPC (Index + gRPC Geyser)
- `ansible/mainnet-validator/` — Mainnet Validators
- `ansible/testnet-*` / `ansible/devnet-*` — Other networks
- `jinja/` — Jinja2 config templates

## Key Variables
- `validator_type`: agave | jito | firedancer-agave | firedancer-jito | frankendancer
- `rpc_type`: "Index RPC" | "Geyser gRPC" | "Index RPC + gRPC"
- All passed as `extra_vars` at runtime

## Agents
- **Cecil**: Validator specialist (mainnet-validator/, testnet-validator/)
- **Tina**: RPC specialist (mainnet-rpc/, testnet-rpc/, devnet-rpc/)
- **Cloud**: gRPC Geyser specialist (geyser files in rpc dirs)

## Conventions
- `init.yml` = full node initialization from bare metal
- `build_solana.yml` preferred over `install_solana.yml`
- Ansible user: `solv`
