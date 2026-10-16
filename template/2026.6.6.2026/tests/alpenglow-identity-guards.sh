#!/usr/bin/env bash
# Behaviour test for the Alpenglow state probe and the identity guards (no network
# or host access). Needs ansible-playbook and python3 on PATH:
#   bash template/2026.6.6.2026/tests/alpenglow-identity-guards.sh
#
# A stub RPC (alpenglow_stub_rpc.py) answers for the cluster. Each identity case
# runs a real playbook on a local connection against fake agave-validator, fdctl,
# sudo and systemctl commands that only write down what they were asked, with the
# paths of the host moved into a temporary directory. A case "runs" when the play
# succeeds and the fake set-identity was called; it is "refused" when the play fails
# before any identity call and before it touched a file.
#
#   1. the probe (cmn/tasks/alpenglow_state.yml) sets slv_alpenglow_state to towerbft,
#      window, alpenglow or unknown, and never prints the RPC URL
#   2. window and unknown stop every identity change, on both networks, with one message
#   3. alpenglow still stops a switch (the vote history path is not there yet) and
#      stops nothing else
#   4. mainnet: Firedancer and Frankendancer never take an identity, in any state, and
#      nodowntime_migrate says so before it demotes the source; as the source they go
#      on only while the state is towerbft
#   5. testnet: only window and unknown are new
#   6. init.yml: a host without a validator_type, or with one slv does not know, stops
#      the run before the first change instead of becoming a Frankendancer host
set -uo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
template="$root/template/2026.6.6.2026"
for tool in ansible-playbook python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool is required on PATH" >&2
    exit 2
  }
done

