#!/usr/bin/env bash
# bench-of1-extended.sh — full-coverage benchmark for the rolling-cache RPC.
# Discovers a real signature in each tested epoch by calling the endpoint
# itself (requires the epoch to be reachable, even via proxy fallback) so the
# benchmark always operates on real data.
#
# Coverage:
#   • All cached epochs in the rolling window
#   • One epoch outside the window (proxied baseline)
#   • One very-old epoch (proxied baseline)
# Methods per epoch: getBlockTime, getBlock(none|sigs), getTransaction,
# getSignaturesForAddress.
#
# Usage:
#   ./bench-of1-extended.sh <endpoint> <iters> <output.json> [epoch1,epoch2,...]
set -euo pipefail

ENDPOINT="${1:-http://localhost:8888}"
ITERS="${2:-10}"
OUT="${3:-bench-results/of1-extended-$(date +%Y%m%d-%H%M%S).json}"
EPOCHS_CSV="${4:-937,945,955,965,966,899,936,600}"

mkdir -p "$(dirname "$OUT")"

# A high-traffic mainnet account that has signatures across many epochs.
# Token Program is a safe choice — used by virtually every tx.
PROBE_ACCOUNT="${PROBE_ACCOUNT:-TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA}"

# Use Python for the heavy lifting (discovery + timing + reporting).
python3 - "$ENDPOINT" "$ITERS" "$OUT" "$EPOCHS_CSV" "$PROBE_ACCOUNT" <<'PY'
import json, sys, time, statistics, urllib.request, urllib.error, os

endpoint, iters_str, out_path, epochs_csv, probe_account = sys.argv[1:6]
iters = int(iters_str)
test_epochs = [int(e) for e in epochs_csv.split(",") if e.strip()]
SLOTS_PER_EPOCH = 432_000

def call(method, params, timeout=120):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except Exception as e:  # noqa: BLE001
        return time.perf_counter() - t0, None, f"exc:{type(e).__name__}"
    elapsed = time.perf_counter() - t0
    try:
        b = json.loads(raw)
    except json.JSONDecodeError:
        return elapsed, None, "non-json"
    if "error" in b:
        return elapsed, b, "error:" + (b["error"].get("message") or "")[:80]
    if b.get("result") is None:
        return elapsed, b, "null-result"
    return elapsed, b, "ok"

def discover(epoch):
    """Return a (slot, sig) pair within the epoch by walking outward from a
    midpoint slot until a populated block is found.  Bails out after 20 tries."""
    for offset in range(0, 20):
        slot = epoch * SLOTS_PER_EPOCH + 100_000 + offset * 1000
        _, body, status = call(
            "getBlock",
            [slot, {"encoding": "json", "transactionDetails": "signatures",
                    "rewards": False, "maxSupportedTransactionVersion": 0}],
            timeout=120,
        )
        if status != "ok":
            continue
        sigs = body.get("result", {}).get("signatures") or []
        if sigs:
            return slot, sigs[0]
    return None, None

print(f"=== of1 extended bench: {endpoint}  iters={iters} ===")
print(f"epochs to test: {test_epochs}\n")

# Phase 1: discovery
print("--- discovery (looking for one real slot+sig per epoch) ---")
discoveries = {}
for ep in test_epochs:
    slot, sig = discover(ep)
    if slot is None:
        print(f"  epoch {ep}: NO populated block found; will skip getTransaction")
    else:
        print(f"  epoch {ep}: slot={slot} sig={sig[:24]}...")
    discoveries[ep] = (slot, sig)

# Phase 2: bench cases
cases = [
    {"label": "getVersion (control)", "epoch": None, "method": "getVersion", "params": []},
]
for ep in test_epochs:
    slot, sig = discoveries[ep]
    if slot is None:
        continue
    cases += [
        {"label": f"getBlockTime    epoch {ep}", "epoch": ep, "method": "getBlockTime",
         "params": [slot]},
        {"label": f"getBlock(none)  epoch {ep}", "epoch": ep, "method": "getBlock",
         "params": [slot, {"encoding": "json", "transactionDetails": "none",
                           "rewards": False, "maxSupportedTransactionVersion": 0}]},
        {"label": f"getBlock(sigs)  epoch {ep}", "epoch": ep, "method": "getBlock",
         "params": [slot, {"encoding": "json", "transactionDetails": "signatures",
                           "rewards": False, "maxSupportedTransactionVersion": 0}]},
        {"label": f"getTransaction  epoch {ep}", "epoch": ep, "method": "getTransaction",
         "params": [sig, {"encoding": "json", "maxSupportedTransactionVersion": 0}]},
        {"label": f"getSigsForAddr  epoch {ep}", "epoch": ep, "method": "getSignaturesForAddress",
         "params": [probe_account, {"limit": 5, "minContextSlot": slot, "before": sig}]},
    ]

# Warm-up: prime each cache by calling each case once before timing.
print("\n--- warm-up pass (1 call/case) ---")
for c in cases:
    call(c["method"], c["params"], timeout=120)
print("warm-up done")

# Phase 3: measured runs
print(f"\n--- measured ({iters} iters/case) ---")
results = []
for c in cases:
    times, statuses, err = [], [], None
    for _ in range(iters):
        e, _, s = call(c["method"], c["params"], timeout=120)
        times.append(e)
        statuses.append(s)
        if not s.startswith("ok") and err is None:
            err = s
    times_s = sorted(times)
    p50 = statistics.median(times_s)
    p95 = times_s[int(0.95 * (len(times_s) - 1))]
    mean = statistics.fmean(times_s)
    ok = sum(1 for s in statuses if s == "ok")
    nul = sum(1 for s in statuses if s == "null-result")
    er = sum(1 for s in statuses if not (s == "ok" or s == "null-result"))
    status_str = f"ok={ok:>2d}" + (f" null={nul}" if nul else "") + (f" err={er}" if er else "")
    suffix = f"   [{err[:60]}]" if err and not err.startswith("ok") else ""
    print(
        f"{c['label']:<60s} {status_str:<18s} mean={mean*1000:7.0f}ms  "
        f"p50={p50*1000:7.0f}ms  p95={p95*1000:7.0f}ms{suffix}"
    )
    results.append({
        "label": c["label"], "epoch": c["epoch"], "method": c["method"], "iters": iters,
        "mean_ms": round(mean * 1000, 1),
        "p50_ms":  round(p50 * 1000, 1),
        "p95_ms":  round(p95 * 1000, 1),
        "ok_count": ok, "null_count": nul, "err_count": er,
        "first_error": err,
        "times_ms": [round(t * 1000, 1) for t in times],
    })

with open(out_path, "w") as f:
    json.dump({
        "endpoint": endpoint,
        "iters": iters,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "phase": "extended",
        "probe_account": probe_account,
        "discoveries": {str(k): {"slot": v[0], "sig": v[1]} for k, v in discoveries.items()},
        "results": results,
    }, f, indent=2)
print(f"\nSaved: {out_path}")
PY
