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
#   3. alpenglow: an agave, jito or allnodes-jito host goes on with the vote history file
#      (alpenglow-vote-history.sh runs that path); here the file is missing, so a switch
#      stops before the demotion, switch_on stops without the copy of the source, and
#      set:identity stops and names --primary-down. A Firedancer or Frankendancer host
#      stops every identity move; set_unstaked_key is not a move. The retired playbooks
#      (set_identity_to_active of both networks, and switch_on_firedancer_identity and
#      change_identity_and_restart of testnet) refuse in their first task in every state, with
#      SLV_KEYLESS_REFUSED: set_identity_to_active set the identity without the checks that
#      slv v set:identity makes first, and the other two took the staked key from a file on the
#      node, which a deploy never copies there (slv v set:identity and slv v switch pass the
#      key on stdin). On testnet, a Firedancer host takes the staked key from a file on the
#      node too: set_identity_key refuses it and nodowntime_migrate refuses it as the source
#      or the target, in every state, right after the check of the validator type and before
#      anything is changed
#   4. mainnet: Firedancer and Frankendancer never take an identity, in any state, and
#      nodowntime_migrate says so before it demotes the source; as the source they go
#      on only while the state is towerbft
#   5. testnet: only window, unknown and alpenglow are new
#   6. init.yml and update_startup_config.yml: a host without a validator_type, or with
#      one slv does not know, stops the run before the first change instead of becoming
#      a Frankendancer host
#   7. a pending activation close to the end of the epoch (imminent) stops them too, a
#      second probe stands right before the demotion, and a switch_on that refuses after
#      the source was demoted says both nodes are unstaked and what to do
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
  'pending-far|pending-100000|mainnet|towerbft'
  'pending-at-margin|pending-3000|mainnet|towerbft'
  'pending-below-margin|pending-2999|mainnet|imminent'
  'pending-last-slot|pending-1|mainnet|imminent'
  'absent-near|absent-near|mainnet|towerbft'
  'epoch-rpc-error|pending-epoch-rpc-error|mainnet|unknown'
  'epoch-http500|pending-epoch-http-500|mainnet|unknown'
  'epoch-garbage|pending-epoch-garbage|mainnet|unknown'
  'epoch-no-fields|pending-epoch-no-fields|mainnet|unknown'
  'epoch-bad-types|pending-epoch-bad-types|mainnet|unknown'
  'epoch-inverted|pending-epoch-inverted|mainnet|unknown'
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
run_probe margin-wider pending-3000 mainnet -e slv_alpenglow_margin_slots=3001 &
run_probe margin-off pending-100 mainnet -e slv_alpenglow_margin_slots=0 &
run_probe margin-bad pending-100 mainnet -e slv_alpenglow_margin_slots=abc &
wait

for entry in "${probe_cases[@]}"; do
  IFS='|' read -r id target network expected <<<"$entry"
  log="$work/probe/$id.log"
  grep -q "RESULT state=$expected detail=" "$log" 2>/dev/null
  check $? "probe $id: the state is $expected ($(grep -o 'RESULT state=.*' "$log" 2>/dev/null | head -1))"
  grep -q '127\.0\.0\.1' "$log"
  check $((1 - $?)) "probe $id: the RPC URL is printed"
done

# the feature account is asked only when the certificate is null, the epoch only when the feature is pending
count_calls() { grep -c "\"path\": \"/$1\", \"scenario\": \"[^\"]*\", \"method\": \"$2\"" "$work/stub.log" || true; }
[[ $(count_calls alpenglow getAccountInfo) -eq 0 ]]
check $? "probe: a certificate settles the state without asking for the feature account"
[[ $(count_calls window getAccountInfo) -gt 0 ]]
check $? "probe: a null certificate sends the second question"
for name in towerbft window alpenglow absent-near; do
  [[ $(count_calls "$name" getEpochInfo) -eq 0 ]]
  check $? "probe $name: the epoch is asked only when the feature is pending"
done
for name in pending-2999 pending-3000; do
  [[ $(count_calls "$name" getEpochInfo) -gt 0 ]]
  check $? "probe $name: a pending feature sends the epoch question"