work=$(mktemp -d /tmp/slv-alpenglow-guards.XXXXXX)
stub_pid=
cleanup() {
  [[ -n $stub_pid ]] && kill "$stub_pid" 2>/dev/null
  if [[ -n ${SLV_TEST_KEEP:-} ]]; then
    echo "kept $work" >&2
  else
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT
mkdir -p "$work/runs" "$work/probe" "$work/tmp"
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

# `timeout` is not on every machine; a play that hangs should still end
if command -v timeout >/dev/null 2>&1; then
  limited() { timeout 300 "$@"; }
else
  limited() { "$@"; }
fi

failures=0
checked=0
fail() {
  failures=$((failures + 1))
  echo "FAIL $*" >&2
}
check() { # condition result (0 = holds), description
  checked=$((checked + 1))
  (($1 == 0)) || fail "$2"
}

# --- 1. the probe -----------------------------------------------------------

cat >"$work/inventory.yml" <<INV
all:
  hosts:
    rig:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
INV
cat >"$work/probe.yml" <<PLAY
---
- hosts: all
  gather_facts: false
  tasks:
    - ansible.builtin.import_tasks: $template/ansible/cmn/tasks/alpenglow_state.yml
      vars:
        slv_alpenglow_network: "{{ probe_network }}"
    - ansible.builtin.debug:
        msg: "RESULT state={{ slv_alpenglow_state }} detail={{ slv_alpenglow_detail }}"
PLAY

closed_port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')

# id|url path or full URL|network|expected state
probe_cases=(
  'towerbft|towerbft|mainnet|towerbft'
  'towerbft-pending|towerbft-pending|mainnet|towerbft'
  'window|window|mainnet|window'
  'alpenglow|alpenglow|mainnet|alpenglow'
  'testnet-alpenglow|alpenglow|testnet|alpenglow'
  'devnet-alpenglow|alpenglow|devnet|alpenglow'
  'http500|unknown-http500|mainnet|unknown'
  'rpc-error|unknown-rpc-error|mainnet|unknown'
  'garbage|unknown-garbage|mainnet|unknown'
  'string-result|unknown-string|mainnet|unknown'
  'empty-object|unknown-empty-object|mainnet|unknown'
  'feature-rpc-error|unknown-feature-rpc-error|mainnet|unknown'
  'feature-http500|unknown-feature-http500|mainnet|unknown'
  'feature-garbage|unknown-feature-garbage|mainnet|unknown'
  'feature-wrong-owner|unknown-feature-wrong-owner|mainnet|unknown'
  'feature-wrong-data|unknown-feature-wrong-data|mainnet|unknown'
  'feature-no-context|unknown-feature-no-context|mainnet|unknown'
  'flaky-window|flaky-window/probe|mainnet|window'
  'flaky-towerbft|flaky-towerbft/probe|mainnet|towerbft'
  'unreachable|URL=http://127.0.0.1:'"$closed_port"'/|mainnet|unknown'
  'no-such-scenario|nope|mainnet|unknown'
)

run_probe() { # id target network extra ansible args...
  local id=$1 target=$2 network=$3 url
  shift 3
  url=$rpc/$target
  [[ $target == URL=* ]] && url=${target#URL=}
  ANSIBLE_HOME="$work/probe/home-$id" limited ansible-playbook -i "$work/inventory.yml" "$work/probe.yml" \
    -e "slv_alpenglow_rpc_url=$url" -e slv_alpenglow_rpc_delay=0 -e "probe_network=$network" "$@" \
    >"$work/probe/$id.log" 2>&1 </dev/null
  echo $? >"$work/probe/$id.rc"
}

for entry in "${probe_cases[@]}"; do
  IFS='|' read -r id target network expected <<<"$entry"
  run_probe "$id" "$target" "$network" &
  while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
done
run_probe secret 'unknown-http500?api-key=SECRETKEY123' mainnet -vvv &
run_probe secret-ok 'window?api-key=SECRETKEY123' mainnet -vvv &
run_probe bad-network window foo &
run_probe empty-network window '' &
wait

for entry in "${probe_cases[@]}"; do
  IFS='|' read -r id target network expected <<<"$entry"
  log="$work/probe/$id.log"
  grep -q "RESULT state=$expected detail=" "$log" 2>/dev/null
  check $? "probe $id: the state is $expected ($(grep -o 'RESULT state=.*' "$log" 2>/dev/null | head -1))"
  grep -q '127\.0\.0\.1' "$log"
  check $((1 - $?)) "probe $id: the RPC URL is printed"
done

# the feature account is asked only when the certificate is null
count_calls() { grep -c "\"path\": \"/$1\", \"scenario\": \"[a-z-]*\", \"method\": \"$2\"" "$work/stub.log" || true; }
[[ $(count_calls alpenglow getAccountInfo) -eq 0 ]]
check $? "probe: a certificate settles the state without asking for the feature account"
[[ $(count_calls window getAccountInfo) -gt 0 ]]
check $? "probe: a null certificate sends the second question"

# a key in the URL stays out of every line, even at -vvv
grep -q SECRETKEY123 "$work/probe/secret.log" "$work/probe/secret-ok.log"
check $((1 - $?)) "probe: the key of the RPC URL is printed"
grep -q 'RESULT state=unknown' "$work/probe/secret.log"
check $? "probe: the -vvv run with a key reached the stub"
grep -q 'RESULT state=window' "$work/probe/secret-ok.log"
check $? "probe: the -vvv run with a key and a window answer"
for id in bad-network empty-network; do
  [[ $(cat "$work/probe/$id.rc") != 0 ]] && grep -q 'slv_alpenglow_network must be mainnet, testnet or devnet' "$work/probe/$id.log"
  check $? "probe $id: a network that is not mainnet, testnet or devnet stops the play"
done

# the public RPC of each network is the default
for url in https://api.mainnet-beta.solana.com https://api.testnet.solana.com https://api.devnet.solana.com; do
  grep -qF "$url" "$template/ansible/cmn/tasks/alpenglow_state.yml"
  check $? "probe: $url is the public RPC of its network"
done

# --- 2.-5. the identity playbooks -------------------------------------------

identity_playbooks=(switch_off_identity switch_off_firedancer_identity switch_on_identity
  switch_on_firedancer_identity set_identity_key set_unstaked_key set_identity_to_active
  nodowntime_migrate change_identity_and_restart)

# network|playbook|validator type (source>target for nodowntime_migrate)|outcome per state:
#   towerbft,window,unknown,alpenglow  with run, freeze, alpenglow or fdctl
cases=(
  'mainnet|switch_off_identity|agave|run,freeze,freeze,alpenglow'
  'mainnet|switch_off_firedancer_identity|firedancer-jito|run,freeze,freeze,alpenglow'
  'mainnet|switch_on_identity|agave|run,freeze,freeze,run'
  'mainnet|switch_on_firedancer_identity|firedancer-jito|fdctl,freeze,freeze,fdctl'
  'mainnet|set_identity_key|agave|run,freeze,freeze,run'
  'mainnet|set_identity_key|jito|run,freeze,freeze,run'
  'mainnet|set_identity_key|allnodes-jito|run,freeze,freeze,run'
  'mainnet|set_identity_key|firedancer-agave|fdctl,freeze,freeze,fdctl'
  'mainnet|set_identity_key|firedancer-jito|fdctl,freeze,freeze,fdctl'
  'mainnet|set_unstaked_key|agave|run,freeze,freeze,run'
  'mainnet|set_unstaked_key|firedancer-jito|run,freeze,freeze,run'
  'mainnet|set_identity_to_active|jito|run,freeze,freeze,run'
  'mainnet|set_identity_to_active|firedancer-jito|fdctl,freeze,freeze,fdctl'
  'mainnet|nodowntime_migrate|agave>agave|run,freeze,freeze,alpenglow'
  'mainnet|nodowntime_migrate|firedancer-jito>agave|run,freeze,freeze,alpenglow'
  'mainnet|nodowntime_migrate|agave>firedancer-jito|fdctl,freeze,freeze,fdctl'
  'mainnet|nodowntime_migrate|firedancer-agave>firedancer-jito|fdctl,freeze,freeze,fdctl'
  'testnet|switch_off_identity|agave|run,freeze,freeze,alpenglow'
  'testnet|switch_off_firedancer_identity|firedancer-jito|run,freeze,freeze,alpenglow'
  'testnet|switch_on_identity|agave|run,freeze,freeze,run'
  'testnet|switch_on_firedancer_identity|firedancer-jito|run,freeze,freeze,run'
  'testnet|set_identity_key|agave|run,freeze,freeze,run'
  'testnet|set_identity_key|firedancer-jito|run,freeze,freeze,run'
  'testnet|set_unstaked_key|agave|run,freeze,freeze,run'
  'testnet|set_unstaked_key|firedancer-jito|run,freeze,freeze,run'
  'testnet|set_identity_to_active|jito|run,freeze,freeze,run'
  'testnet|set_identity_to_active|firedancer-jito|run,freeze,freeze,run'
  'testnet|nodowntime_migrate|agave>agave|run,freeze,freeze,alpenglow'
  'testnet|nodowntime_migrate|firedancer-jito>firedancer-jito|run,freeze,freeze,alpenglow'
  'testnet|nodowntime_migrate|agave>firedancer-jito|run,freeze,freeze,alpenglow'
  'testnet|change_identity_and_restart|firedancer-jito|run,freeze,freeze,run'
)
states=(towerbft window unknown alpenglow)
scenario_of() {
  case $1 in
    towerbft) echo towerbft ;;
    window) echo window ;;
    unknown) echo unknown-http500 ;;
    alpenglow) echo alpenglow ;;
  esac
}

