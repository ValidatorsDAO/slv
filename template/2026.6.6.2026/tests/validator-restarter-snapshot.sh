#!/usr/bin/env bash
# Deterministic contract test for the restarter template (no network or host access).
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
template="$root/template/2026.6.6.2026/jinja/cmn/restart.sh.j2"
dist="$root/dist/oss-skills/slv-validator/jinja/cmn/restart.sh.j2"
copy="$root/template/2026.6.6.2026/ansible/cmn/copy_restart_sh.yml"
wcopy="$root/dist/oss-skills/slv-validator/ansible/cmn/copy_restart_sh.yml"
wget_source="$root/template/2026.6.6.2026/ansible/cmn/wget_snapshot.yml"
wget_dist="$root/dist/oss-skills/slv-validator/ansible/cmn/wget_snapshot.yml"

cmp -s "$template" "$dist"
cmp -s "$copy" "$wcopy"
cmp -s "$wget_source" "$wget_dist"
for sibling in slv-rpc slv-grpc-geyser; do
  cmp -s "$template" "$root/dist/oss-skills/$sibling/jinja/cmn/restart.sh.j2"
  cmp -s "$copy" "$root/dist/oss-skills/$sibling/ansible/cmn/copy_restart_sh.yml"
  cmp -s "$wget_source" "$root/dist/oss-skills/$sibling/ansible/cmn/wget_snapshot.yml"
done
grep -Fq 'wget -q -c --trust-server-names' "$template"
grep -Fq 'https://solana-snapshot-fra.erpc.global' "$template"
grep -Fq 'https://solana-snapshot-ams.erpc.global' "$template"
grep -Fq 'snapshot_network}" == mainnet' "$template"
grep -Fq 'snapshot_network}" == testnet' "$template"
grep -Fq 'readonly live_snapshot="${snapshot_root}/remote"' "$template"
grep -Fq 'readonly staging_root="${snapshot_root}/.restarter-staging-${snapshot_network}"' "$template"
grep -Fq 'flock -n 9' "$template"
grep -Fq 'download_deadline=$((SECONDS + download_timeout))' "$template"
grep -Fq 'timeout "${remaining}s" wget -q -c' "$template"
grep -Fq 'trap on_exit EXIT' "$template"
grep -Fq 'mv -- "${selected_staging}" "${live_snapshot}"' "$template"
grep -Fq 'incremental_base' "$template"
grep -Fq 'incremental_slot' "$template"
grep -Fq -- '-ge "${full_slot}' "$template"
grep -Fq 'validator_type: "{{ hostvars[inventory_hostname].validator_type }}"' "$copy"
! grep -Fq 'validator_type: "solv"' "$copy"
! grep -Fq 'async: 3600' "$template"
! grep -Fq 'failed_when: false' "$template"
! grep -Fq 'async: 3600' "$wget_source"
! grep -Fq 'failed_when: false' "$wget_source"
grep -Fq 'async: 10800' "$wget_source"
grep -Fq 'tar -tjf' "$template"
grep -Fq 'tar --zstd -tf' "$template"
grep -Fq 'set -euo pipefail' "$wget_source"
! grep -Fq 'failed_when: false' "$wget_source"
grep -Fq 'timeout 30s solana catchup' "$template"
grep -Fq -- "-not -name 'contact-info.bin' -delete" "$template"
! grep -Fq 'mktemp -d' "$template"
! grep -Fq 'rollback}"; then rm -rf' "$template"
stop_line=$(grep -n 'systemctl stop' "$template" | head -n1 | cut -d: -f1)
promote_line=$(grep -n 'mv -- "${selected_staging}" "${live_snapshot}"' "$template" | head -n1 | cut -d: -f1)
test "$stop_line" -lt "$promote_line"
grep -Fq 'restore_service' "$template"
for caller in \
  "$root/template/2026.6.6.2026/ansible/mainnet-rpc/init.yml" \
  "$root/template/2026.6.6.2026/ansible/mainnet-rpc/init-old.yml"; do
  grep -Fq 'restarter_snapshot_network: mainnet' "$caller"
