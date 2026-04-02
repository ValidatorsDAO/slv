# SLV Benchmark Skill

Benchmark and connectivity workflows for SLV using `slv check` commands.

## `slv check` subcommands

| Subcommand | Description | Options |
|---|---|---|
| `rpc` | RPC endpoint latency | `--endpoint <url>` |
| `grpc` | gRPC endpoint latency | `--endpoint <url> --token <token>` |
| `shreds` | ShredStream endpoint check | `--endpoint <url>` |
| `geyserbench` | Full benchmark (side-by-side comparison) | `--kind --region --endpoint (repeatable) --transactions` |
| `ip` | Show public IP | _(none)_ |

## Supported benchmark types (geyserbench)

- `shredstream`
- `grpc`
- `rpc`

## Input collection order (geyserbench)

1. benchmark type (`--kind`)
2. region (`--region`) — required for accurate measurement
3. endpoint URLs (`--endpoint`, at least 2)
4. transactions (`--transactions`, default 10000)

## `geyserbench` config generation

`slv check geyserbench` auto-generates `~/.slv/check/geyserbench/config.toml` from the CLI options.

Under the hood it uses:
- `~/.slv/api.yml` for the ERPC API key
- `https://edge.erpc.global` as `erpc_url`
- Default account: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- Default commitment: `processed`

Example generated config:

```toml
[config]
region = "frankfurt"
erpc_url = "https://edge.erpc.global"
erpc_api_key = "api-key"
transactions = 10000
account = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
commitment = "processed"

[[endpoint]]
name = "http://shreds-fra6-1.erpc.global"
url = "http://shreds-fra6-1.erpc.global"
kind = "shredstream"

[[endpoint]]
name = "http://shreds-turbo-fra-1.erpc.global"
url = "http://shreds-turbo-fra-1.erpc.global"
kind = "shredstream"
```

## API key handling

If `~/.slv/api.yml` does not contain the required ERPC API key, instruct the user to get a free API key and configure it first.

## Binary installation

Benchmark binaries (`grpc_test`, `geyserbench`, `shreds_test`) are installed to `~/.slv/bin/` by `slv install` (or `curl -fsSL https://storage.slv.dev/slv/install | sh`).

The install script uses `If-Modified-Since` headers so re-running only downloads when the remote binary has been updated.
