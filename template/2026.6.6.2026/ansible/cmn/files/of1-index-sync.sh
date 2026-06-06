#!/usr/bin/env bash
# of1-index-sync.sh — maintain a rolling local cache of yellowstone-faithful
# index files for the most recent N epochs, then regenerate per-epoch config
# YAMLs and restart the faithful service.
#
# CAR files stay remote; only the (much smaller) per-epoch indexes are stored
# locally.  This drives the per-query latency win measured in Phase 1
# (getTransaction ~6x faster) at ~30 GB per recent epoch instead of ~570 GB.
#
# Idempotent: re-running with the same window is a no-op when nothing changed.
# Driven by /etc/systemd/system/of1-index-sync.timer (daily) but can be
# invoked ad-hoc.
#
# Env (with defaults):
#   WINDOW                  rolling window size in epochs            (30)
#   CACHE_DIR               where indexes live                       (/mnt/ledger/car/indexes)
#   CONFIG_DIR              where per-epoch config YAMLs live        (/home/solv/configs)
#   BASE_URL                Old Faithful base URL                    (https://files.old-faithful.net)
#   CAR_BASE_URL            CAR base URL (kept remote for size)      (= BASE_URL)
#   SERVICE_NAME            faithful systemd unit                    (faithful.service)
#   FAITHFUL_OWNER          UNIX owner for cache + configs           (solv)
#   JOBS                    aria2c concurrent downloads              (5)
#   CONNS_PER_FILE          aria2c connections-per-server            (8)
#   PUBLIC_RPC              upstream RPC for current-epoch discovery (https://api.mainnet-beta.solana.com)
#   DRY_RUN                 set to 1 to print actions only
#   SKIP_RESTART            set to 1 to skip systemctl restart at the end

set -euo pipefail

WINDOW="${WINDOW:-30}"
CACHE_DIR="${CACHE_DIR:-/mnt/ledger/car/indexes}"
CONFIG_DIR="${CONFIG_DIR:-/home/solv/configs}"
BASE_URL="${BASE_URL:-https://files.old-faithful.net}"
CAR_BASE_URL="${CAR_BASE_URL:-${BASE_URL}}"
SERVICE_NAME="${SERVICE_NAME:-faithful.service}"
FAITHFUL_OWNER="${FAITHFUL_OWNER:-solv}"
JOBS="${JOBS:-5}"
CONNS_PER_FILE="${CONNS_PER_FILE:-8}"
PUBLIC_RPC="${PUBLIC_RPC:-https://api.mainnet-beta.solana.com}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_RESTART="${SKIP_RESTART:-0}"
LOCK_FILE="${LOCK_FILE:-/var/lock/of1-index-sync.lock}"

INDEX_SUFFIXES=(
  cid-to-offset-and-size
  slot-to-cid
  sig-to-cid
  sig-exists
  slot-to-blocktime
)

log() { printf "[of1-sync %s] %s\n" "$(date -Iseconds)" "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    log "ERROR: required tool not found: $1"
    exit 1
  }
}
require curl
require aria2c
require stat
require flock

# Cleanup any temp files we leak (aria2c input list, etc).
TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f"
  done
}
trap cleanup EXIT INT TERM

mktemp_track() {
  local t
  t=$(mktemp)
  TMP_FILES+=("$t")
  echo "$t"
}

