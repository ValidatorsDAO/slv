#!/usr/bin/env bash
# Behaviour test for the vote history hand-over on a cluster that runs Alpenglow (no network
# or host access). Needs ansible-playbook and python3 on PATH:
#   bash template/2026.6.6.2026/tests/alpenglow-vote-history.sh
#
# Real playbooks run on a local connection against a stub RPC (alpenglow_stub_rpc.py) and a
# fake agave-validator (alpenglow_fake_agave.sh) that plays what agave v4.3.2 does: the admin
# RPC gate of set-identity, Votor's "set-identity: from OLD to NEW" line a moment after the
# identity changed, a vote history file that is rewritten while a node votes, and the
# "Authorized voter already present" error. Every box (a source, a target, or both on one
# file system) has its own ledger, log and fake state in a temporary directory.
#
#   1. switch_off: refuses without the vote history file before it waits or demotes; after
#      the demotion it waits for Votor's line and for a file that stopped changing, then
#      copies that file (not an earlier version) to ~/.slv/vote_history, readable by its
#      owner only; it stops, and says what is left, when Votor stays silent or the file keeps
#      changing; it asks the cluster again before it demotes
#   2. switch_on: uploads the file with the owner and mode agave gives it, sets the identity
#      without --require-tower, needs the authorized voter (already present is fine),
#      waits until the file of the host changes and the last vote of the vote account moves
#      on the cluster, removes the copy; it keeps the copy and says where it is when a step
#      fails or the host does not vote
#   3. set_identity_key: needs the file, never passes --require-tower, and on every run that
#      is not a first activation, file or no file, asks first whether anything votes with the
#      identity (the last vote of the vote account is more than 270 slots before the current
#      slot of the cluster) and whether the host has caught up (its finalized slot is at least
#      270 slots past that last vote), and reads gossip (the identity is at no address but the
#      one of the host and primary_down_address); --do-not-require-vote-history only for a
#      confirmed dead primary and no file
#   4. nodowntime_migrate: one run end to end, and the refusals before anything is demoted
#   5. TowerBFT is unchanged
#   6. after a demotion in a migrate run the cluster is asked patiently; when it stays out of
#      reach and the run is young enough the promotion goes on, with the tower after a TowerBFT
#      reading and with the vote history file after an Alpenglow reading, and when the run is
#      too old, or the cluster turned Alpenglow, both nodes stay unstaked and the run says so
set -uo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
template="$root/template/2026.6.6.2026"
for tool in ansible-playbook python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool is required on PATH" >&2
    exit 2
  }
done