done
grep -q 'epoch: 2999 slots left' "$work/probe/pending-below-margin.log"
check $? "probe: the detail of an imminent activation says how many slots are left"
grep -q 'RESULT state=imminent' "$work/probe/margin-wider.log"
check $? "probe: a margin of 3001 slots makes 3000 slots left imminent"
grep -q 'RESULT state=towerbft' "$work/probe/margin-off.log"
check $? "probe: a margin of 0 turns the margin off"
[[ $(cat "$work/probe/margin-bad.rc") != 0 ]] && grep -q 'a whole number of slots' "$work/probe/margin-bad.log"
check $? "probe: a margin that is not a whole number stops the play"

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
#   towerbft,window,unknown,alpenglow  with run, freeze, fdctl (a mainnet Firedancer target),
#   afdctl (Firedancer or Frankendancer in an identity move on Alpenglow), vhfile (switch_off
#   without the vote history file), vhcopy (switch_on without the copy of the source) or
#   primarydown (set:identity without the vote history file) or keyless (a playbook, or on testnet a Firedancer host
#   of set_identity_key and of nodowntime_migrate, that needs the staked key as a file on the node: it refuses in
#   every state, before anything is changed)
#   (the fifth state, imminent, refuses every row with its own message, except the keyless rows, which have five)
cases=(
  'mainnet|switch_off_identity|agave|run,freeze,freeze,vhfile'
  'mainnet|switch_off_firedancer_identity|firedancer-jito|run,freeze,freeze,afdctl'
  'mainnet|switch_on_identity|agave|run,freeze,freeze,vhcopy'
  'mainnet|switch_on_firedancer_identity|firedancer-jito|fdctl,freeze,freeze,afdctl'
  'mainnet|set_identity_key|agave|run,freeze,freeze,primarydown'
  'mainnet|set_identity_key|jito|run,freeze,freeze,primarydown'
  'mainnet|set_identity_key|allnodes-jito|run,freeze,freeze,primarydown'
  'mainnet|set_identity_key|firedancer-agave|fdctl,freeze,freeze,afdctl'
  'mainnet|set_identity_key|firedancer-jito|fdctl,freeze,freeze,afdctl'
  'mainnet|set_unstaked_key|agave|run,freeze,freeze,run'
  'mainnet|set_unstaked_key|firedancer-jito|run,freeze,freeze,run'
  'mainnet|set_identity_to_active|jito|keyless,keyless,keyless,keyless,keyless'
  'mainnet|set_identity_to_active|firedancer-jito|keyless,keyless,keyless,keyless,keyless'
  'mainnet|nodowntime_migrate|agave>agave|run,freeze,freeze,vhfile'
  'mainnet|nodowntime_migrate|firedancer-jito>agave|run,freeze,freeze,afdctl'
  'mainnet|nodowntime_migrate|agave>firedancer-jito|fdctl,freeze,freeze,afdctl'
  'mainnet|nodowntime_migrate|firedancer-agave>firedancer-jito|fdctl,freeze,freeze,afdctl'
  'testnet|switch_off_identity|agave|run,freeze,freeze,vhfile'
  'testnet|switch_off_firedancer_identity|firedancer-jito|run,freeze,freeze,afdctl'
  'testnet|switch_on_identity|agave|run,freeze,freeze,vhcopy'
  'testnet|switch_on_firedancer_identity|firedancer-jito|keyless,keyless,keyless,keyless,keyless'
  'testnet|set_identity_key|agave|run,freeze,freeze,primarydown'
  'testnet|set_identity_key|jito|run,freeze,freeze,primarydown'
  'testnet|set_identity_key|allnodes-jito|run,freeze,freeze,primarydown'
  'testnet|set_identity_key|firedancer-jito|keyless,keyless,keyless,keyless,keyless'
  'testnet|set_unstaked_key|agave|run,freeze,freeze,run'
  'testnet|set_unstaked_key|firedancer-jito|run,freeze,freeze,run'
  'testnet|set_identity_to_active|jito|keyless,keyless,keyless,keyless,keyless'
  'testnet|set_identity_to_active|firedancer-jito|keyless,keyless,keyless,keyless,keyless'
  'testnet|nodowntime_migrate|agave>agave|run,freeze,freeze,vhfile'
  'testnet|nodowntime_migrate|jito>allnodes-jito|run,freeze,freeze,vhfile'
  'testnet|nodowntime_migrate|firedancer-jito>firedancer-jito|keyless,keyless,keyless,keyless,keyless'
  'testnet|nodowntime_migrate|agave>firedancer-jito|keyless,keyless,keyless,keyless,keyless'
  'testnet|nodowntime_migrate|firedancer-jito>agave|keyless,keyless,keyless,keyless,keyless'
  'testnet|change_identity_and_restart|firedancer-jito|keyless,keyless,keyless,keyless,keyless'
)
states=(towerbft window unknown alpenglow imminent)
scenario_of() { # state, case id (flip scenarios count their probes per path)
  case $1 in
    towerbft) echo towerbft ;;
    window) echo window ;;
    unknown) echo unknown-http500 ;;
    alpenglow) echo alpenglow ;;
    imminent) echo pending-100 ;;
    flip*) echo "flip-${1#flip}/$2" ;;
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
  printf '[1,2,3]' >"$run/home/.slv/keys/StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA.json"
  printf 'home-tower' >"$run/home/.slv/tower/tower-1_9-StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA.bin"
  case $play in
    switch_off_* | set_identity_key | nodowntime_migrate)
      printf 'ledger-tower' >"$run/mnt/ledger/tower-1_9-StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA.bin"
      ;;
  esac
  cp "$template/ansible/cmn/tasks/"*.yml "$run/ansible/cmn/tasks/"
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
      identity_account: StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA
      vote_account: VOTE
      validator_type: $src
    dst:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
      identity_account: StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA
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
      -e "slv_alpenglow_rpc_url=$rpc/$(scenario_of "$state" "$id")" -e slv_alpenglow_rpc_delay=0 \
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
afdctl_text='cannot move an identity on a cluster that runs Alpenglow'
fdctl_text='Firedancer and Frankendancer cannot take a mainnet identity'
imminent_text='Run the identity change after the genesis certificate'
demoted_text='are both unstaked now'
vhfile_text='so there is no vote history to carry to the target'
vhcopy_text='does not exist on the controller'
keyless_text='SLV_KEYLESS_REFUSED'

