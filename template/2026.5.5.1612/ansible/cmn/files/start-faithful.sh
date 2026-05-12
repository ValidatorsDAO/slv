#!/usr/bin/env bash
# start-faithful.sh — wrapper that expands a config-epoch glob and execs
# yellowstone-faithful.  Used by faithful.service ExecStart so the rolling
# cache (of1-index-sync.sh) can add/remove configs without editing systemd.

set -euo pipefail

PROXY="${PROXY:-/home/solv/proxy.yml}"
LISTEN="${LISTEN:-:8888}"
GRPC_LISTEN="${GRPC_LISTEN:-}"
SEARCH_CONC="${EPOCH_SEARCH_CONCURRENCY:-64}"
LOAD_CONC="${EPOCH_LOAD_CONCURRENCY:-1}"
CONFIGS_DIR="${CONFIGS_DIR:-/home/solv/configs}"
BIN="${FAITHFUL_BIN:-/home/solv/faithful-cli}"

shopt -s nullglob
configs=("${CONFIGS_DIR}"/config-epoch*.yaml)
shopt -u nullglob

if [ "${#configs[@]}" -eq 0 ]; then
  echo "ERROR: no config-epoch*.yaml found in ${CONFIGS_DIR}" >&2
  exit 1
fi

cmd=("$BIN" rpc "--proxy=${PROXY}" "--listen=${LISTEN}")
if [ -n "$GRPC_LISTEN" ]; then
  cmd+=("--grpc-listen=${GRPC_LISTEN}")
fi
cmd+=("--epoch-search-concurrency" "$SEARCH_CONC" "--epoch-load-concurrency" "$LOAD_CONC")
cmd+=("${configs[@]}")

exec "${cmd[@]}"