work=$(mktemp -d /tmp/slv-alpenglow-vh.XXXXXX)
stub_pid=
cleanup() {
  [[ -n $stub_pid ]] && kill "$stub_pid" 2>/dev/null
  for pids in "$work"/s/*/*/pids; do
    [[ -e $pids ]] && xargs -r kill 2>/dev/null <"$pids"
  done
  if [[ -n ${SLV_TEST_KEEP:-} ]]; then
    echo "kept $work" >&2
  else
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT
mkdir -p "$work/s" "$work/tmp"
# ansible-core 2.19+ keeps a unix socket under TMPDIR, and a socket path can hold about 100 characters
export TMPDIR="$work/tmp"
export ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=False ANSIBLE_INVENTORY_UNPARSED_WARNING=False \
  ANSIBLE_GATHERING=explicit

python3 "$template/tests/alpenglow_stub_rpc.py" "$work/stub.log" >"$work/stub.port" 2>"$work/stub.err" &
stub_pid=$!
disown "$stub_pid" # a bare `wait` below must not wait for the server
for _ in $(seq 50); do
  [[ -s $work/stub.port ]] && break
  sleep 0.1
done
port=$(cat "$work/stub.port")
[[ $port =~ ^[0-9]+$ ]] || {
  echo "the stub RPC did not start: $(cat "$work/stub.err")" >&2
  exit 2
}
rpc="http://127.0.0.1:$port"

if command -v timeout >/dev/null 2>&1; then
  limited() { timeout 300 "$@"; }
else
  limited() { "$@"; }
fi

me=$(id -un)
mygroup=$(id -gn)
STAKED=StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA
UNSTAKED=UNSTAKEDKEY

# --- the rig ----------------------------------------------------------------

S=
NET=
ID=
check() { # condition result (0 = holds), description
  if (($1 == 0)); then echo "PASS $ID: $2" >>"$S/results"; else echo "FAIL $ID: $2" >>"$S/results"; fi
}

begin() { # id network
  ID="$2-$1"
  NET=$2
  S="$work/s/$ID"
  mkdir -p "$S/home/.slv/keys" "$S/ah"
  : >"$S/home/.profile"
  : >"$S/results"
  printf '[1,2,3]' >"$S/home/.slv/keys/$STAKED.json"
}

# inventory src_type dst_type [dst identity] [dst address] [src identity]
inventory() {
  cat >"$S/inventory.yml" <<INV
all:
  hosts:
    src:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
      ansible_host: 10.9.9.8
      identity_account: ${5:-$STAKED}
      vote_account: VOTEACCOUNT
      validator_type: $1
    dst:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
      ansible_host: ${4:-10.9.9.9}
      identity_account: ${3:-$STAKED}
      vote_account: VOTEACCOUNT
      validator_type: $2
INV
}

# box name role [knob=value ...]; role is src (runs the staked identity), dst (runs the
# unstaked one) or both (one file system for the two hosts of a migrate run)
box() {
  local name=$1 role=$2 dir file knob
  shift 2
  dir="$S/$name"
  mkdir -p "$dir/bin" "$dir/mnt/ledger" "$dir/solv" "$dir/ansible/$NET-validator" "$dir/ansible/cmn/tasks"
  : >"$dir/calls.log"
  : >"$dir/pids"
  for file in "$template/ansible/$NET-validator/"*.yml "$template/ansible/cmn/tasks/"*.yml; do
    local target="$dir/ansible/${file#"$template/ansible/"}"
    sed -e "s#/home/solv#$dir/solv#g" -e "s#/mnt#$dir/mnt#g" -e "s#owner: solv#owner: $me#g" -e "s#group: solv#group: $mygroup#g" \
      "$file" >"$target"
  done
  if grep -rEq '(^|[^A-Za-z0-9_])/(home/solv|mnt)([^A-Za-z0-9_]|$)' "$dir/ansible"; then
    echo "a path of the real host is left in the playbooks of $NET" >"$S/refused"
    return 1
  fi
  cp "$template/tests/alpenglow_fake_agave.sh" "$dir/bin/agave-validator"
  local name2
  for name2 in sudo fdctl systemctl; do
    printf '#!/bin/bash\necho "%s $*" >>"%s"\nexit 0\n' "$name2" "$dir/calls.log" >"$dir/bin/$name2"
  done
  chmod +x "$dir/bin/"*
  {
    echo "STAKED=$STAKED"
    echo "UNSTAKED=$UNSTAKED"
    echo "LOG=$dir/solv/solana-validator.log"
    for knob in "$@"; do echo "$knob"; done
  } >"$dir/fake.conf"
  printf '[%s WARN  agave_votor::event_handler] set-identity: from %s to OLDUNSTAKEDKEY\n' "2026-10-01T00:00:00.000000000Z" "$STAKED" >"$dir/solv/solana-validator.log"
  printf '["unstaked"]' >"$dir/solv/unstaked-identity.json"
  if [[ $role == dst ]]; then
    echo "$UNSTAKED" >"$dir/identity"
  else
    echo "$STAKED" >"$dir/identity"
  fi
}

vote_file() { echo "$S/$1/mnt/ledger/vote_history-$STAKED.bin"; }
tower_file() { echo "$S/$1/mnt/ledger/tower-1_9-$STAKED.bin"; }
copy_file() { echo "$S/home/.slv/vote_history/vote_history-$STAKED.bin"; }
prepare_copy() { # content: the vote history file of the identity, on the controller
  mkdir -p "$S/home/.slv/vote_history"
  chmod 700 "$S/home/.slv/vote_history"
  printf '%s\n' "$1" >"$(copy_file)"
  chmod 600 "$(copy_file)"
}
calls() { cat "$S/$1/calls.log"; }
count_calls() { grep -c -- "$2" "$S/$1/calls.log" || true; }

# play box playbook "host selection" [extra ansible args...]
play() {
  local box=$1 playbook=$2 selection=$3
  shift 3
  (
    cd "$S/$box" || exit 1
    # shellcheck disable=SC2086
    HOME="$S/home" PATH="$S/$box/bin:$PATH" FAKE_BOX="$S/$box" ANSIBLE_HOME="$S/ah" limited \
      ansible-playbook -i "$S/inventory.yml" $selection -e ansible_become=false \
      -e slv_alpenglow_rpc_delay=0 -e slv_vote_history_wait_seconds=15 -e slv_vote_poll_seconds=1 \
      -e slv_vote_history_gap_seconds=1 "$@" "$S/$box/ansible/$NET-validator/$playbook.yml" \
      >"$S/$box/$playbook.log" 2>&1 </dev/null
    echo $? >"$S/$box/$playbook.rc"
  )
}
rc_of() { cat "$S/$1/$2.rc" 2>/dev/null || echo missing; }
log_has() { grep -qF -- "$3" "$S/$1/$2.log"; }

ok() { # box playbook description
  [[ $(rc_of "$1" "$2") == 0 ]]
  check $? "$3 (rc $(rc_of "$1" "$2")) $(tail -n 4 "$S/$1/$2.log" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
}
refused() { # box playbook text description
  [[ $(rc_of "$1" "$2") != 0 && $(rc_of "$1" "$2") != missing ]] && log_has "$1" "$2" "$3"
  check $? "$4 (rc $(rc_of "$1" "$2")) $(tail -n 4 "$S/$1/$2.log" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
}

alp() { echo "$rpc/alpenglow/case=$ID${1:-}"; } # cluster in the alpenglow state, with options
tower() { echo "$rpc/towerbft/case=$ID${1:-}"; }
local_rpc() { echo "$rpc/local/case=$ID/slot=$1"; }

SOURCE_FILE_TEXT=vote-history-from-the-source

# --- the cases --------------------------------------------------------------

case_off_happy() {
  begin off_happy "$1"
  inventory agave agave
  box src src VOTOR_DELAY=2
  printf 'vote-history-initial\n' >"$(vote_file src)"
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(alp)"
  ok src switch_off_identity "switch_off takes the vote history"
  [[ $(count_calls src wait-for-restart-window) -eq 1 && $(count_calls src 'set-identity .*unstaked-identity.json') -eq 1 && $(count_calls src require-tower) -eq 0 ]]
  check $? "the source waits for a restart window once and is switched to the unstaked key without a tower flag"
  [[ -e "$(copy_file)" && $(cat "$(copy_file)") == "final-vote-history-of-$STAKED" ]]
  check $? "the copy on the controller is the file Votor left, not an earlier vote ($(cat "$(copy_file)" 2>/dev/null))"
  [[ $(stat -c %a "$(copy_file)" 2>/dev/null) == 600 && $(stat -c %a "$S/home/.slv/vote_history" 2>/dev/null) == 700 ]]
  check $? "the copy is readable by its owner only, and so is its folder"
  [[ ! -e $S/home/.slv/tower ]]
  check $? "no tower file is taken"
  grep -qF "set-identity: from $STAKED to $UNSTAKED" "$S/src/solv/solana-validator.log"
  check $? "the fake logged Votor's line"
}

case_off_no_file() {
  begin off_no_file "$1"
  inventory agave agave
  box src src
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(alp)"
  refused src switch_off_identity "vote history to carry" "switch_off refuses a source without the vote history file"
  [[ $(count_calls src .) -eq 0 && ! -e $S/home/.slv/vote_history ]]
  check $? "nothing was waited for, demoted or copied"
}

case_off_silent_votor() {
  begin off_silent_votor "$1"
  inventory agave agave
  box src src VOTOR_DELAY=1 NO_VOTOR_LINE=1
  printf 'vote-history-initial\n' >"$(vote_file src)"
  prepare_copy "a-copy-of-an-earlier-switch"
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(alp)"
  refused src switch_off_identity "Votor did not report" "an old Votor line does not stand in for the one of this demotion"
  log_has src switch_off_identity "is on its unstaked identity now and nothing was promoted"
  check $? "the message says the source is unstaked and nothing was promoted"
  log_has src switch_off_identity "has not voted for 270 slots" && log_has src switch_off_identity "slv v set:identity -p <that host>"
  check $? "the message names the wait that set:identity needs and the command"
  [[ $(count_calls src 'set-identity .*unstaked-identity.json') -eq 1 && ! -e "$(copy_file)" ]]
  check $? "the source was demoted, and no copy is left: neither a new one nor one of an earlier switch"
}

case_off_churning() {
  begin off_churning "$1"
  inventory agave agave
  box src src VOTOR_DELAY=1 CHURN_FOREVER=1
  printf 'vote-history-initial\n' >"$(vote_file src)"
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(alp)"
  refused src switch_off_identity "did not stay the same" "a file that keeps changing is not copied"
  [[ ! -e "$(copy_file)" ]]
  check $? "no copy was made"
}

case_off_mode_changes() {
  begin off_mode_changes "$1"
  inventory agave agave
  box src src
  printf 'vote-history-initial\n' >"$(vote_file src)"
  printf 'tower\n' >"$(tower_file src)"
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$rpc/tflip-1/case=$ID"
  refused src switch_off_identity "went from towerbft to alpenglow" "a cluster that turns Alpenglow while the switch waits stops the demotion"
  [[ $(count_calls src wait-for-restart-window) -eq 1 && $(count_calls src set-identity) -eq 0 ]]
  check $? "the source waited and was not demoted"
}

case_off_window_opens() {
  begin off_window_opens "$1"
  inventory agave agave
  box src src
  printf 'vote-history-initial\n' >"$(vote_file src)"
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$rpc/aflip-1/case=$ID"
  refused src switch_off_identity "identity changes wait until getAgGenesisCert returns a certificate" "the migration window opening during the wait stops the demotion"
  [[ $(count_calls src wait-for-restart-window) -eq 1 && $(count_calls src set-identity) -eq 0 ]]
  check $? "the source waited and was not demoted"
}

case_off_fdctl() {
  begin off_fdctl "$1"
  inventory firedancer-jito firedancer-jito
  box src src
  printf 'vote-history-initial\n' >"$(vote_file src)"
  play src switch_off_firedancer_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(alp)"
  refused src switch_off_firedancer_identity "cannot move an identity on a cluster that runs Alpenglow" "a Firedancer host is not switched off on Alpenglow"
  [[ $(count_calls src .) -eq 0 ]]
  check $? "nothing was run on the host"
}

# identity_account values that are not a base58 public key (32 to 44 characters of the base58 alphabet)
BAD_IDENTITIES=(
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  StakedKeyForTheRigs0AAAAAAAAAAAAAAAAAA StakedKeyForTheRigsOAAAAAAAAAAAAAAAAAA
  StakedKeyForTheRigsIAAAAAAAAAAAAAAAAAA StakedKeyForTheRigslAAAAAAAAAAAAAAAAAA
  '../../../../tmp/x' '"StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA\n"'
)

case_off_bad_identity() {
  local n=0 bad mode url
  for mode in alpenglow towerbft; do
    for bad in "${BAD_IDENTITIES[@]}"; do
      n=$((n + 1))
      begin "off_bad_identity_$n" "$1"
      inventory agave agave "$STAKED" 10.9.9.9 "$bad"
      box src src
      printf 'vote-history-initial\n' >"$(vote_file src)"
      printf 'tower-of-the-source\n' >"$(tower_file src)"
      if [[ $mode == alpenglow ]]; then url=$(alp); else url=$(tower); fi
      play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$url"
      refused src switch_off_identity "(32 to 44 characters of the base58 alphabet)" "switch_off refuses the identity_account $bad on $mode before it demotes anything"
      [[ $(count_calls src .) -eq 0 && ! -e $S/home/.slv/vote_history && ! -e $S/home/.slv/tower ]]
      check $? "nothing was waited for, demoted or copied ($mode, $bad)"
    done
  done
}

# the playbooks that build a path on the controller from identity_account refuse a value that is not a
# base58 public key before they build it: each family below, with every bad value
bad_identity_refused() { # playbook description-of-the-run: the play on dst stopped on the check and nothing ran on the host
  refused dst "$1" "(32 to 44 characters of the base58 alphabet)" "$2"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host ($2)"
}

case_key_bad_identity() {
  local n=0 bad mode url
  for mode in alpenglow towerbft; do
    for bad in "${BAD_IDENTITIES[@]}"; do
      n=$((n + 1))
      begin "key_bad_identity_$n" "$1"
      inventory agave agave "$bad"
      box dst dst
      printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
      if [[ $mode == alpenglow ]]; then url=$(alp); else url=$(tower); fi
      play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$url" -e "slv_target_rpc_url=$(local_rpc 2000)"
      bad_identity_refused set_identity_key "set_identity_key refuses the identity_account $bad on $mode"
    done
  done
}

case_active_bad_identity() {
  local n=0 bad
  for bad in "${BAD_IDENTITIES[@]}"; do
    n=$((n + 1))
    begin "active_bad_identity_$n" "$1"
    inventory agave agave "$bad"
    box dst dst
    play dst set_identity_to_active "-l dst -e on_host=dst" -e "slv_alpenglow_rpc_url=$(tower)"
    bad_identity_refused set_identity_to_active "set_identity_to_active refuses the identity_account $bad"
  done
}

case_off_fdctl_bad_identity() {
  local n=0 bad
  for bad in "${BAD_IDENTITIES[@]}"; do
    n=$((n + 1))
    begin "off_fdctl_bad_identity_$n" "$1"
    inventory firedancer-jito firedancer-jito "$STAKED" 10.9.9.9 "$bad"
    box src src
    printf 'tower-of-the-source\n' >"$(tower_file src)"
    play src switch_off_firedancer_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(tower)"
    refused src switch_off_firedancer_identity "(32 to 44 characters of the base58 alphabet)" "switch_off_firedancer_identity refuses the identity_account $bad"
    [[ $(count_calls src .) -eq 0 && ! -e $S/home/.slv/tower ]]
    check $? "nothing was waited for, demoted or fetched ($bad)"
  done
}

case_on_fdctl_bad_identity() {
  local n=0 bad
  for bad in "${BAD_IDENTITIES[@]}"; do
    n=$((n + 1))
    begin "on_fdctl_bad_identity_$n" "$1"
    inventory firedancer-jito firedancer-jito "$bad"
    box dst dst
    play dst switch_on_firedancer_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(tower)"
    bad_identity_refused switch_on_firedancer_identity "switch_on_firedancer_identity refuses the identity_account $bad"
  done
}

case_copy_keys_bad_identity() {
  local n=0 bad
  for bad in "${BAD_IDENTITIES[@]}"; do
    n=$((n + 1))
    begin "copy_keys_bad_identity_$n" "$1"
    inventory agave agave "$bad"
    box dst dst
    play dst copy_keys "-l dst"
    refused dst copy_keys "(32 to 44 characters of the base58 alphabet)" "copy_keys refuses the identity_account $bad"
    [[ ! -e $S/dst/solv/$NET-validator-keypair.json ]]
    check $? "no key file was copied ($bad)"
  done
}

case_copy_keys_ok() {
  begin copy_keys_ok "$1"
  inventory agave agave
  box dst dst
  play dst copy_keys "-l dst"
  ok dst copy_keys "copy_keys copies the key of a base58 identity_account"
  [[ $(cat "$S/dst/solv/$NET-validator-keypair.json" 2>/dev/null) == "[1,2,3]" && $(stat -c %a "$S/dst/solv/$NET-validator-keypair.json" 2>/dev/null) == 600 ]]
  check $? "the key file is on the host with the mode 0600"
}

case_off_towerbft() {
  begin off_towerbft "$1"
  inventory agave agave
  box src src
  printf 'tower-from-the-source\n' >"$(tower_file src)"
  play src switch_off_identity "-e off_host=src" -e "slv_alpenglow_rpc_url=$(tower)"
  ok src switch_off_identity "TowerBFT: the tower path is unchanged"
  [[ $(cat "$S/home/.slv/tower/tower-1_9-$STAKED.bin" 2>/dev/null) == tower-from-the-source && ! -e $S/home/.slv/vote_history ]]
  check $? "the tower file is fetched and no vote history is taken"
}

case_on_happy() {
  begin on_happy "$1"
  inventory agave agave
  box dst dst
  printf 'stale-vote-history\n' >"$(vote_file dst)"
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  ok dst switch_on_identity "switch_on puts the identity on the target"
  [[ $(count_calls dst 'set-identity') -eq 1 && $(count_calls dst require-tower) -eq 0 && $(count_calls dst 'authorized-voter add') -eq 1 ]]
  check $? "set-identity has no tower flag and the authorized voter is added"
  [[ $(cat "$S/dst/vh-content-at-set-identity" 2>/dev/null) == "$SOURCE_FILE_TEXT" ]]
  check $? "the vote history file agave found is the one from the source, not the stale one"
  [[ $(cat "$S/dst/vh-stat-at-set-identity" 2>/dev/null) == "644 $me $mygroup" ]]
  check $? "the uploaded file has the owner and mode agave gives it ($(cat "$S/dst/vh-stat-at-set-identity" 2>/dev/null))"
  [[ ! -e "$(copy_file)" ]]
  check $? "the copy is removed from the controller"
  [[ $(cat "$S/dst/identity") == "$STAKED" ]]
  check $? "the target runs the staked identity"
  log_has dst switch_on_identity "moved from 1000 to 1025 after dst took $STAKED"
  check $? "the play says the last vote of the vote account moved on the cluster ($(grep -o 'last vote of VOTEACCOUNT moved[^"]*' "$S/dst/switch_on_identity.log" | head -1))"
}