for entry in "${cases[@]}"; do
  IFS='|' read -r net play types outcomes <<<"$entry"
  IFS=',' read -r -a expected <<<"$outcomes"
  ((${#expected[@]} == 4)) && expected+=(imminent)
  for i in 0 1 2 3 4; do
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
    grep -qF "$afdctl_text" "$run/log" && messages+='afdctl '
    grep -qF "$fdctl_text" "$run/log" && messages+='fdctl '
    grep -qF "$imminent_text" "$run/log" && messages+='imminent '
    grep -qF "$vhfile_text" "$run/log" && messages+='vhfile '
    grep -qF "$vhcopy_text" "$run/log" && messages+='vhcopy '
    grep -qF "slv v set:identity -n $net -p src with --primary-down" "$run/log" && messages+='primarydown '
    grep -qF "$keyless_text" "$run/log" && messages+='keyless '
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
        switch_on_*) [[ ! -e $run/mnt/ledger/tower-1_9-StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA.bin ]] || refused=1 ;;
        switch_off_* | nodowntime_migrate) grep -qx home-tower "$run/home/.slv/tower/tower-1_9-StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA.bin" || refused=1 ;;
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
    # mainnet init.yml stops the four Firedancer and Frankendancer types with their own words
    stop_text='is not supported on rig'
    if [[ $net == mainnet ]]; then
      case $value in
        firedancer | firedancer-agave | firedancer-jito | frankendancer)
          outcome=stop
          stop_text='A mainnet voting validator cannot be'
          ;;
      esac
    fi
    if [[ $outcome == pass ]]; then
      [[ $rc == 0 ]] && grep -q "Validator type is $value" "$dir/log"
      check $? "$net init.yml: validator_type $label goes on (rc $rc)"
    else
      [[ $rc != 0 && $rc != missing ]] && grep -q "$stop_text" "$dir/log" && grep -q 'Nothing was changed' "$dir/log"
      check $? "$net init.yml: validator_type $label stops the run (rc $rc) $(tail -n 3 "$dir/log" | tr '\n' ' ')"
    fi
  done
