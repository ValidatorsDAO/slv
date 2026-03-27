# SLV Benchmark Skill

Benchmark and connectivity workflows for SLV.

## Supported benchmark types

- `shredstream`
- `grpc`
- `rpc`

## Input collection order

For benchmark requests, collect inputs in this order:
1. benchmark type
2. region
3. endpoint URLs

Region should be collected before execution because `--region` gives more accurate measurements for feed comparison.

## `geyserbench` config generation

Use:
- `~/.slv/api.yml` for the ERPC API key when available
- `https://edge.erpc.global` as `erpc_url`
- two endpoint URLs for side-by-side comparison

Example config:

```toml
[config]
region = "frankfurt"
erpc_url = "https://edge.erpc.global"
erpc_api_key = "api-key"
transactions = 10000
account = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
commitment = "processed"

[[endpoint]]
name = "http://endpoint-1"
url = "http://endpoint-1"
kind = "shredstream"

[[endpoint]]
name = "http://endpoint-2"
url = "http://endpoint-2"
kind = "shredstream"
```

## Planned CLI shape

A natural future command shape is:

```bash
slv check geyserbench <options>
```

This should mirror the current `slv check grpc` / `slv check shreds` style by passing arguments through to the installed benchmark binary.

## API key handling

If `~/.slv/api.yml` does not contain the required ERPC API key, instruct the user to get a free API key and configure it first.
