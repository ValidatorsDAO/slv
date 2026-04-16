# SLV Bot — trade-app skill

Template-specific skill for the `slv bot init -t trade-app` PumpSwap
auto-trading bot. Extends `slv-app` with:

- 10-step setup guide (init → env → build → run → trade → deploy)
- Environment variable reference
- REST API endpoint reference
- Common build issues (e.g. macOS `libclang.dylib`)
- Per-app playbook tuned to `trade-app` (port 3000, `target/release/trade-app`)

This skill is always loaded alongside `slv-app` for the Setzer agent.
Install via:

```
slv skills sync
```