done
grep -Fq 'restarter_snapshot_network: devnet' \
  "$root/template/2026.6.6.2026/ansible/devnet-rpc/init.yml"
for caller in \
  "$root/dist/oss-skills/slv-rpc/ansible/mainnet-rpc/init.yml" \
  "$root/dist/oss-skills/slv-rpc/ansible/mainnet-rpc/init-old.yml" \
  "$root/dist/oss-skills/slv-grpc-geyser/ansible/mainnet-rpc/init.yml" \
  "$root/dist/oss-skills/slv-grpc-geyser/ansible/mainnet-rpc/init-old.yml"; do
  grep -Fq 'restarter_snapshot_network: mainnet' "$caller"
done
grep -Fq 'restarter_snapshot_network: testnet' \
  "$root/dist/oss-skills/slv-rpc/ansible/testnet-rpc/init.yml"
grep -Fq 'restarter_snapshot_network: devnet' \
  "$root/dist/oss-skills/slv-rpc/ansible/devnet-rpc/init.yml"
test ! -e "$root/dist/oss-skills/slv-validator/ansible/mainnet-validator/init-allnodes-jito.yml"

behavior_root=$(mktemp -d /tmp/slv-restarter-test.XXXXXX)
trap 'rm -rf -- "$behavior_root"' EXIT
mkdir -p "$behavior_root/bin" "$behavior_root/live/remote" "$behavior_root/live/ledger" "$behavior_root/fixtures"
# GNU wget's own diagnostics must not reveal an operator-supplied direct URL.
private_probe='http://127.0.0.1:1/private-direct-fra?token=must-not-log'
if wget -q "$private_probe" 2>"$behavior_root/wget-private-probe.log"; then exit 1; fi
! grep -Fq 'private-direct-fra' "$behavior_root/wget-private-probe.log"
# Render the default-empty URL path with the real Ansible/Jinja engine; the
# behavior harness below intentionally substitutes paths and is not a render
# correctness proof.
ansible localhost -i 'localhost,' -c local -m ansible.builtin.template \
  -a "src=$template dest=$behavior_root/jinja-mainnet-empty.sh mode=0700" \
  -e '{"validator_type":"solv","restarter_snapshot_network":"mainnet","snapshot_direct_fra_url":"","snapshot_url":""}' \
  >/dev/null
bash -n "$behavior_root/jinja-mainnet-empty.sh"
printf sentinel > "$behavior_root/live/remote/sentinel"
printf ledger-sentinel > "$behavior_root/live/ledger/sentinel"
printf contact > "$behavior_root/live/ledger/contact-info.bin"
printf file > "$behavior_root/fixtures/file"
tar -cjf "$behavior_root/fixtures/snapshot-100-abc.tar.bz2" -C "$behavior_root/fixtures" file
tar -cjf "$behavior_root/fixtures/incremental-snapshot-100-120-abc.tar.bz2" -C "$behavior_root/fixtures" file
cat > "$behavior_root/bin/wget" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dest=""; url=""
while (($#)); do case "$1" in -P) dest=$2; shift 2;; http*) url=$1; shift;; *) shift;; esac; done
name=$(basename "${url/snapshot.tar.bz2/snapshot-100-abc.tar.bz2}")
[[ "$url" == *incremental* ]] && name=incremental-snapshot-100-120-abc.tar.bz2
if [[ "${WGET_FAIL:-0}" == 1 ]]; then
  printf partial > "$dest/$name"
  exit 7
fi
if [[ -e "$dest/$name" ]]; then
  printf 'resume:%s\n' "$name" >> "${WGET_LOG:?}"
fi
cp "$FIXTURES/$name" "$dest/$name"
EOF
cat > "$behavior_root/bin/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "${LEDGER_FAIL:-0}" == 1 && "$1" == find ]] && exit 8
exec "$@"
EOF
cat > "$behavior_root/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SYSTEMCTL_LOG:?}"
[[ "${STOP_FAIL:-0}" == 1 && "$1" == stop ]] && exit 9
[[ "$1" == is-active ]] && exit 0
exit 0
EOF
cat > "$behavior_root/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source_path=$1
[[ "${source_path}" == -- ]] && source_path=$2
if [[ "${MV_ROLLBACK_FAIL:-0}" == 1 && "${source_path}" == *'/.rollback.'* ]]; then exit 10; fi
exec /usr/bin/mv "$@"
EOF
cat > "$behavior_root/bin/rm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${CLEANUP_FAIL:-0}" == 1 && "$*" == *'/.rollback.'* ]]; then
  for candidate in "$@"; do
    [[ "${candidate}" == *'/.rollback.'* ]] || continue
    /usr/bin/rm -rf -- "${candidate}"
    break
  done
  exit 11
