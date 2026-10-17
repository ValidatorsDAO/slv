#!/usr/bin/env bash
# Public Google metadata API: https://cloud.google.com/compute/docs/metadata/querying-metadata
# No controller, GitHub App, Google, or 1Password credentials enter this VM.
set -euo pipefail
umask 077

stage=initialization
trap 'printf "SLV runner bootstrap failed during %s\n" "$stage" >&2' ERR
printf 'SLV runner bootstrap starting\n'

metadata() {
  curl --fail --silent --show-error --retry 3 --connect-timeout 5 --max-time 20 \
    -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

[[ "$(uname -m)" == x86_64 ]]

stage=packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq sudo tar gzip unzip xz-utils python3 build-essential \
  pkg-config libssl-dev libicu74 libkrb5-3 zlib1g liblttng-ust1t64

stage=metadata
runner_version="$(metadata slv-runner-version)"
runner_sha256="$(metadata slv-runner-sha256)"
[[ "$runner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$runner_sha256" =~ ^[a-f0-9]{64}$ ]]

stage=download
install -d -m 0755 /opt/slv-actions-runner
archive="$(mktemp /tmp/slv-actions-runner.XXXXXX)"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  "https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-linux-x64-${runner_version}.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$runner_sha256" "$archive" | sha256sum --check --status
tar --extract --gzip --file "$archive" --directory /opt/slv-actions-runner
rm -f "$archive"

stage=user
if ! id runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash runner
fi
printf 'runner ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/slv-runner
chmod 0440 /etc/sudoers.d/slv-runner
visudo -cf /etc/sudoers.d/slv-runner >/dev/null
chown -R runner:runner /opt/slv-actions-runner
install -d -m 0700 -o runner -g runner /run/slv-actions-runner
metadata slv-jit-config >/run/slv-actions-runner/jit-config
chown runner:runner /run/slv-actions-runner/jit-config
chmod 0600 /run/slv-actions-runner/jit-config

stage=service
cat >/usr/local/bin/slv-run-jit-runner <<'RUNNER_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
umask 077
# The pinned Listener consumes and removes ACTIONS_RUNNER_INPUT_* variables:
# https://github.com/actions/runner/blob/v2.338.0/src/Runner.Listener/CommandSettings.cs
export ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat /run/slv-actions-runner/jit-config)"
rm -f /run/slv-actions-runner/jit-config
cd /opt/slv-actions-runner
exec ./bin/Runner.Listener run
RUNNER_SCRIPT
chmod 0755 /usr/local/bin/slv-run-jit-runner
cat >/etc/systemd/system/slv-actions-runner.service <<'RUNNER_SERVICE'
[Unit]
Description=SLV single-job GitHub Actions runner
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=runner
Group=runner
WorkingDirectory=/opt/slv-actions-runner
Environment=HOME=/home/runner
ExecStart=/usr/local/bin/slv-run-jit-runner
Restart=no
KillMode=control-group
TimeoutStopSec=30
# Never forward runner/job output or diagnostic logs to serial/Cloud Logging.
# GitHub receives job logs; _diag stays on this disposable disk.
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
RUNNER_SERVICE
systemctl daemon-reload
systemctl start slv-actions-runner.service
printf 'SLV runner service started; waiting for the controller to release its job\n'