done

# update_startup_config.yml is one play, so it runs whole, with its paths moved into a
# temporary directory and fake commands: a missing or unknown type has to stop it at once
run_update() { # network label value (- = no validator_type at all, EMPTY = an empty one)
  local net=$1 label=$2 value=$3 dir="$work/update/$1-$2"
  [[ $value == EMPTY ]] && value=''
  mkdir -p "$dir/bin" "$dir/solv" "$dir/mnt" "$dir/home/.slv"
  : >"$dir/calls.log"
  sed -e "s#/home/solv#$dir/solv#g" -e "s#/mnt#$dir/mnt#g" -e "s#owner: solv#owner: $(id -un)#g" -e "s#group: solv#group: $(id -gn)#g" \
    "$template/ansible/$net-validator/update_startup_config.yml" >"$dir/update.yml"
  if grep -Eq '(^|[^A-Za-z0-9_])/(home/solv|mnt)([^A-Za-z0-9_]|$)' "$dir/update.yml"; then
    echo "a path of the real host is left in update_startup_config.yml of $net" >"$dir/refused"
    echo 99 >"$dir/rc"
    return 0
  fi
  local name
  for name in agave-validator systemctl sudo; do
    printf '#!/bin/bash\necho "%s $*" >>"%s"\nexit 0\n' "$name" "$dir/calls.log" >"$dir/bin/$name"
    chmod +x "$dir/bin/$name"
  done
  {
    printf 'all:\n  hosts:\n    rig:\n      ansible_connection: local\n      ansible_python_interpreter: auto_silent\n'
    printf '      vote_account: VOTE\n      commission_bps: 0\n      block_engine_url: http://localhost\n'
    [[ $value == - ]] || printf '      validator_type: "%s"\n' "$value"
  } >"$dir/inventory.yml"
  HOME="$dir/home" PATH="$dir/bin:$PATH" ANSIBLE_HOME="$dir/ansible-home" limited \
    ansible-playbook -i "$dir/inventory.yml" -e ansible_become=false "$dir/update.yml" >"$dir/log" 2>&1 </dev/null
  echo $? >"$dir/rc"
}
update_cases=(
  'missing|-'
  'empty|EMPTY'
  'unknown|foo'
  'frankendancer|frankendancer'
  'firedancer|firedancer'
)
for net in mainnet testnet; do
  for entry in "${update_cases[@]}"; do
    IFS='|' read -r label value <<<"$entry"
    run_update "$net" "$label" "$value" &
    while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
  done
done
wait
for net in mainnet testnet; do
  for entry in "${update_cases[@]}"; do
    IFS='|' read -r label value <<<"$entry"
    dir="$work/update/$net-$label"
    rc=$(cat "$dir/rc" 2>/dev/null || echo missing)
    [[ ! -e $dir/refused && $rc != 0 && $rc != missing ]] && grep -q 'is not supported on rig' "$dir/log" && grep -q 'Nothing was changed' "$dir/log" &&
      [[ ! -s $dir/calls.log && ! -e $dir/solv/start-validator.sh && ! -e $dir/solv/firedancer-config.toml ]]
    check $? "$net update_startup_config.yml: validator_type $label stops the play before it writes anything (rc $rc) $(tail -n 3 "$dir/log" | tr '\n' ' ')"
  done
done

# --- 7. the state changes while a nodowntime_migrate run is going on ----------

# A migrate run probes four times: at the start, when switch_off starts, right before
# switch_off demotes the source, and when switch_on starts. flip-K answers towerbft to
# the first K probes and window to every later one.
flip_cases=('mainnet|agave>agave' 'testnet|agave>agave' 'mainnet|firedancer-jito>agave')
flip_states=(flip2 flip3 flip9)
for entry in "${flip_cases[@]}"; do
  IFS='|' read -r net types <<<"$entry"
  for state in "${flip_states[@]}"; do
    run_case "$net" nodowntime_migrate "$types" "$state" &
    while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
  done
