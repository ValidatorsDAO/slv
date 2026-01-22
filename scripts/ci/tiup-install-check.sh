#!/usr/bin/env bash
set -euo pipefail

TEMP_ROOT="${RUNNER_TEMP:-/tmp}"
TIUP_HOME="${TIUP_HOME:-$TEMP_ROOT/tiup-test}"

if [[ "$TIUP_HOME" == "$HOME/.tiup" ]]; then
  echo "Refusing to use default TIUP_HOME to avoid modifying local setup." >&2
  echo "Set TIUP_HOME to a temp directory and retry." >&2
  exit 1
fi

rm -rf "$TIUP_HOME"
mkdir -p "$TIUP_HOME"

export TIUP_HOME
export PATH="$TIUP_HOME/bin:$PATH"
export TIUP_DISABLE_TELEMETRY=1

echo "TIUP_HOME=$TIUP_HOME"
echo "Installing tiup..."
curl --proto '=https' --tlsv1.2 -sSf https://tiup-mirrors.pingcap.com/install.sh | sh

if [[ ! -x "$TIUP_HOME/bin/tiup" ]]; then
  echo "tiup binary not found at $TIUP_HOME/bin/tiup" >&2
  exit 1
fi

echo "tiup installed:"
"$TIUP_HOME/bin/tiup" --version