case_on_cluster_stuck() {
  begin on_cluster_stuck "$1"
  inventory agave agave
  box dst dst
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp /vote=current:1000)"
  refused dst switch_on_identity "did not move past 1000" "a last vote that does not move on the cluster fails the switch although the host writes its vote history"
  log_has dst switch_on_identity "is kept at"
  check $? "the message says where the copy is kept"
  [[ -e "$(copy_file)" ]]
  check $? "the copy is kept"
}

case_on_cluster_unread() {
  begin on_cluster_unread "$1"
  inventory agave agave
  box dst dst
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp /vote=error)"
  ok dst switch_on_identity "a cluster that cannot give the last vote does not stop a host that writes its vote history"
  log_has dst switch_on_identity "because the last vote before the change was not read"
  check $? "the play says the cluster was not asked"
  [[ ! -e "$(copy_file)" ]]
  check $? "the copy is removed"
}

case_on_no_copy() {
  begin on_no_copy "$1"
  inventory agave agave
  box dst dst
  printf 'stale-vote-history\n' >"$(vote_file dst)"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst switch_on_identity "does not exist on the controller" "switch_on refuses without the vote history file"
  log_has dst switch_on_identity "has not voted for 270 slots" && log_has dst switch_on_identity "slv v set:identity -p dst --primary-down"
  check $? "the message names the wait and the command that passes when the old primary is down"
  [[ $(count_calls dst .) -eq 0 && $(cat "$(vote_file dst)") == stale-vote-history ]]
  check $? "nothing was uploaded or set"
}