case_id() { # network playbook types state
  local types=${3//>/_to_}
  echo "$1__$2__${types}__$4"
}

run_case() { # network playbook types state
  local net=$1 play=$2 types=$3 state=$4
  local id run src dst
  id=$(case_id "$@")
  run="$work/runs/$id"
  src=${types%%>*}
  dst=${types##*>}
  mkdir -p "$run/bin" "$run/home/.slv/keys" "$run/home/.slv/tower" "$run/mnt/ledger" "$run/solv" \
    "$run/ansible/$net-validator" "$run/ansible/cmn/tasks"
  : >"$run/home/.profile"
  : >"$run/calls.log"
  printf '[1,2,3]' >"$run/home/.slv/keys/IDENTITYKEY.json"
  printf 'home-tower' >"$run/home/.slv/tower/tower-1_9-IDENTITYKEY.bin"
  case $play in
    switch_off_* | set_identity_key | nodowntime_migrate)
      printf 'ledger-tower' >"$run/mnt/ledger/tower-1_9-IDENTITYKEY.bin"
      ;;
  esac
  cp "$template/ansible/cmn/tasks/alpenglow_state.yml" "$run/ansible/cmn/tasks/"
  local file
  for file in "$template/ansible/$net-validator/"*.yml; do
    sed -e "s#/home/solv#$run/solv#g" -e "s#/mnt#$run/mnt#g" "$file" >"$run/ansible/$net-validator/$(basename "$file")"
  done
  if grep -Eq '(^|[^A-Za-z0-9_])/(home/solv|mnt)([^A-Za-z0-9_]|$)' "$run/ansible/$net-validator/"*.yml; then
    echo "a path of the real host is left in the playbooks of $net" >"$run/refused"
    echo 99 >"$run/rc"
    return 0
  fi
  local name
  for name in agave-validator fdctl sudo systemctl; do
    printf '#!/bin/bash\nstdin=0\n[ -t 0 ] || stdin=$(cat | wc -c)\necho "%s $* (stdin $stdin bytes)" >>"%s"\nexit 0\n' \
      "$name" "$run/calls.log" >"$run/bin/$name"
    chmod +x "$run/bin/$name"
  done
  cat >"$run/inventory.yml" <<INV
all:
  hosts:
    src:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
      identity_account: IDENTITYKEY
      vote_account: VOTE
      validator_type: $src
    dst:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
      identity_account: IDENTITYKEY
      vote_account: VOTE
      validator_type: $dst
INV
  local selection=(-l src)
  case $net/$play in
    */switch_off_*) selection=(-e off_host=src) ;;
    */switch_on_* | testnet/set_identity_to_active) selection=(-e on_host=src) ;;
    */nodowntime_migrate) selection=(-e source_host=src -e target_host=dst) ;;
  esac
  (
    cd "$run" || exit 1
    HOME="$run/home" PATH="$run/bin:$PATH" ANSIBLE_HOME="$run/ansible-home" limited \
      ansible-playbook -i "$run/inventory.yml" "${selection[@]}" -e ansible_become=false \
      -e "slv_alpenglow_rpc_url=$rpc/$(scenario_of "$state")" -e slv_alpenglow_rpc_delay=0 \
      "$run/ansible/$net-validator/$play.yml" >"$run/log" 2>&1 </dev/null
    echo $? >"$run/rc"
  )
}

