#!/usr/bin/env bash
# jetstreamer-backfill.sh — bring the local jetstreamer/ClickHouse up to date
# with Old Faithful by ingesting every recently-published epoch that isn't
# already complete.  Idempotent and safe to re-run.
#
# The companion systemd timer `jetstreamer-backfill.timer` runs this hourly.
#
# Env (with defaults):
#   JETSTREAMER_BIN                /usr/local/bin/jetstreamer
#   JETSTREAMER_CLICKHOUSE_DSN     http://localhost:8123
#   JETSTREAMER_THREADS            120
#   JETSTREAMER_BUFFER_WINDOW      64GiB
#   PUBLIC_RPC                     https://api.mainnet-beta.solana.com
#   BASE_URL                       https://files.old-faithful.net
#   WINDOW                         0 (no rotation; >0 enables ALTER TABLE
#                                     DELETE for slot < (latest-window)*432000)

set -euo pipefail

JETSTREAMER_BIN="${JETSTREAMER_BIN:-/usr/local/bin/jetstreamer}"
JETSTREAMER_CLICKHOUSE_DSN="${JETSTREAMER_CLICKHOUSE_DSN:-http://localhost:8123}"
JETSTREAMER_THREADS="${JETSTREAMER_THREADS:-120}"
JETSTREAMER_BUFFER_WINDOW="${JETSTREAMER_BUFFER_WINDOW:-64GiB}"
PUBLIC_RPC="${PUBLIC_RPC:-https://api.mainnet-beta.solana.com}"
BASE_URL="${BASE_URL:-https://files.old-faithful.net}"
WINDOW="${WINDOW:-0}"
SLOTS_PER_EPOCH=432000

log() { printf "[js-backfill %s] %s\n" "$(date -Iseconds)" "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { log "ERROR: $1 missing"; exit 1; }
}
require curl
require "$JETSTREAMER_BIN"

ch() {
  curl -sf --max-time 60 -X POST --data-binary @- "${JETSTREAMER_CLICKHOUSE_DSN}/?database=default"
}

discover_latest_epoch() {
  local current probe
  current=$(curl -fsSL --max-time 15 "$PUBLIC_RPC" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getEpochInfo"}' \
    | sed -n 's/.*"epoch":\s*\([0-9]*\).*/\1/p' | head -1) || true
  if [ -z "$current" ]; then
    log "WARN: cannot reach $PUBLIC_RPC; defaulting probe range"
    current=1100
  fi
  for probe in $(seq "$current" -1 $((current > 30 ? current - 30 : 1))); do
    if curl -fsI --max-time 8 "${BASE_URL}/${probe}/epoch-${probe}.cid" >/dev/null 2>&1; then
      echo "$probe"
      return 0
    fi
  done
  log "ERROR: no available epoch found"
  return 1
}

# An epoch is considered "complete" when slot_status holds at least 99% of
# its slots (some slots are leader-skipped, so we don't require all 432k).
get_completed_epochs() {
  echo "SELECT intDiv(slot, ${SLOTS_PER_EPOCH}) AS epoch
        FROM jetstreamer_slot_status
        GROUP BY epoch
        HAVING count() >= 427680
        ORDER BY epoch
        FORMAT TabSeparated" | ch || true
}

ingest_epoch() {
  local epoch="$1"
  log "epoch ${epoch}: ingesting"
  JETSTREAMER_THREADS="$JETSTREAMER_THREADS" \
  JETSTREAMER_BUFFER_WINDOW="$JETSTREAMER_BUFFER_WINDOW" \
  JETSTREAMER_CLICKHOUSE_MODE=remote \
  JETSTREAMER_CLICKHOUSE_DSN="$JETSTREAMER_CLICKHOUSE_DSN" \
    "$JETSTREAMER_BIN" "$epoch"
}

rotate() {
  local oldest_kept_slot="$1"
  local tbl
  for tbl in jetstreamer_slot_status program_invocations; do
    log "rotating $tbl: deleting rows where slot < ${oldest_kept_slot}"
    echo "ALTER TABLE ${tbl} DELETE WHERE slot < ${oldest_kept_slot}" \
      | ch || log "WARN: rotation on $tbl failed"
  done
}

main() {
  local latest target_min completed epoch
  latest=$(discover_latest_epoch)
  log "latest published epoch: ${latest}"

  if [ "$WINDOW" -gt 0 ]; then
    target_min=$((latest - WINDOW + 1))
  else
    target_min=0
  fi
  log "ingest range: [${target_min}..${latest}] (window=${WINDOW})"

  completed=$(get_completed_epochs | tr '\n' ' ')
  log "already complete: ${completed}"

  local ingested_any=0
  for epoch in $(seq "$target_min" "$latest"); do
    [ "$epoch" -lt 0 ] && continue
    if echo " ${completed} " | grep -q " ${epoch} "; then
      log "epoch ${epoch}: skip (already ingested)"
      continue
    fi
    if ingest_epoch "$epoch"; then
      ingested_any=1
    else
      log "WARN: ingest failed for epoch ${epoch}"
    fi
  done

  if [ "$WINDOW" -gt 0 ] && [ "$ingested_any" = "1" ]; then
    rotate "$((target_min * SLOTS_PER_EPOCH))"
  fi

  log "done"
}

main "$@"