case_on_other_identity() {
  begin on_other_identity "$1"
  inventory agave agave AnotherKeyForTheRigsBBBBBBBBBBBBBBBBBB
  box dst dst
  prepare_copy "$SOURCE_FILE_TEXT"
  cp "$S/home/.slv/keys/$STAKED.json" "$S/home/.slv/keys/AnotherKeyForTheRigsBBBBBBBBBBBBBBBBBB.json"
  # the vote history file is named after the identity of the target here, which is not the one of the source
  cp "$(copy_file)" "$S/home/.slv/vote_history/vote_history-AnotherKeyForTheRigsBBBBBBBBBBBBBBBBBB.bin"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)" -e slv_alpenglow_demoted_source=src
  refused dst switch_on_identity "does not belong to it" "switch_on refuses an identity the source did not run"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was uploaded or set"
}

case_on_bad_identity() {
  local n=0 bad mode url
  for mode in alpenglow towerbft; do
    for bad in "${BAD_IDENTITIES[@]}"; do
      n=$((n + 1))
      begin "on_bad_identity_$n" "$1"
      inventory agave agave "$bad"
      box dst dst
      prepare_copy "$SOURCE_FILE_TEXT"
      if [[ $mode == alpenglow ]]; then url=$(alp); else url=$(tower); fi
      play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$url"
      refused dst switch_on_identity "(32 to 44 characters of the base58 alphabet)" "switch_on refuses the identity_account $bad on $mode"
      [[ $(count_calls dst .) -eq 0 && -e "$(copy_file)" ]]
      check $? "nothing was uploaded or set, and the copy is untouched ($mode, $bad)"
    done
  done
}

case_on_voter_present() {
  begin on_voter_present "$1"
  inventory agave agave
  box dst dst ADD_VOTER=present
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  ok dst switch_on_identity "an authorized voter that is already present is fine"
}

case_on_voter_error() {
  begin on_voter_error "$1"
  inventory agave agave
  box dst dst ADD_VOTER=error
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst switch_on_identity "Failed to read authorized voter keypair" "an authorized voter that cannot be added fails the switch"
  log_has dst switch_on_identity "is kept at"
  check $? "the message says where the copy is kept"
  [[ -e "$(copy_file)" && $(stat -c %a "$(copy_file)") == 600 && $(stat -c %a "$S/home/.slv/vote_history") == 700 ]]
  check $? "the copy stays, readable by its owner only"
}

case_on_not_voting() {
  begin on_not_voting "$1"
  inventory agave agave
  box dst dst TARGET_VOTES=0
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst switch_on_identity "is not voting yet" "a target that does not vote fails the switch"
  [[ -e "$(copy_file)" ]]
  check $? "the copy is kept"
}

case_on_fdctl() {
  begin on_fdctl "$1"
  inventory firedancer-jito firedancer-jito
  box dst dst
  prepare_copy "$SOURCE_FILE_TEXT"
  play dst switch_on_firedancer_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst switch_on_firedancer_identity "cannot move an identity on a cluster that runs Alpenglow" "a Firedancer host is not switched on on Alpenglow"
  [[ $(count_calls dst .) -eq 0 && -e "$(copy_file)" ]]
  check $? "nothing was run on the host and the copy is untouched"
}

case_on_towerbft() {
  begin on_towerbft "$1"
  inventory agave agave
  box dst dst ADD_VOTER=present GATE=0
  mkdir -p "$S/home/.slv/tower"
  printf 'tower-from-the-source\n' >"$S/home/.slv/tower/tower-1_9-$STAKED.bin"
  play dst switch_on_identity "-e on_host=dst" -e "slv_alpenglow_rpc_url=$(tower)"
  ok dst switch_on_identity "TowerBFT: the tower path is unchanged (an authorized voter that is already there is not an error)"
  [[ $(count_calls dst 'set-identity --require-tower') -eq 1 && $(cat "$(tower_file dst)") == tower-from-the-source ]]
  check $? "set-identity has --require-tower and the tower file was uploaded"
}

# set_identity_key on a target: id, file state, and the options
key_target() { # name [knobs]
  inventory agave agave
  box dst dst "$@"
}

case_key_file_present() {
  begin key_file_present "$1"
  key_target dst TARGET_VOTES=1
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  printf 'old-tower\n' >"$(tower_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)" -e "slv_target_rpc_url=$(local_rpc 2000)"
  ok dst set_identity_key "the vote history file is enough when nothing votes with the identity and the host has caught up"
  [[ $(count_calls dst 'set-identity') -eq 1 && $(count_calls dst require-tower) -eq 0 && $(count_calls dst do-not-require-vote-history) -eq 0 && $(count_calls dst 'authorized-voter add') -eq 1 ]]
  check $? "set-identity has no flag at all, a tower file notwithstanding, and the authorized voter is added"
}

case_key_cluster_stuck() {
  begin key_cluster_stuck "$1"
  key_target
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp /vote=current:1000)" -e "slv_target_rpc_url=$(local_rpc 2000)"
  refused dst set_identity_key "did not move past 1000" "a last vote that does not move on the cluster fails set:identity on Alpenglow"
}

case_key_file_absent() {
  begin key_file_absent "$1"
  key_target
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst set_identity_key "--primary-down" "no vote history file and no confirmation: refused, and the way out is named"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run"
}

case_key_tower_only() {
  begin key_tower_only "$1"
  key_target
  printf 'old-tower\n' >"$(tower_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst set_identity_key "vote_history-$STAKED.bin" "a tower file does not stand in for the vote history file"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run"
}