fi
exec /usr/bin/rm "$@"
EOF
cat > "$behavior_root/bin/solana" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$behavior_root/bin"/*
rendered="$behavior_root/restarter.sh"
sed -e "s#readonly snapshot_root=/mnt/snapshot#readonly snapshot_root=$behavior_root/live#" \
  -e "s#{{ 'firedancer' if validator_type in \['firedancer-jito', 'firedancer-agave'\] else 'solv' }}#solv#" \
  -e "s#{{ snapshot_direct_fra_url | default('') }}##" \
  -e 's#readonly snapshot_network=.*#readonly snapshot_network="mainnet"#' \
  -e '/{% if snapshot_url/,/{% endif %}/c\  :' "$template" > "$rendered"
bash -n "$rendered"
PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" SLV_RESTARTER_CATCHUP_TIMEOUT=2 bash "$rendered"
test -f "$behavior_root/live/remote/snapshot-100-abc.tar.bz2"
test ! -e "$behavior_root/live/remote/remote"
test ! -e "$behavior_root/live/.rollback"*
test ! -e "$behavior_root/live/ledger/sentinel"
test -f "$behavior_root/live/ledger/contact-info.bin"
# A partial post-catch-up cleanup failure must not roll the healthy promoted
# snapshot out of the live path or leave the service running without it.
rm -rf "$behavior_root/live/remote" "$behavior_root/live/ledger"
mkdir -p "$behavior_root/live/remote" "$behavior_root/live/ledger"
printf previous > "$behavior_root/live/remote/sentinel"
printf contact > "$behavior_root/live/ledger/contact-info.bin"
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" CLEANUP_FAIL=1 SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" SLV_RESTARTER_CATCHUP_TIMEOUT=2 bash "$rendered"; then exit 1; fi
test -d "$behavior_root/live/remote"
test -f "$behavior_root/live/remote/snapshot-100-abc.tar.bz2"
test ! -e "$behavior_root/live/remote/remote"
# A stop failure must happen before promotion and preserve both sentinels.
rm -rf "$behavior_root/live/remote" "$behavior_root/live/ledger"
mkdir -p "$behavior_root/live/remote" "$behavior_root/live/ledger"
printf sentinel > "$behavior_root/live/remote/sentinel"
printf ledger-sentinel > "$behavior_root/live/ledger/sentinel"
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" STOP_FAIL=1 SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" SLV_RESTARTER_CATCHUP_TIMEOUT=2 bash "$rendered"; then exit 1; fi
test "$(cat "$behavior_root/live/remote/sentinel")" = sentinel
test "$(cat "$behavior_root/live/ledger/sentinel")" = ledger-sentinel
# A post-promotion ledger failure restores the previous snapshot and service.
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" LEDGER_FAIL=1 SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" SLV_RESTARTER_CATCHUP_TIMEOUT=2 bash "$rendered"; then exit 1; fi
test "$(cat "$behavior_root/live/remote/sentinel")" = sentinel
test "$(cat "$behavior_root/live/ledger/sentinel")" = ledger-sentinel
# If rollback rename itself fails, never start without a live snapshot and keep
# the rollback directory for operator recovery.
: > "$behavior_root/systemctl.log"
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" LEDGER_FAIL=1 MV_ROLLBACK_FAIL=1 SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" SLV_RESTARTER_CATCHUP_TIMEOUT=2 bash "$rendered"; then exit 1; fi
test ! -e "$behavior_root/live/remote"
test -n "$(find "$behavior_root/live" -maxdepth 1 -type d -name '.rollback.*' -print -quit)"
! grep -Fxq 'start solv' "$behavior_root/systemctl.log"
rm -rf "$behavior_root/live/.rollback."* "$behavior_root/live/.restarter-staging-mainnet"
mkdir -p "$behavior_root/live/remote"
printf sentinel > "$behavior_root/live/remote/sentinel"
# A next invocation recovers one stranded rollback, restarts, and stops before
# any forward download/promotion retry.
rm -rf "$behavior_root/live/remote"
mkdir -p "$behavior_root/live/.rollback.interrupted"
printf interrupted > "$behavior_root/live/.rollback.interrupted/sentinel"
: > "$behavior_root/systemctl.log"
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" bash "$rendered"; then exit 1; fi
test "$(cat "$behavior_root/live/remote/sentinel")" = interrupted
grep -Fxq 'start solv' "$behavior_root/systemctl.log"
test ! -e "$behavior_root/live/.rollback.interrupted"
printf sentinel > "$behavior_root/live/remote/sentinel"
# A concurrent invocation cannot enter the download or stop/promotion path.
exec 8>"$behavior_root/live/.restarter-mainnet.lock"
flock -n 8
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" bash "$rendered"; then exit 1; fi
test "$(cat "$behavior_root/live/remote/sentinel")" = sentinel
test "$(cat "$behavior_root/live/ledger/sentinel")" = ledger-sentinel
flock -u 8
# Testnet with no explicit URL must fail closed before stopping or promotion.
testnet_rendered="$behavior_root/testnet-restarter.sh"
sed -e "s#readonly snapshot_root=/mnt/snapshot#readonly snapshot_root=$behavior_root/live#" \
  -e "s#{{ 'firedancer' if validator_type in \['firedancer-jito', 'firedancer-agave'\] else 'solv' }}#solv#" \
  -e "s#{{ snapshot_direct_fra_url | default('') }}##" \
  -e 's#readonly snapshot_network=.*#readonly snapshot_network="testnet"#' \
  -e '/{% if snapshot_url/,/{% endif %}/c\  :' "$template" > "$testnet_rendered"