done
wait

for entry in "${flip_cases[@]}"; do
  IFS='|' read -r net types <<<"$entry"
  for state in "${flip_states[@]}"; do
    id=$(case_id "$net" nodowntime_migrate "$types" "$state")
    run="$work/runs/$id"
    rc=$(cat "$run/rc" 2>/dev/null || echo missing)
    sets=$(grep -c 'set-identity' "$run/calls.log" || true)
    promoted=$(grep -c 'require-tower\|authorized-voter' "$run/calls.log" || true)
    waited=$(grep -c 'wait-for-restart-window' "$run/calls.log" || true)
    case $state in
      flip2)
        # the probe right before the demotion sees the change: the source is not touched
        [[ $rc != 0 && $sets -eq 0 && $waited -eq 1 ]] && grep -qF "$freeze_text" "$run/log" && ! grep -qF "$demoted_text" "$run/log" &&
          grep -qx home-tower "$run/home/.slv/tower/tower-1_9-StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA.bin"
        check $? "$id: a state that changes after wait-for-restart-window stops the demotion (rc $rc, $sets set-identity calls, $waited waits) $(tail -n 3 "$run/log" | tr '\n' ' ')"
        ;;
      flip3)
        # the source is demoted, switch_on refuses: both nodes are unstaked and the message says what to do by hand
        [[ $rc != 0 && $sets -eq 1 && $promoted -eq 0 ]] && grep -qF "$freeze_text" "$run/log" && grep -qF "$demoted_text" "$run/log" &&
          grep -q 'source host src was already switched to its unstaked identity' "$run/log" &&
          grep -q 'promote StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA on dst yourself' "$run/log" && grep -q "slv v set:identity -n $net -p dst" "$run/log" &&
          grep -q 'Nothing is promoted automatically' "$run/log" && ! grep -q 'Nothing was changed' "$run/log"
        check $? "$id: switch_on refusing after the demotion names both nodes, the identity and the target (rc $rc, $sets set-identity calls, $promoted promotions) $(tail -n 3 "$run/log" | tr '\n' ' ')"
        ;;
      flip9)
        # control: no change, the run goes through
        [[ $rc == 0 && $sets -eq 2 ]] && ! grep -qF "$freeze_text" "$run/log"
        check $? "$id: without a change the migrate run goes through (rc $rc, $sets set-identity calls)"
        ;;
    esac
  done
done

# --- the one message and the static import ----------------------------------

[[ $(grep -rlF "$freeze_text" "$template/ansible" | wc -l) -eq 1 ]]
check $? "the window and unknown refusal is written in one place"
[[ $(grep -rlF "$imminent_text" "$template/ansible" | wc -l) -eq 1 ]]
check $? "the imminent activation refusal is written in one place"
[[ $(grep -rlF "$demoted_text" "$template/ansible" | wc -l) -eq 1 ]]
check $? "what to do after a demotion is written in one place"
for net in mainnet testnet; do
  [[ $(grep -c 'slv_alpenglow_demoted_source: "{{ source_host }}"' "$template/ansible/$net-validator/nodowntime_migrate.yml") -eq 2 ]]
  check $? "$net/nodowntime_migrate.yml tells both switch_on plays which source host it demoted"
done
# the retired playbooks only refuse, in their first task: they ask the cluster nothing
is_keyless() { # network playbook
  case $1/$2 in
    */set_identity_to_active | testnet/switch_on_firedancer_identity | testnet/change_identity_and_restart) return 0 ;;
  esac
  return 1
}
for net in mainnet testnet; do
  for play in "${identity_playbooks[@]}"; do
    file="$template/ansible/$net-validator/$play.yml"
    [[ -e $file ]] || continue
    if is_keyless "$net" "$play"; then
      grep -q 'SLV_KEYLESS_REFUSED' "$file" && ! grep -q 'import_tasks' "$file"
      check $? "$net/$play.yml refuses with SLV_KEYLESS_REFUSED and imports nothing"
      continue
    fi
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