case_key_first_activation() {
  begin key_first_activation "$1"
  key_target GATE=0
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)" -e '{"first_activation": true}'
  ok dst set_identity_key "an identity that never voted needs no file"
  [[ $(count_calls dst do-not-require-vote-history) -eq 0 && $(count_calls dst require-tower) -eq 0 ]]
  check $? "set-identity has no flag"
}

dead() { # nodes vote [current slot of the cluster]
  echo "$(alp "/nodes=$1/vote=$2/now=${3:-2000}")"
}

case_key_dead_ok() {
  begin key_dead_ok "$1"
  key_target
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead none current:1000:2)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e '{"primary_down_confirmed": true}'
  ok dst set_identity_key "a confirmed dead primary: the checks pass and the file is done without"
  [[ $(count_calls dst 'set-identity --do-not-require-vote-history') -eq 1 && $(count_calls dst require-tower) -eq 0 ]]
  check $? "set-identity has --do-not-require-vote-history and no --require-tower"
}

case_key_dead_ok_string() {
  begin key_dead_ok_string "$1"
  key_target
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead none current:1000:2)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  ok dst set_identity_key "primary_down_confirmed=true as text works too"
  [[ $(count_calls dst 'set-identity --do-not-require-vote-history') -eq 1 ]]
  check $? "set-identity has --do-not-require-vote-history"
}

case_key_dead_target_address() {
  begin key_dead_target_address "$1"
  key_target
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead target current:1000:2)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  ok dst set_identity_key "the identity in gossip at the address of the target itself is fine"
}

case_key_dead_delinquent() {
  begin key_dead_delinquent "$1"
  key_target
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead none delinquent:1000:2)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  ok dst set_identity_key "a delinquent vote account is read too"
}

dead_run() { # id nodes vote slot [extra ansible args...]: a host without the file, the old primary confirmed down
  local id=$1 nodes=$2 vote=$3 slot=$4
  shift 4
  begin "$id" "$NET"
  key_target
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead "$nodes" "$vote")" -e "slv_target_rpc_url=$(local_rpc "$slot")" -e primary_down_confirmed=true "$@"
}
dead_refused() { # id nodes vote slot text description [extra ansible args...]
  local id=$1 nodes=$2 vote=$3 slot=$4 text=$5 description=$6
  shift 6
  dead_run "$id" "$nodes" "$vote" "$slot" "$@"
  refused dst set_identity_key "$text" "$description"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host"
}

case_key_dead_gossip() { dead_refused key_dead_gossip other current:1000 1300 "is in gossip at 10.1.1.1" "the identity in gossip at another address stops dead primary mode"; }
case_key_dead_gossip_both() { dead_refused key_dead_gossip_both both current:1000 1300 "is in gossip at 10.1.1.1" "the identity at the target and at another address stops dead primary mode"; }
case_key_dead_slot_equal() { dead_refused key_dead_slot_equal none current:1000 1000 "slots past the last vote 1000" "a finalized slot equal to the last vote is not past it"; }
case_key_dead_slot_behind() { dead_refused key_dead_slot_behind none current:1000 900 "slots past the last vote 1000" "a finalized slot behind the last vote is not past it"; }
case_key_dead_slot_short() { dead_refused key_dead_slot_short none current:1000 1100 "slots past the last vote 1000" "a finalized slot only 100 past the last vote is not 270 slots past it"; }
case_key_dead_vote_missing() { dead_refused key_dead_vote_missing none missing 1300 "does not list the vote account VOTEACCOUNT" "a vote account the cluster does not list stops dead primary mode"; }
case_key_dead_nodes_error() { dead_refused key_dead_nodes_error error current:1000 1300 "did not give a readable list of nodes" "an unreadable list of nodes stops dead primary mode"; }
case_key_dead_votes_error() { dead_refused key_dead_votes_error none error 1300 "did not give a readable answer to getVoteAccounts" "unreadable vote accounts stop dead primary mode"; }
case_key_dead_slot_error() { dead_refused key_dead_slot_error none current:1000 error "RPC of this host did not answer getSlot" "an unreadable slot stops dead primary mode"; }
case_key_dead_slot_garbage() { dead_refused key_dead_slot_garbage none current:1000 garbage "RPC of this host did not answer getSlot" "a slot that is not JSON stops dead primary mode"; }
case_key_dead_voting() { dead_refused key_dead_voting none current:1900:2 2300 "may still be voting with the identity" "a vote account that voted 100 slots before the current slot stops dead primary mode, however far the host has caught up"; }

case_key_dead_hostname() {
  begin key_dead_hostname "$1"
  inventory agave agave StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA target.invalid
  box dst dst
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead none current:1000)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  refused dst set_identity_key "is not an IP address and does not resolve to one" "an address that is neither an IP nor a name that resolves stops dead primary mode"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host"
}

case_key_dead_two_hosts() {
  begin key_dead_two_hosts "$1"
  key_target
  play dst set_identity_key "-l all" -e "slv_alpenglow_rpc_url=$(dead none current:1000)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  refused dst set_identity_key "applies to the one host that takes the identity" "dead primary mode does not run on more than one host"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host"
}

case_key_dead_with_file() {
  begin key_dead_with_file "$1"
  key_target
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead none current:1000:2)" -e "slv_target_rpc_url=$(local_rpc 1)" -e primary_down_confirmed=true
  refused dst set_identity_key "slots past the last vote 1000" "with the file there, a finalized slot that is not 270 past the last vote still stops the run"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host"
}

case_key_dead_with_file_ok() {
  begin key_dead_with_file_ok "$1"
  key_target
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(dead none current:1000:2)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  ok dst set_identity_key "with the file there, a confirmed dead primary needs the same checks and then goes on with the file"
  [[ $(count_calls dst 'set-identity') -eq 1 && $(count_calls dst do-not-require-vote-history) -eq 0 ]]
  check $? "set-identity has no --do-not-require-vote-history"
  grep "case=$ID" "$work/stub.log" >"$S/stub-requests" || true
  grep -q getClusterNodes "$S/stub-requests"
  check $? "gossip was read"
}

case_key_dead_first_activation() {
  begin key_dead_first_activation "$1"
  key_target GATE=0
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)" -e "slv_target_rpc_url=$(local_rpc 1)" -e primary_down_confirmed=true -e '{"first_activation": true}'
  ok dst set_identity_key "first_activation needs neither the file nor the checks"
  [[ $(count_calls dst do-not-require-vote-history) -eq 0 ]]
  check $? "set-identity has no --do-not-require-vote-history"
}

# the old primary's entry stays in gossip after it stopped: the address named down is allowed, and only
# while nothing votes
case_key_dead_down_address_ok() {
  dead_run key_dead_down_address_ok other current:1000:2 1300 -e primary_down_address=10.1.1.1
  ok dst set_identity_key "the entry of the old primary that stays in gossip is allowed at the address named down once nothing votes"
  [[ $(count_calls dst 'set-identity --do-not-require-vote-history') -eq 1 ]]
  check $? "set-identity has --do-not-require-vote-history"
}
case_key_dead_down_address_voting() { dead_refused key_dead_down_address_voting other current:1900:2 2300 "may still be voting with the identity" "the same with a last vote 100 slots before the current slot stops the run" -e primary_down_address=10.1.1.1; }
case_key_dead_third_address() { dead_refused key_dead_third_address other/other=10.2.2.2 current:1000 1300 "is in gossip at 10.2.2.2" "an entry at a third address stops the run" -e primary_down_address=10.1.1.1; }
case_key_dead_down_and_third() { dead_refused key_dead_down_and_third other/also=10.2.2.2 current:1000 1300 "is in gossip at 10.2.2.2, not at the address of this host" "the address named down does not allow an entry at a third address" -e primary_down_address=10.1.1.1; }