bash -n "$testnet_rendered"
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" bash "$testnet_rendered"; then exit 1; fi
test "$(cat "$behavior_root/live/remote/sentinel")" = sentinel
test "$(cat "$behavior_root/live/ledger/sentinel")" = ledger-sentinel
rm -rf "$behavior_root/live/remote" "$behavior_root/live/ledger" "$behavior_root/live/.restarter-staging-mainnet"
mkdir -p "$behavior_root/live/remote" "$behavior_root/live/ledger"
printf sentinel > "$behavior_root/live/remote/sentinel"
printf ledger-sentinel > "$behavior_root/live/ledger/sentinel"
if PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" WGET_FAIL=1 bash "$rendered"; then exit 1; fi
test "$(cat "$behavior_root/live/remote/sentinel")" = sentinel
test "$(cat "$behavior_root/live/ledger/sentinel")" = ledger-sentinel
# The next invocation resumes the preserved per-source files and can promote.
PATH="$behavior_root/bin:$PATH" FIXTURES="$behavior_root/fixtures" WGET_LOG="$behavior_root/wget.log" SYSTEMCTL_LOG="$behavior_root/systemctl.log" SLV_RESTARTER_LEDGER_ROOT="$behavior_root/live/ledger" SLV_RESTARTER_CATCHUP_TIMEOUT=2 bash "$rendered"
grep -Fq 'resume:snapshot-100-abc.tar.bz2' "$behavior_root/wget.log"

echo 'validator restarter snapshot contract: PASS'