for entry in "${cases[@]}"; do
  IFS='|' read -r net play types outcomes <<<"$entry"
  for state in "${states[@]}"; do
    run_case "$net" "$play" "$types" "$state" &
    while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
  done
done
wait

freeze_text='identity changes wait until getAgGenesisCert returns a certificate'
alpenglow_text='the cluster runs Alpenglow'
fdctl_text='Firedancer and Frankendancer cannot take a mainnet identity'

for entry in "${cases[@]}"; do
  IFS='|' read -r net play types outcomes <<<"$entry"
  IFS=',' read -r -a expected <<<"$outcomes"
  for i in 0 1 2 3; do
    state=${states[$i]}
    outcome=${expected[$i]}
    id=$(case_id "$net" "$play" "$types" "$state")
    run="$work/runs/$id"
    rc=$(cat "$run/rc" 2>/dev/null || echo missing)
    if [[ -e $run/refused ]]; then
      checked=$((checked + 1))
      fail "$id: $(cat "$run/refused")"
      continue
    fi
    sets=$(grep -c 'set-identity' "$run/calls.log" || true)
    voters=$(grep -c 'authorized-voter' "$run/calls.log" || true)
    messages=''
    grep -qF "$freeze_text" "$run/log" && messages+='freeze '
    grep -qF "$alpenglow_text" "$run/log" && messages+='alpenglow '
    grep -qF "$fdctl_text" "$run/log" && messages+='fdctl '
    if [[ $outcome == run ]]; then
      want=1
      [[ $play == nodowntime_migrate ]] && want=2
      if [[ $play == change_identity_and_restart ]]; then
        # the fake systemctl cannot stand in for the systemd module: the play gets as far as the first service step
        grep -q '^systemctl' "$run/calls.log" && [[ -z $messages ]]
        check $? "$id: the guard lets the change through (rc $rc, messages: ${messages:-none}) $(tail -n 3 "$run/log" | tr '\n' ' ')"
      else
        [[ $rc == 0 && $sets -eq $want && -z $messages ]]
        check $? "$id: expected the change to run (rc $rc, $sets set-identity calls, messages: ${messages:-none}) $(tail -n 4 "$run/log" | tr '\n' ' ')"
      fi
    else
      refused=1
      [[ $rc != 0 && $rc != missing && $sets -eq 0 && $voters -eq 0 && $messages == "$outcome " ]] && refused=0
      case $play in
        switch_on_*) [[ ! -e $run/mnt/ledger/tower-1_9-IDENTITYKEY.bin ]] || refused=1 ;;
        switch_off_* | nodowntime_migrate) grep -qx home-tower "$run/home/.slv/tower/tower-1_9-IDENTITYKEY.bin" || refused=1 ;;
        change_identity_and_restart) [[ ! -s $run/calls.log && ! -e $run/solv/identity.json ]] || refused=1 ;;
      esac
      check $refused "$id: expected the $outcome refusal (rc $rc, $sets set-identity calls, $voters authorized-voter calls, messages: ${messages:-none}) $(tail -n 4 "$run/log" | tr '\n' ' ')"
    fi
  done
done

# --- 6. init.yml --------------------------------------------------------------