case_key_dead_hostname_resolves() {
  begin key_dead_hostname_resolves "$1"
  inventory agave agave "$STAKED" localhost
  box dst dst
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp /nodes=target/ip=127.0.0.1/vote=current:1000:2/now=2000)" -e "slv_target_rpc_url=$(local_rpc 1300)" -e primary_down_confirmed=true
  ok dst set_identity_key "an ansible_host that is a name is compared by the addresses it resolves to"
}

# the file is there: the checks apply all the same
file_run() { # id options-of-the-cluster-url finalized-slot [extra ansible args...]
  local id=$1 options=$2 slot=$3
  shift 3
  begin "$id" "$NET"
  key_target
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp "$options")" -e "slv_target_rpc_url=$(local_rpc "$slot")" "$@"
}
file_refused() { # id options-of-the-cluster-url finalized-slot text description [extra ansible args...]
  local id=$1 options=$2 slot=$3 text=$4 description=$5
  shift 5
  file_run "$id" "$options" "$slot" "$@"
  refused dst set_identity_key "$text" "$description"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host"
}
case_key_file_voting() { file_refused key_file_voting /vote=current:1900:25/now=2000 2300 "may still be voting with the identity" "a vote account that voted 100 slots before the current slot stops set:identity although the file is there"; }
case_key_file_behind() { file_refused key_file_behind /vote=current:1000:25/now=2000 1200 "slots past the last vote 1000" "a host whose finalized slot is not 270 past the last vote stops set:identity although the file is there"; }
case_key_file_slot_error() { file_refused key_file_slot_error /vote=current:1000:25/now=2000 error "RPC of this host did not answer getSlot" "a host that does not answer getSlot stops set:identity although the file is there"; }
case_key_file_votes_error() { file_refused key_file_votes_error /vote=error/now=2000 2300 "did not give a readable answer to getVoteAccounts" "a cluster that does not give the last vote stops set:identity although the file is there"; }
case_key_file_now_error() { file_refused key_file_now_error /vote=current:1000:25/now=error 2300 "the cluster did not answer getSlot" "a cluster that does not give its current slot stops set:identity although the file is there"; }
case_key_file_edge_now() { file_refused key_file_edge_now /vote=current:1000:25/now=1270 1300 "may still be voting with the identity" "a last vote exactly 270 slots before the current slot is not older than the window"; }
case_key_file_edge_slot() { file_refused key_file_edge_slot /vote=current:1000:25/now=2000 1269 "slots past the last vote 1000" "a finalized slot 269 past the last vote is not 270 past it"; }
case_key_file_edge_ok() {
  file_run key_file_edge_ok /vote=current:1000:25/now=1271 1270
  ok dst set_identity_key "a last vote 271 slots before the current slot and a finalized slot 270 past it are enough"
  [[ $(count_calls dst 'set-identity') -eq 1 && $(count_calls dst do-not-require-vote-history) -eq 0 ]]
  check $? "set-identity has no vote history flag"
}

# primary_down_address without primary_down_confirmed (the CLI passes it for a peer that reads as stopped)
case_key_file_down_address_ok() {
  file_run key_file_down_address_ok /nodes=other/vote=current:1000:25/now=2000 2000 -e primary_down_address=10.1.1.1
  ok dst set_identity_key "the entry of a stopped node at the address named down does not stop set:identity when nothing votes"
  [[ $(count_calls dst 'set-identity') -eq 1 && $(count_calls dst do-not-require-vote-history) -eq 0 ]]
  check $? "set-identity has no vote history flag: the file is there and nobody confirmed the old primary down"
}
# gossip is read on a plain run too: the host's own address and primary_down_address are the only ones allowed
case_key_file_foreign_entry() { file_refused key_file_foreign_entry /nodes=other/vote=current:1000:25/now=2000 2000 "is in gossip at 10.1.1.1" "an entry of the identity at another address stops a plain set:identity, with the file there and nothing voting"; }
case_key_file_gossip_own_address() {
  file_run key_file_gossip_own_address /nodes=target/vote=current:1000:25/now=2000 2000
  ok dst set_identity_key "an entry of the identity at the address of the host itself is fine"
  [[ $(count_calls dst 'set-identity') -eq 1 && $(count_calls dst do-not-require-vote-history) -eq 0 ]]
  check $? "set-identity has no vote history flag"
  grep "case=$ID" "$work/stub.log" >"$S/stub-requests" || true
  grep -q getClusterNodes "$S/stub-requests"
  check $? "gossip was read on a run without primary_down_confirmed and without primary_down_address"
}
# the host already runs the identity and votes with it: the refusal says what the operator sees
case_key_file_self_voting() {
  file_refused key_file_self_voting /nodes=target/vote=current:1900:25/now=2000 2300 "If dst already runs it (ask its own RPC with getIdentity), there is nothing to set: check that before you run this again" "a host that already votes with the identity is refused, and the message tells to look at the identity it runs"
  log_has dst set_identity_key "the identity voted 100 slots ago"
  check $? "the message says how long ago the identity voted"
}
case_key_file_down_address_voting() { file_refused key_file_down_address_voting /nodes=other/vote=current:1900:25/now=2000 2300 "may still be voting with the identity" "the entry at the address named down is allowed only while nothing votes" -e primary_down_address=10.1.1.1; }
case_key_file_third_address() { file_refused key_file_third_address /nodes=other/other=10.2.2.2/vote=current:1000:25/now=2000 2000 "is in gossip at 10.2.2.2" "an entry at an address that is not the one named down stops the run" -e primary_down_address=10.1.1.1; }

case_key_voter_error() {
  begin key_voter_error "$1"
  key_target ADD_VOTER=error
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)" -e "slv_target_rpc_url=$(local_rpc 2000)"
  refused dst set_identity_key "Failed to read authorized voter keypair" "an authorized voter that cannot be added fails set:identity on Alpenglow"
}

case_key_voter_present() {
  begin key_voter_present "$1"
  key_target ADD_VOTER=present
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)" -e "slv_target_rpc_url=$(local_rpc 2000)"
  ok dst set_identity_key "an authorized voter that is already there is fine"
}

case_key_not_voting() {
  begin key_not_voting "$1"
  key_target TARGET_VOTES=0
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)" -e "slv_target_rpc_url=$(local_rpc 2000)"
  refused dst set_identity_key "is not voting yet" "a host that does not vote fails set:identity on Alpenglow"
}

case_key_fdctl() {
  begin key_fdctl "$1"
  inventory firedancer-jito firedancer-jito
  box dst dst
  printf 'vote-history-of-the-primary\n' >"$(vote_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused dst set_identity_key "cannot move an identity on a cluster that runs Alpenglow" "a Firedancer host is refused by set:identity on Alpenglow"
  [[ $(count_calls dst .) -eq 0 ]]
  check $? "nothing was run on the host"
}

