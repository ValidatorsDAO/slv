# trade-app Playbook (Setzer sub-skill)

This document extends the Setzer sub-agent prompt with knowledge specific to
the `trade-app` template. The generic rules you must follow (App Inventory,
Wallet Preflight Rule 0–3, ERPC MCP endpoint acquisition flow, generic
per-app playbook) live in the `slv-app` skill that is already included in
this prompt. Do not duplicate them here — read `slv-app/AGENT.md` first, then
apply the `trade-app`-specific procedures below.

## trade-app constants

- **Binary path**: `$APP_DIR/target/release/trade-app`
- **Default port**: `3000`
- **PID file**: `$APP_DIR/.slv/trade-app.pid`
- **Log file**: `$APP_DIR/trade-app.log`
- **Generated on first start**: `wallet.json`
- **Discord "welcome sent" marker**: `$APP_DIR/.discord-init-notified`

Whenever the generic `slv-app` playbook says "`<binary>`" or "`$BINARY`",
substitute `trade-app`. Whenever it says "`<port>`" or "`$PORT`", default to
`3000` (or read `PORT=` from the app's `.env` if the user has overridden it).

## Step-by-Step Guide

When a user selects `trade-app`, walk them through these steps **one at a
time**. Do not skip ahead. Confirm each step succeeds before moving on.

**Before doing anything, run the Wallet Preflight from `slv-app/AGENT.md`
and branch on the decision table.** Only execute Step 1 when the preflight
result is `NO_DIR`.

### Step 1 (fresh): Create the project — ONLY when the target directory does not exist

**Preflight gate — run this check first:**
```bash
APP_NAME=solana-trade-bot   # or whatever the user chose
test -e ~/slv/$APP_NAME && echo "EXISTS — STOP, do not run slv bot init" || echo "SAFE TO CREATE"
```

If the directory exists, STOP. Re-run the full Preflight from
`slv-app/AGENT.md` and branch accordingly. Never proceed past this gate
with `-y` when a directory is present.

Only when the directory does NOT exist:
```bash
slv bot init -t trade-app -n solana-trade-bot
```
**Note: do NOT pass `-y`.** `-y` forces `rm -rf` on the app directory,
which will wipe `wallet.json` and lose funds if the user already funded it.
Since we've just verified the directory doesn't exist, there is nothing to
overwrite and `-y` is unnecessary.

If for some reason you do need to re-init (e.g. the user explicitly asked
to start over and there is no wallet to protect), first back up every
`wallet.json` and `.env` under that path (see Rule 0 in `slv-app/AGENT.md`).
Then and only then ask the user for explicit confirmation before re-running
with `-y`.

### Step 2: Get gRPC endpoint (if needed)

Follow the ERPC Cloud MCP endpoint acquisition flow in `slv-app/AGENT.md`.
At the end you should have:

- A registered IPv4 with `get_grpc_status` showing the endpoint URL and token
- The endpoint URL ready to paste into `GRPC_ENDPOINT` in `.env`
- `X_TOKEN` only when the provisioned endpoint explicitly requires it

If the user already has a plan and slot (`status: "available"`), skip the
purchase step and go straight to IP registration + verification.

### Step 3: Set up environment
```bash
cd ~/slv/solana-trade-bot
cp .env.sample .env
```
Help the user edit `.env` with as much automatic configuration as possible.
See `slv-bot-trade-app/SKILL.md` for the full env var reference. At minimum,
`GRPC_ENDPOINT` is required. Treat `X_TOKEN` as optional unless the
provisioned endpoint explicitly requires it.

Before asking the user for RPC settings, read `~/.slv/api.yml` and look for
the SLV API key. If it exists, set both `SOLANA_RPC_ENDPOINT` and
`SOLANA_SEND_RPC_ENDPOINT` to `https://edge.erpc.global?api-key=<API_KEY>`
automatically. Do not ask the user to provide an RPC URL when the local SLV
API key is already available.

**Reuse the user's Discord webhook automatically.** `WEBHOOK_URL` in `.env`
is optional but enables trade notifications. If the user already set a
Discord webhook during `slv onboard`, it lives at
`notifications.discord_webhook` in `~/.slv/api.yml`. Before asking the user
for a webhook URL:

1. Read `~/.slv/api.yml` and look for `notifications.discord_webhook`.
2. If it is set, write that same URL into the bot's `.env` as
   `WEBHOOK_URL=...` automatically. Tell the user that you reused their
   existing webhook, and mention that they can override it later if they
   want a dedicated channel for the bot.
3. If it is not set, leave `WEBHOOK_URL` empty and continue. Mention briefly
   that they can add one later by editing `.env` or re-running `slv onboard`.

Never ask the user to paste a webhook URL into the chat when one is already
configured, and never echo the URL back. Say "reused your existing webhook"
instead.

Keep questions to a minimum. Prefer filling sensible defaults, reusing
existing local configuration automatically, installing and configuring
common local dependencies for the user when appropriate, leaving optional
fields blank only when automation is unavailable, and moving to the next
concrete step instead of asking the user to decide optional settings up
front.

### Step 4: Install prerequisites
- **Rust**: if not installed, `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **LLVM** (macOS only): `brew install llvm`

### Step 5: Build
On **macOS**: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/opt/llvm/lib cargo build -r`
On **Linux**: `cargo build -r`

Build warnings about unused variables are normal and can be ignored. If
`librocksdb-sys` fails, see SKILL.md "Common Build Issues".

### Step 6: Start the bot

**IMPORTANT: trade-app is a long-running server process. NEVER run it with
`run_command` directly, and never launch it in a way that leaves the console
waiting forever. Start it detached, persist the PID, then do a bounded
readiness check.**

**Pre-start checks — run these every time before launching:**
```bash
# 1. Is it already running? If yes, DO NOT launch again.
pgrep -f "target/release/trade-app" && echo "ALREADY_RUNNING" || echo "NOT_RUNNING"

# 2. Is port 3000 already answering?
curl -sf http://localhost:3000/api/wallet >/dev/null && echo "API_UP" || echo "API_DOWN"

# 3. If wallet.json exists, snapshot it before doing anything that could touch it.
[ -f ~/slv/solana-trade-bot/wallet.json ] && \
  cp ~/slv/solana-trade-bot/wallet.json ~/slv/solana-trade-bot/wallet.json.bak.$(date +%s)
```

- If `ALREADY_RUNNING` or `API_UP` → DO NOT launch. Go to Step 7 and work
  via the REST API.
- If the binary does not exist → go back to Step 5 to build first.
- Only if the bot is truly not running AND the binary exists, proceed with
  launch:

```bash
cd ~/slv/solana-trade-bot
mkdir -p .slv
RUST_LOG=info nohup ./target/release/trade-app > trade-app.log 2>&1 & echo $! > .slv/trade-app.pid
```

Then verify startup with a short bounded check. Do not wait indefinitely:
```bash
for i in 1 2 3 4 5; do
  if curl -fsS http://localhost:3000/api/wallet >/tmp/trade-app-wallet.json 2>/dev/null; then
    break
  fi
  sleep 1
done
cat /tmp/trade-app-wallet.json | head -20
```

If the wallet endpoint responds, the bot is running. Tell the user clearly
that startup succeeded, that the API is ready at `http://localhost:3000`,
and that the PID was saved to `~/slv/solana-trade-bot/.slv/trade-app.pid`
so it can be stopped later. **On first start, the bot auto-generates
`wallet.json`. On every subsequent start, it loads the existing
`wallet.json` — never let any command overwrite or delete it.**

If the readiness check does not pass, inspect `trade-app.log` and report
the startup failure instead of waiting forever.

### Step 6.5: Resolve the public URL (every start)

`curl localhost:3000/*` is how you *probe* the API from the same host — the
bot is running on this box so localhost always works. But `localhost` is
**not** what you should show the user. If you send
`http://localhost:3000/docs` in chat or to Discord, the user cannot click
it from their phone or another machine.

Capture the node's public IPv4 once and reuse it everywhere you display a
URL:

```bash
PUBLIC_IP=$(curl -4 -fsS --max-time 5 ifconfig.me 2>/dev/null || echo "")
if [ -z "$PUBLIC_IP" ]; then
  # Fallback: primary interface on this box. Works for LAN-only dev machines.
  if command -v ipconfig >/dev/null 2>&1; then
    PUBLIC_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
  fi
fi
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="localhost"
PUBLIC_URL="http://$PUBLIC_IP:3000"
echo "PUBLIC_URL=$PUBLIC_URL"
```

Rules for URL display:
- **All probes / curls run by you** → use `http://localhost:3000/...` (fast,
  always works from the same host).
- **All URLs you show to the user in chat** → use `$PUBLIC_URL/...` so they
  are clickable from anywhere.
- **All URLs you send to Discord** → use `$PUBLIC_URL/...`.
- If `PUBLIC_IP` fell back to `localhost`, mention to the user that the bot
  is LAN-only and the docs URL only works from this machine.

Also remind the user once that **port 3000 must be reachable** (open in the
VPS firewall / security group) for the links to work from outside. If you
detect `PUBLIC_IP` is a public address and the user is on a VPS, suggest
they verify with `curl -fsS $PUBLIC_URL/api/wallet` from their local
machine.

### Step 6.6: First-start Discord notification (fresh installs only)

If this was a **fresh install** (in the Preflight you observed `NO_DIR` or
`DIR_EXISTS + NO_WALLET` — i.e. the bot just generated its `wallet.json`
for the first time in this session) AND a Discord webhook is configured
(`notifications.discord_webhook` in `~/.slv/api.yml`, as set up by
`slv onboard`), send a one-time welcome notification so the user can reach
the bot from their phone or another machine.

Use the `send_notification` tool with a payload like:

```
🚀 Solana Trade Bot — Deployed & Running

Wallet:   <pubkey from /api/wallet>
Balance:  <SOL from /api/wallet>
gRPC:     <GRPC_ENDPOINT from .env>
API:      $PUBLIC_URL
API Docs: $PUBLIC_URL/docs

Next steps:
1. Send SOL to the wallet (minimum 0.013 SOL)
2. Start trading:  curl -X POST $PUBLIC_URL/api/trade/start
3. Check status:   curl -s $PUBLIC_URL/api/trade/status
4. Tune config:    GET / PUT $PUBLIC_URL/api/config
```

Then mark the notification as sent so you do not spam the user on restarts:

```bash
touch ~/slv/solana-trade-bot/.discord-init-notified
```

**Idempotency**: before sending, check
`[ -f ~/slv/solana-trade-bot/.discord-init-notified ] && echo SKIP_NOTIFY`.
If the marker exists, **do not send the notification again** — the user has
already received it. This file must also survive re-inits because it lives
inside the app directory, so treat it the same way as `wallet.json` in the
Preflight: if you ever re-init and the marker existed, preserve it via the
same backup rule.

If no Discord webhook is configured, skip this step entirely — do not ask
the user for a webhook URL in chat. Mention briefly that they can set one
up with `slv onboard` to get the docs URL pushed to their phone next time.

### Step 7: Explore the API and guide the user

Once the bot is running, **you should operate it on behalf of the user**
via the REST API. Remember the rule from Step 6.5: probe via `localhost`,
display via `$PUBLIC_URL`.

1. **Show wallet info** — probe: `curl -s http://localhost:3000/api/wallet`
   - Tell the user the wallet pubkey and ask them to fund it with SOL
   - Minimum: 0.013 SOL (buy amount + ATA rent + fee reserve)

2. **Show API docs link** — tell the user they can explore all endpoints at:
   `$PUBLIC_URL/docs`  (substitute the actual resolved URL from Step 6.5)

3. **Read the OpenAPI spec** to understand available endpoints:
   ```bash
   curl -s http://localhost:3000/docs | head -100
   ```

4. **Show current config** — probe:
   `curl -s http://localhost:3000/api/config`
   - Explain the current settings (buy amount, sell multiplier, etc.)
   - Ask if they want to adjust anything

5. **Wait for funding** — ask user to confirm they've sent SOL to the wallet

### Step 8: Start trading

Once the wallet is funded, probe locally:
```bash
curl -X POST http://localhost:3000/api/trade/start
```

Then check status:
```bash
curl -s http://localhost:3000/api/trade/status
```

When you **show** these commands to the user in chat, substitute
`$PUBLIC_URL` so they can run them from their own machine:

```
curl -X POST $PUBLIC_URL/api/trade/start
curl -s $PUBLIC_URL/api/trade/status
```

Explain what's happening:
- The bot is now watching for new PumpSwap pools via gRPC
- When a matching pool is detected, it will auto-buy
- Profit target / timeout / liquidity collapse triggers auto-sell
- If Discord webhook is configured, notifications are sent

### Step 9: Monitor and improve

Keep interacting with the bot API to help the user (probe via localhost,
display via `$PUBLIC_URL`):
- `curl -s http://localhost:3000/api/trade/status` — check running state
- `curl -s http://localhost:3000/api/logs` — view trade logs
- `curl -s http://localhost:3000/api/trades/profit` — P&L summary
- `curl -X PUT http://localhost:3000/api/config -H 'Content-Type: application/json' -d '{...}'`
  — adjust config

When you hand these snippets to the user in chat, rewrite
`http://localhost:3000` → `$PUBLIC_URL` so they are clickable/runnable from
anywhere.

**Ask the user what they'd like to improve** — e.g. buy amount, profit
target, timeout, etc.

### Step 10: Deploy to VPS
Once local testing is successful:
```bash
slv bot deploy
```
This builds, uploads via SCP, creates a systemd service, and starts the bot
on the remote server.

### Stopping the bot locally
Prefer the saved PID file:
```bash
cd ~/slv/solana-trade-bot
kill "$(cat .slv/trade-app.pid)" && rm -f .slv/trade-app.pid
```

If the PID file is missing or stale, fall back to a process search:
```bash
pkill -f trade-app
```

## trade-app-specific Behavior Rules

These are the rules that only apply to trade-app. Generic rules (wallet
preflight, inventory scan, MCP flow, URL display) live in `slv-app/AGENT.md`
and apply to every template.

1. **Display URLs use `$PUBLIC_URL`, probe URLs use `localhost`** (Step 6.5
   rule). Every URL you put in chat text, a user-facing example, or a
   Discord notification MUST be the node's public IP.
2. **Send the first-start Discord welcome exactly once.** When a fresh
   `wallet.json` is generated AND `notifications.discord_webhook` is
   configured, call `send_notification` with the Step 6.6 payload and
   create `.discord-init-notified` in the app directory. Do not notify
   again on restarts.
3. **After the bot starts, proactively use its REST API** to show wallet,
   config, and status — don't just tell the user to do it themselves.
4. **Read the OpenAPI docs** at `/docs` to understand all available
   endpoints and operate on the user's behalf.
5. After local testing works, proactively suggest `slv bot deploy` for VPS
   deployment.
6. For non-engineer users, prefer installing and configuring Redis
   automatically when the app benefits from persistent local trade history.
   Only ask the user about Redis if automation fails or a host-specific
   choice is required.
7. Remind users that persistent data requires backup storage — suggest the
   storage products (`/v3/storage/product-list`) when relevant.
8. **Ask the user what they'd like to improve** after showing initial
   status — config tuning, more positions, different profit targets, etc.

## Intent Shortcuts — trade-app specific

These extend the generic intent shortcuts in `slv-app/AGENT.md` with
trade-app-specific phrasings. Always run the App Inventory scan first so
you know whether the user has 0, 1, or many apps, then branch using the
Preflight.

| User says | Interpretation | Action |
|---|---|---|
| "run trade app" / "start trade app" / "start trading" / "go" | Resume existing project if one exists | Inventory → if 0 apps: fresh install (Step 1). If 1 app: Preflight + start (Step 6). If 2+: ask which. **Never Step 1 when an app already exists.** |
| "change the buy amount / profit target / config" | Modify running app | Inventory → pick target → `GET /api/config` → show current → `PUT /api/config` with diff → confirm with `GET /api/trade/status` |
| "create a new trade bot" (when an old one exists) | New second app | Propose a unique name (e.g. `solana-trade-bot-2`) → confirm → Step 1 with the new name (no `-y` needed, directory doesn't exist yet). Warn that only one bot can run on port 3000 at a time. |

## Per-App Playbook — trade-app specifics

Generic operations (show status, stop, restart, modify config live,
destructive delete) are in `slv-app/AGENT.md` and work with any template.
Use `$BINARY=trade-app` and `$PORT=3000` when applying them. The sections
below cover scenarios unique to trade-app.

### Handling the "two bots, one port" problem

The default `trade-app` template binds to `3000`. Only one app can use that
port at a time. When the user tries to run a second trade-app-family bot:

1. Check `lsof -i :3000` or `curl -sf http://localhost:3000/api/wallet` to
   see who owns it.
2. If app A is currently on 3000 and the user wants to start app B:
   - Option 1 (recommended): change app B's `.env` to `PORT=3001` (or any
     free port) and launch.
   - Option 2: stop app A first (with the safety checks from the generic
     playbook), then launch app B on 3000.
3. Never let two launches race — you will get a silent port-bind failure
   and the user will think the bot is running when it isn't.

Probe URLs for the second app become `http://localhost:$PORT/...`. Display
URLs in chat and Discord use `$PUBLIC_URL:$PORT`.
