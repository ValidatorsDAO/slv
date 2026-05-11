#!/usr/bin/env bash
# bench-of1.sh — measure faithful-cli RPC latency across configured /
# unconfigured epochs.  Designed to run before and after rolling-cache
# rollout so the diff is meaningful.
#
# Usage:
#   ./bench-of1.sh <endpoint> <iters> <output.json>
# Defaults:
#   endpoint = http://localhost:8888
#   iters    = 10
#   output   = bench-results/of1-$(date +%Y%m%d-%H%M%S).json
set -euo pipefail

ENDPOINT="${1:-http://localhost:8888}"
ITERS="${2:-10}"
OUT="${3:-bench-results/of1-$(date +%Y%m%d-%H%M%S).json}"

mkdir -p "$(dirname "$OUT")"

# ── Test data ────────────────────────────────────────────────────────────────
# Real slots / sigs discovered in epoch 899 (currently the only configured epoch).
# When this script is re-run after Phase 1, the same epoch 899 case stays
# available, and the epoch 966 / 950 cases switch from "proxied to mainnet-beta"
# to "served locally by faithful".
read -r -d '' CASES_JSON <<'JSON' || true
[
  {"label":"getVersion (control)",                                  "epoch":null,"method":"getVersion","params":[]},

  {"label":"getBlockTime    epoch 899 (faithful-local-config)",     "epoch":899,"method":"getBlockTime","params":[388569600]},
  {"label":"getBlock(sigs)  epoch 899 (faithful-local-config)",     "epoch":899,"method":"getBlock","params":[388569600,{"encoding":"json","transactionDetails":"signatures","rewards":false,"maxSupportedTransactionVersion":0}]},
  {"label":"getBlock(none)  epoch 899 (faithful-local-config)",     "epoch":899,"method":"getBlock","params":[388569600,{"encoding":"json","transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":0}]},
  {"label":"getTransaction  epoch 899 (faithful-local-config)",     "epoch":899,"method":"getTransaction","params":["2X5xmp62MJ6KHW6dafAtjFf6JHjqSvh91WifyFFbb6HuQ7e3LKs4riH8BsjpuDJnSvvjDQD3b6gCnaPq4Gmip8wh",{"encoding":"json","maxSupportedTransactionVersion":0}]},

  {"label":"getBlockTime    epoch 966 (unconfigured / proxied)",    "epoch":966,"method":"getBlockTime","params":[417412000]},
  {"label":"getBlock(sigs)  epoch 966 (unconfigured / proxied)",    "epoch":966,"method":"getBlock","params":[417412000,{"encoding":"json","transactionDetails":"signatures","rewards":false,"maxSupportedTransactionVersion":0}]},
  {"label":"getBlock(none)  epoch 966 (unconfigured / proxied)",    "epoch":966,"method":"getBlock","params":[417412000,{"encoding":"json","transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":0}]},

  {"label":"getBlockTime    epoch 950 (unconfigured / proxied)",    "epoch":950,"method":"getBlockTime","params":[410500000]},
  {"label":"getBlock(sigs)  epoch 950 (unconfigured / proxied)",    "epoch":950,"method":"getBlock","params":[410500000,{"encoding":"json","transactionDetails":"signatures","rewards":false,"maxSupportedTransactionVersion":0}]},

  {"label":"getBlockTime    epoch 100 (very old / proxied)",        "epoch":100,"method":"getBlockTime","params":[43250000]},
  {"label":"getBlock(sigs)  epoch 100 (very old / proxied)",        "epoch":100,"method":"getBlock","params":[43250000,{"encoding":"json","transactionDetails":"signatures","rewards":false,"maxSupportedTransactionVersion":0}]}
]
JSON

# ── Bench engine ─────────────────────────────────────────────────────────────
bench_one() {
  python3 - "$ENDPOINT" "$ITERS" "$OUT" "$CASES_JSON" <<'PY'
import json, sys, time, statistics, urllib.request, urllib.error

endpoint, iters_str, out_path, cases_json = sys.argv[1:5]
iters = int(iters_str)
cases = json.loads(cases_json)

def call(method, params, timeout=60):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.URLError as e:
        return time.perf_counter() - t0, None, f"urlerror:{e}"
    except Exception as e:  # noqa: BLE001
        return time.perf_counter() - t0, None, f"exc:{e}"
    elapsed = time.perf_counter() - t0
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        return elapsed, None, "non-json"
    if "error" in body:
        return elapsed, body, "error:" + (body["error"].get("message") or "")[:80]
    if "result" not in body:
        return elapsed, body, "no-result"
    if body.get("result") is None:
        return elapsed, body, "null-result"
    return elapsed, body, "ok"

print(f"=== of1 benchmark: {endpoint}  iters={iters} ===\n", flush=True)

results = []
for c in cases:
    times = []
    statuses = []
    err_sample = None
    for i in range(iters):
        elapsed, body, status = call(c["method"], c["params"])
        times.append(elapsed)
        statuses.append(status)
        if not status.startswith("ok") and err_sample is None:
            err_sample = status
    times_sorted = sorted(times)
    p50 = statistics.median(times_sorted)
    p95 = times_sorted[int(0.95 * (len(times_sorted) - 1))]
    mean = statistics.fmean(times_sorted)
    ok_count = sum(1 for s in statuses if s == "ok")
    null_count = sum(1 for s in statuses if s == "null-result")
    err_count = sum(1 for s in statuses if s.startswith("error") or s == "no-result" or s.startswith("urlerror") or s.startswith("exc"))
    label = c["label"]
    status_str = f"ok={ok_count:>2d}"
    if null_count:
        status_str += f" null={null_count}"
    if err_count:
        status_str += f" err={err_count}"
    print(
        f"{label:<60s} {status_str:<18s} mean={mean*1000:7.0f}ms  "
        f"p50={p50*1000:7.0f}ms  p95={p95*1000:7.0f}ms",
        end="",
    )
    if err_sample and not err_sample.startswith("ok"):
        print(f"   [{err_sample[:60]}]")
    else:
        print()
    results.append({
        "label": label,
        "epoch": c["epoch"],
        "method": c["method"],
        "iters": iters,
        "mean_ms": round(mean * 1000, 1),
        "p50_ms": round(p50 * 1000, 1),
        "p95_ms": round(p95 * 1000, 1),
        "ok_count": ok_count,
        "null_count": null_count,
        "err_count": err_count,
        "first_error": err_sample,
        "times_ms": [round(t * 1000, 1) for t in times],
    })

with open(out_path, "w") as f:
    json.dump({
        "endpoint": endpoint,
        "iters": iters,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "results": results,
    }, f, indent=2)
print(f"\nSaved: {out_path}")
PY
}

bench_one