case_key_towerbft() {
  begin key_towerbft "$1"
  key_target ADD_VOTER=present GATE=0
  printf 'old-tower\n' >"$(tower_file dst)"
  play dst set_identity_key "-l dst" -e "slv_alpenglow_rpc_url=$(tower)" -e primary_down_confirmed=true
  ok dst set_identity_key "TowerBFT: the tower is enough"
  [[ $(count_calls dst 'set-identity --require-tower') -eq 1 && $(count_calls dst do-not-require-vote-history) -eq 0 ]]
  check $? "set-identity has --require-tower and no vote history flag, whatever primary_down_confirmed says"
}

# nodowntime_migrate on one file system
case_mig_happy() {
  begin mig_happy "$1"
  inventory agave agave
  box both both VOTOR_DELAY=2
  printf 'vote-history-initial\n' >"$(vote_file both)"
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  ok both nodowntime_migrate "a migrate run on Alpenglow goes through"
  [[ $(count_calls both 'set-identity') -eq 2 && $(count_calls both require-tower) -eq 0 && $(count_calls both 'authorized-voter add') -eq 1 ]]
  check $? "the source is demoted, the target gets the identity without a tower flag and the voter is added"
  [[ ! -e "$(copy_file)" && $(cat "$S/both/identity") == "$STAKED" ]]
  check $? "the controller copy is gone and the identity runs"
  log_has both nodowntime_migrate "moved from 1000 to 1025 after dst took $STAKED"
  check $? "the play says the last vote of the vote account moved on the cluster"
}

case_mig_identity() {
  begin mig_identity "$1"
  inventory agave agave AnotherKeyForTheRigsBBBBBBBBBBBBBBBBBB
  box both both
  printf 'vote-history-initial\n' >"$(vote_file both)"
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused both nodowntime_migrate "have to carry the same identity_account" "a source and a target with different identities stop the run on Alpenglow"
  [[ $(count_calls both .) -eq 0 ]]
  check $? "nothing was run"
}

case_mig_fdctl_source() {
  begin mig_fdctl_source "$1"
  inventory firedancer-jito agave
  box both both
  printf 'vote-history-initial\n' >"$(vote_file both)"
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused both nodowntime_migrate "cannot move an identity on a cluster that runs Alpenglow" "a Firedancer source stops the run on Alpenglow"
  [[ $(count_calls both .) -eq 0 ]]
  check $? "nothing was run"
}

case_mig_fdctl_target() {
  begin mig_fdctl_target "$1"
  inventory agave firedancer-jito
  box both both
  printf 'vote-history-initial\n' >"$(vote_file both)"
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$(alp)"
  refused both nodowntime_migrate "cannot move an identity on a cluster that runs Alpenglow" "a Firedancer target stops the run on Alpenglow"
  [[ $(count_calls both .) -eq 0 ]]
  check $? "nothing was run"
}

case_mig_unknown_after_take() {
  begin mig_unknown_after_take "$1"
  inventory agave agave
  box both both VOTOR_DELAY=1
  printf 'vote-history-initial\n' >"$(vote_file both)"
  # probes: the start of the run, the start of switch_off, right before the demotion, the start of switch_on
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/aflip-3/case=$ID"
  refused both nodowntime_migrate "are both unstaked now" "a switch_on that refuses after the demotion says both nodes are unstaked"
  log_has both nodowntime_migrate "vote history file taken from src is at ~/.slv/vote_history/vote_history-$STAKED.bin"
  check $? "the message says where the vote history file is"
  log_has both nodowntime_migrate "has not voted for 270 slots" && log_has both nodowntime_migrate "run slv v set:identity -p dst."
  check $? "the message names the wait and the command"
  [[ $(count_calls both 'set-identity') -eq 1 && -e "$(copy_file)" && $(stat -c %a "$(copy_file)") == 600 ]]
  check $? "only the demotion ran and the copy is kept, readable by its owner only"
}


# --- 6. the cluster is out of reach after a demotion -------------------------

tower_migrate_box() { # source type, target type
  inventory "$1" "$2"
  box both both GATE=0
  printf 'tower-of-the-source\n' >"$(tower_file both)"
}
case_mig_hiccup_clears() {
  begin mig_hiccup_clears "$1"
  tower_migrate_box agave agave
  # 6 requests in a row are not answered, more than the 3 attempts of a call before a demotion
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/hiccup-3-6/case=$ID"
  ok both nodowntime_migrate "an outage of the cluster RPC right after the demotion is waited out and the run goes through"
  [[ $(count_calls both 'set-identity') -eq 2 && $(count_calls both 'set-identity --require-tower') -eq 1 && $(count_calls both 'authorized-voter add') -eq 1 ]]
  check $? "the source is demoted and the target takes the identity with the tower"
  ! log_has both nodowntime_migrate "takes the identity with the tower now"
  check $? "the play does not say it went on without a reading"
}

case_mig_hiccup_before() {
  begin mig_hiccup_before "$1"
  tower_migrate_box agave agave
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/hiccup-0-6/case=$ID"
  refused both nodowntime_migrate "its state cannot be read" "before a demotion the same outage stops the run, with the 3 attempts of a call"
  [[ $(count_calls both .) -eq 0 ]]
  check $? "nothing was run"
}

case_mig_down_after_demotion() {
  begin mig_down_after_demotion "$1"
  tower_migrate_box agave agave
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/hiccup-3-999999/case=$ID" \
    -e slv_alpenglow_patience_seconds=3 -e slv_alpenglow_rpc_delay=1
  ok both nodowntime_migrate "a cluster that stays out of reach after the demotion does not leave both nodes unstaked"
  [[ $(count_calls both 'set-identity') -eq 2 && $(count_calls both 'set-identity --require-tower') -eq 1 && $(count_calls both 'authorized-voter add') -eq 1 ]]
  check $? "the target takes the identity with the tower"
  log_has both nodowntime_migrate "The cluster could not be read for 3 seconds after src was switched to its unstaked identity"
  check $? "the play says it went on without a reading"
  log_has both nodowntime_migrate "had no Alpenglow feature account then" && ! log_has both nodowntime_migrate "takes at least"
  check $? "with no feature account the play does not say that an activation takes time to start"
  [[ ! -e "$S/home/.slv/vote_history" ]]
  check $? "no vote history file was taken: this is the TowerBFT path"
}

case_mig_down_after_demotion_pending() {
  begin mig_down_after_demotion_pending "$1"
  tower_migrate_box agave agave
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/phiccup-3-999999/case=$ID" \
    -e slv_alpenglow_patience_seconds=3 -e slv_alpenglow_rpc_delay=1
  ok both nodowntime_migrate "a cluster that stays out of reach after the demotion does not leave both nodes unstaked, with the feature account pending"
  log_has both nodowntime_migrate "an activation of Alpenglow takes at least" && ! log_has both nodowntime_migrate "had no Alpenglow feature account then"
  check $? "with a pending feature account the play says how long an activation takes to start"
  [[ $(count_calls both 'set-identity') -eq 2 && $(count_calls both 'set-identity --require-tower') -eq 1 ]]
  check $? "the target takes the identity with the tower"
}