# only the first play of init.yml runs here: it is the part that reads validator_type
run_init() { # network label value (- = no validator_type at all, EMPTY = an empty one)
  local net=$1 label=$2 value=$3 dir="$work/init/$1-$2"
  [[ $value == EMPTY ]] && value=''
  mkdir -p "$dir"
  sed '/^- import_playbook/,$d' "$template/ansible/$net-validator/init.yml" >"$dir/first-play.yml"
  {
    printf 'all:\n  hosts:\n    rig:\n      ansible_connection: local\n      ansible_python_interpreter: auto_silent\n'
    [[ $value == - ]] || printf '      validator_type: "%s"\n' "$value"
  } >"$dir/inventory.yml"
  ANSIBLE_HOME="$dir/home" limited ansible-playbook -i "$dir/inventory.yml" "$dir/first-play.yml" \
    >"$dir/log" 2>&1 </dev/null
  echo $? >"$dir/rc"
}
# label|value|outcome
init_cases=(
  'missing|-|stop'
  'empty|EMPTY|stop'
  'unknown|foo|stop'
  'frankendancer|frankendancer|stop'
  'firedancer|firedancer|stop'
  'agave|agave|pass'
  'jito|jito|pass'
  'allnodes-jito|allnodes-jito|pass'
  'firedancer-agave|firedancer-agave|pass'
  'firedancer-jito|firedancer-jito|pass'
)
for net in mainnet testnet; do
  for entry in "${init_cases[@]}"; do
    IFS='|' read -r label value outcome <<<"$entry"
    run_init "$net" "$label" "$value" &
    while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
  done
done
wait
for net in mainnet testnet; do
  for entry in "${init_cases[@]}"; do
    IFS='|' read -r label value outcome <<<"$entry"
    dir="$work/init/$net-$label"
    rc=$(cat "$dir/rc" 2>/dev/null || echo missing)
    if [[ $outcome == pass ]]; then
      [[ $rc == 0 ]] && grep -q "Validator type is $value" "$dir/log"
      check $? "$net init.yml: validator_type $label goes on (rc $rc)"
    else
      [[ $rc != 0 && $rc != missing ]] && grep -q 'is not supported on rig' "$dir/log" && grep -q 'Nothing was changed' "$dir/log"
      check $? "$net init.yml: validator_type $label stops the run (rc $rc) $(tail -n 3 "$dir/log" | tr '\n' ' ')"
    fi
  done
done

# --- the one message and the static import ----------------------------------

[[ $(grep -rlF "$freeze_text" "$template/ansible" | wc -l) -eq 1 ]]
check $? "the window and unknown refusal is written in one place"
for net in mainnet testnet; do
  for play in "${identity_playbooks[@]}"; do
    file="$template/ansible/$net-validator/$play.yml"
    [[ -e $file ]] || continue
    grep -q 'import_tasks: ../cmn/tasks/alpenglow_state.yml' "$file" && grep -q 'slv_alpenglow_freeze: true' "$file"
    check $? "$net/$play.yml imports the probe with the freeze on"
  done
done

# a playbook that imports a task file which is missing fails its syntax check: the import is static
mkdir -p "$work/missing/ansible/mainnet-validator" "$work/missing/ansible/cmn/tasks"
cp "$template/ansible/mainnet-validator/set_unstaked_key.yml" "$work/missing/ansible/mainnet-validator/"
(cd "$work/missing/ansible/mainnet-validator" &&
  ANSIBLE_HOME="$work/missing/home" ansible-playbook -i localhost, --syntax-check set_unstaked_key.yml >"$work/missing/log" 2>&1 </dev/null)
[[ $? -ne 0 ]]
check $? "a missing alpenglow_state.yml is caught by --syntax-check"

for net in mainnet testnet; do
  for play in "${identity_playbooks[@]}"; do
    file="$template/ansible/$net-validator/$play.yml"
    [[ -e $file ]] || continue
    (cd "$template/ansible/$net-validator" &&
      ANSIBLE_HOME="$work/syntax-home" ansible-playbook -i localhost, --syntax-check \
        -e off_host=localhost -e on_host=localhost -e source_host=localhost -e target_host=localhost \
        "$play.yml" >"$work/syntax.log" 2>&1 </dev/null)
    check $? "$net/$play.yml passes --syntax-check ($(tail -n 2 "$work/syntax.log" | tr '\n' ' '))"
  done
done

if ((failures > 0)); then
  echo "alpenglow identity guards: $failures failure(s) in $checked checks" >&2
  exit 1
fi
echo "alpenglow identity guards: PASS ($checked checks)"