# Discover the most recent epoch published on Old Faithful.  Walks down from
# the on-chain "current" epoch (one finalized epoch lags behind).
discover_latest_epoch() {
  local current resp
  resp=$(curl -fsSL --max-time 15 "$PUBLIC_RPC" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getEpochInfo"}' 2>/dev/null) || resp=""
  # Prefer jq when available (correct JSON parsing), fall back to a strict regex.
  if command -v jq >/dev/null 2>&1 && [ -n "$resp" ]; then
    current=$(printf '%s' "$resp" | jq -r '.result.epoch // empty' 2>/dev/null || true)
  else
    current=$(printf '%s' "$resp" | grep -oE '"epoch"[[:space:]]*:[[:space:]]*[0-9]+' \
      | head -1 | grep -oE '[0-9]+' || true)
  fi
  # Validate or fall back.
  if ! [[ "${current:-}" =~ ^[0-9]+$ ]]; then
    log "WARN: cannot parse epoch from $PUBLIC_RPC; falling back to probe range starting at 1500"
    current=1500
  fi
  local probe lower
  lower=$(( current > 30 ? current - 30 : 1 ))
  for probe in $(seq "$current" -1 "$lower"); do
    if curl -fsI --max-time 8 "${BASE_URL}/${probe}/epoch-${probe}.cid" >/dev/null 2>&1; then
      echo "$probe"
      return 0
    fi
  done
  log "ERROR: no available epoch found in probe range [${lower}..${current}]"
  return 1
}

get_cid() {
  local epoch="$1"
  curl -fsSL --max-time 30 "${BASE_URL}/${epoch}/epoch-${epoch}.cid" | tr -d '[:space:]'
}

remote_size() {
  curl -sIL --max-time 15 "$1" \
    | awk -F': ' 'BEGIN{IGNORECASE=1} tolower($1)=="content-length"{print $2}' \
    | tail -1 | tr -d '\r'
}

# Verify that every index file for an epoch is present and matches the remote
# Content-Length.  Returns 0 if complete, 1 otherwise.
epoch_complete() {
  local epoch="$1"
  local dir="${CACHE_DIR}/${epoch}"
  [ -d "$dir" ] || return 1
  local cid
  cid=$(get_cid "$epoch") || return 1
  local suf url f want got
  for suf in "${INDEX_SUFFIXES[@]}"; do
    f="${dir}/epoch-${epoch}-${cid}-mainnet-${suf}.index"
    [ -f "$f" ] || return 1
    url="${BASE_URL}/${epoch}/epoch-${epoch}-${cid}-mainnet-${suf}.index"
    want=$(remote_size "$url")
    got=$(stat -c %s "$f" 2>/dev/null || echo 0)
    [ -n "$want" ] || return 1
    [ "$want" = "$got" ] || return 1
  done
  return 0
}

download_epoch() {
  local epoch="$1"
  local cid
  cid=$(get_cid "$epoch") || { log "ERROR: cannot fetch cid for epoch $epoch"; return 1; }
  local dir="${CACHE_DIR}/${epoch}"
  mkdir -p "$dir"
  chown "$FAITHFUL_OWNER":"$FAITHFUL_OWNER" "$dir" 2>/dev/null || true
  local input
  input=$(mktemp_track)
  local suf
  # Download to *.part filenames; rename to final names only after we
  # verify the byte count matches Content-Length.  Atomic mv avoids
  # faithful loading a half-written index after a sync interruption.
  for suf in "${INDEX_SUFFIXES[@]}"; do
    cat >> "$input" <<EOF
${BASE_URL}/${epoch}/epoch-${epoch}-${cid}-mainnet-${suf}.index
  dir=${dir}
  out=epoch-${epoch}-${cid}-mainnet-${suf}.index.part
EOF
  done
  log "downloading epoch ${epoch} (cid=${cid:0:18}...)"
  aria2c \
    --input-file="$input" \
    --max-concurrent-downloads="$JOBS" \
    --split="$CONNS_PER_FILE" \
    --max-connection-per-server="$CONNS_PER_FILE" \
    --min-split-size=10M \
    --file-allocation=none \
    --console-log-level=warn \
    --summary-interval=0 \
    --auto-file-renaming=false \
    --allow-overwrite=true \
    --continue=true >&2
  rm -f "$input"

  # Verify size of every .part file before promoting it to its final name.
  # Anything that doesn't match its remote Content-Length is left as .part
  # so the next sync run picks it up via the completeness check.
  local suf url want got partfile finalfile failed=0
  for suf in "${INDEX_SUFFIXES[@]}"; do
    partfile="${dir}/epoch-${epoch}-${cid}-mainnet-${suf}.index.part"
    finalfile="${dir}/epoch-${epoch}-${cid}-mainnet-${suf}.index"
    [ -f "$partfile" ] || { log "WARN: missing ${partfile}"; failed=1; continue; }
    url="${BASE_URL}/${epoch}/epoch-${epoch}-${cid}-mainnet-${suf}.index"
    want=$(remote_size "$url")
    got=$(stat -c %s "$partfile" 2>/dev/null || echo 0)
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
      log "WARN: epoch ${epoch} ${suf}: size mismatch want=${want:-?} got=${got}; leaving .part"
      failed=1
      continue
    fi
    mv -f "$partfile" "$finalfile"
  done
  chown -R "$FAITHFUL_OWNER":"$FAITHFUL_OWNER" "$dir" 2>/dev/null || true
  return "$failed"
}

write_config() {
  local epoch="$1"
  local cid
  cid=$(get_cid "$epoch") || return 1
  local dir="${CACHE_DIR}/${epoch}"
  local out="${CONFIG_DIR}/config-epoch${epoch}.yaml"
  mkdir -p "$CONFIG_DIR"
  cat > "$out" <<EOF
# Old Faithful RPC config for epoch ${epoch} (LOCAL indexes + REMOTE CAR)
# Generated by of1-index-sync.sh on $(date -Iseconds)

version: 1
epoch: ${epoch}

data:
  car:
    uri: "${CAR_BASE_URL}/${epoch}/epoch-${epoch}.car"
  filecoin:
    enable: false

indexes:
  cid_to_offset_and_size:
    uri: "${dir}/epoch-${epoch}-${cid}-mainnet-cid-to-offset-and-size.index"
  slot_to_cid:
    uri: "${dir}/epoch-${epoch}-${cid}-mainnet-slot-to-cid.index"
  sig_to_cid:
    uri: "${dir}/epoch-${epoch}-${cid}-mainnet-sig-to-cid.index"
  sig_exists:
    uri: "${dir}/epoch-${epoch}-${cid}-mainnet-sig-exists.index"
  slot_to_blocktime:
    uri: "${dir}/epoch-${epoch}-${cid}-mainnet-slot-to-blocktime.index"
EOF
  chown "$FAITHFUL_OWNER":"$FAITHFUL_OWNER" "$out" 2>/dev/null || true
}

main() {
  mkdir -p "$CACHE_DIR" "$CONFIG_DIR"
  chown "$FAITHFUL_OWNER":"$FAITHFUL_OWNER" "$CACHE_DIR" "$CONFIG_DIR" 2>/dev/null || true

  local latest target_min
  latest=$(discover_latest_epoch)
  log "latest available epoch on Old Faithful: ${latest}"
  target_min=$((latest - WINDOW + 1))
  [ "$target_min" -lt 0 ] && target_min=0
  log "target window: [${target_min}..${latest}] (${WINDOW} epochs)"

  local changed=0
  local cur_epochs=()
  local epoch
  for epoch in $(seq "$latest" -1 "$target_min"); do
    if epoch_complete "$epoch"; then
      log "epoch ${epoch}: complete"
    else
      if [ "$DRY_RUN" = "1" ]; then
        log "[dry-run] would download epoch ${epoch}"
      else
        download_epoch "$epoch" || { log "WARN: download failed for epoch ${epoch}"; continue; }
        changed=1
      fi
    fi
    [ "$DRY_RUN" = "1" ] || write_config "$epoch"
    cur_epochs+=("$epoch")
  done

  # Evict cache directories outside the window
  local d e
  if [ -d "$CACHE_DIR" ]; then
    for d in "$CACHE_DIR"/*; do
      [ -d "$d" ] || continue
      e=$(basename "$d")
      [[ "$e" =~ ^[0-9]+$ ]] || continue
      if [ "$e" -lt "$target_min" ] || [ "$e" -gt "$latest" ]; then
        if [ "$DRY_RUN" = "1" ]; then
          log "[dry-run] would evict epoch ${e}"
        else
          log "evicting epoch ${e}"
          rm -rf "$d"
          rm -f "${CONFIG_DIR}/config-epoch${e}.yaml"
          changed=1
        fi
      fi
    done
  fi

  # Evict orphan config YAMLs outside the window (catches legacy configs
  # whose target epoch was never localized — those would otherwise run with
  # all-remote URIs, ~10x slower than proxied fallback).
  local cfg base
  if [ -d "$CONFIG_DIR" ]; then
    for cfg in "$CONFIG_DIR"/config-epoch*.yaml; do
      [ -f "$cfg" ] || continue
      base=$(basename "$cfg" .yaml)
      e="${base#config-epoch}"
      [[ "$e" =~ ^[0-9]+$ ]] || continue
      if [ "$e" -lt "$target_min" ] || [ "$e" -gt "$latest" ]; then
        if [ "$DRY_RUN" = "1" ]; then
          log "[dry-run] would evict orphan config epoch ${e}"
        else
          log "evicting orphan config epoch ${e}"
          rm -f "$cfg"
          changed=1
        fi
      fi
    done
  fi

  if [ "$changed" = "1" ] && [ "$DRY_RUN" != "1" ] && [ "$SKIP_RESTART" != "1" ]; then
    log "restarting ${SERVICE_NAME}"
    systemctl restart "$SERVICE_NAME" || log "WARN: restart of ${SERVICE_NAME} failed"
  else
    log "no changes (or restart skipped); ${SERVICE_NAME} not restarted"
  fi

  log "done. cached epochs: ${cur_epochs[*]:-(none)}"
}

# Serialize concurrent runs (e.g. timer firing while a manual run is in
# flight) so we never have two aria2c processes writing into the same
# `${dir}/*.index.part` files.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another sync is already running; exiting"
  exit 0
fi

main "$@"