case_mig_alpenglow_down_after_demotion() {
  begin mig_alpenglow_down_after_demotion "$1"
  inventory agave agave
  box both both VOTOR_DELAY=2
  printf 'vote-history-initial\n' >"$(vote_file both)"
  # the cluster ran Alpenglow right before the demotion and stays out of reach after it
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/ahiccup-3-999999/case=$ID" \
    -e slv_alpenglow_patience_seconds=3 -e slv_alpenglow_rpc_delay=1
  ok both nodowntime_migrate "a cluster that stays out of reach after an Alpenglow demotion does not leave both nodes unstaked"
  [[ $(count_calls both 'set-identity') -eq 2 && $(count_calls both require-tower) -eq 0 && $(count_calls both 'authorized-voter add') -eq 1 ]]
  check $? "the target takes the identity with the vote history file, without a tower flag"
  log_has both nodowntime_migrate "The cluster could not be read for 3 seconds after src was switched to its unstaked identity"
  check $? "the play says it went on without a reading"
  log_has both nodowntime_migrate "takes the identity with the vote history file now"
  check $? "the play says it went on with the vote history file"
  [[ ! -e "$(copy_file)" && $(cat "$S/both/identity") == "$STAKED" ]]
  check $? "the controller copy is gone and the identity runs"
}

case_mig_down_too_long() {
  begin mig_down_too_long "$1"
  tower_migrate_box agave agave
  # half of 2 slots of 0.4 seconds is 0.4 seconds, less than the patience of the probe alone
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/hiccup-3-999999/case=$ID" \
    -e slv_alpenglow_patience_seconds=3 -e slv_alpenglow_rpc_delay=1 -e slv_alpenglow_margin_slots=2
  refused both nodowntime_migrate "are both unstaked now" "a run that is older than half of the margin does not go on without a reading"
  [[ $(count_calls both 'set-identity') -eq 1 && -e "$S/home/.slv/tower/tower-1_9-$STAKED.bin" ]]
  check $? "only the demotion ran, and the tower is on the controller"
  ! log_has both nodowntime_migrate "takes the identity with the tower now"
  check $? "the play does not say it went on"
}

case_mig_alpenglow_after_demotion() {
  begin mig_alpenglow_after_demotion "$1"
  tower_migrate_box agave agave
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/tflip-3/case=$ID"
  refused both nodowntime_migrate "are both unstaked now" "a cluster that turned Alpenglow after the demotion stops the promotion"
  log_has both nodowntime_migrate "Promote $STAKED on dst yourself"
  check $? "the message tells to promote the identity by hand, without waiting for a certificate that is already there"
  ! log_has both nodowntime_migrate "Wait until getAgGenesisCert returns a certificate"
  check $? "the message does not tell to wait for the certificate"
  log_has both nodowntime_migrate "left no vote history file on the controller" && log_has both nodowntime_migrate "slv v set:identity -p dst --primary-down"
  check $? "the message names the command for a source that was demoted on TowerBFT: there is no vote history file to carry"
  [[ $(count_calls both 'set-identity') -eq 1 ]]
  check $? "only the demotion ran"
}

case_mig_down_fdctl() {
  begin mig_down_fdctl "$1"
  [[ $1 == mainnet ]] && return 0 # mainnet does not let a Firedancer host take an identity
  tower_migrate_box firedancer-jito firedancer-jito
  play both nodowntime_migrate "-e source_host=src -e target_host=dst" -e "slv_alpenglow_rpc_url=$rpc/hiccup-3-999999/case=$ID" \
    -e slv_alpenglow_patience_seconds=3 -e slv_alpenglow_rpc_delay=1
  ok both nodowntime_migrate "a Firedancer promotion goes on after the demotion although the cluster stays out of reach"
  [[ $(count_calls both 'sudo fdctl set-identity') -eq 2 && $(count_calls both 'sudo fdctl set-identity .*--require-tower') -eq 1 ]]
  check $? "the target takes the identity with the tower"
  log_has both nodowntime_migrate "The cluster could not be read for 3 seconds after src was switched to its unstaked identity"
  check $? "the play says it went on without a reading"
}

cases=(
  off_happy off_no_file off_silent_votor off_churning off_mode_changes off_window_opens off_fdctl off_towerbft off_bad_identity
  on_happy on_cluster_stuck on_cluster_unread on_no_copy on_other_identity on_voter_present on_voter_error on_not_voting
  on_fdctl on_towerbft on_bad_identity
  key_bad_identity active_bad_identity off_fdctl_bad_identity on_fdctl_bad_identity copy_keys_bad_identity copy_keys_ok
  key_file_present key_cluster_stuck key_file_absent key_tower_only key_first_activation key_dead_ok key_dead_ok_string
  key_dead_target_address key_dead_delinquent key_dead_gossip key_dead_gossip_both key_dead_slot_equal
  key_dead_slot_behind key_dead_slot_short key_dead_vote_missing key_dead_nodes_error key_dead_votes_error key_dead_slot_error
  key_dead_slot_garbage key_dead_voting key_dead_hostname key_dead_hostname_resolves key_dead_two_hosts key_dead_with_file
  key_dead_with_file_ok key_dead_first_activation key_dead_down_address_ok key_dead_down_address_voting
  key_dead_third_address key_dead_down_and_third
  key_file_voting key_file_behind key_file_slot_error key_file_votes_error key_file_now_error key_file_edge_now
  key_file_edge_slot key_file_edge_ok key_file_down_address_ok key_file_down_address_voting key_file_third_address
  key_file_foreign_entry key_file_gossip_own_address key_file_self_voting
  key_voter_error key_voter_present key_not_voting key_fdctl key_towerbft
  mig_happy mig_identity mig_fdctl_source mig_fdctl_target mig_unknown_after_take
  mig_hiccup_clears mig_hiccup_before mig_down_after_demotion mig_down_after_demotion_pending mig_down_too_long
  mig_alpenglow_after_demotion mig_down_fdctl
  mig_alpenglow_down_after_demotion
)

# SLV_TEST_ONLY="off_happy on_happy" runs only those cases, SLV_TEST_NETWORKS=testnet only that network
for network in ${SLV_TEST_NETWORKS:-mainnet testnet}; do
  for name in "${cases[@]}"; do
    if [[ -n ${SLV_TEST_ONLY:-} && " $SLV_TEST_ONLY " != *" $name "* ]]; then continue; fi
    (
      NET=$network
      "case_$name" "$network"
    ) >"$work/out-$network-$name.log" 2>&1 &
    while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
  done
done
wait

failures=0
checked=0
for results in "$work"/s/*/results; do
  while IFS= read -r line; do
    checked=$((checked + 1))
    if [[ $line == FAIL* ]]; then
      failures=$((failures + 1))
      echo "$line (${results#"$work"/s/})" >&2
    fi
  done <"$results"
done
for refusal in "$work"/s/*/refused; do
  [[ -e $refusal ]] && {
    failures=$((failures + 1))
    echo "FAIL $(cat "$refusal")" >&2
  }
done
((checked > 0)) || {
  echo "alpenglow vote history: no check ran" >&2
  exit 1
}
if ((failures > 0)); then
  echo "alpenglow vote history: $failures failure(s) in $checked checks" >&2
  exit 1
fi
echo "alpenglow vote history: PASS ($checked checks)"
