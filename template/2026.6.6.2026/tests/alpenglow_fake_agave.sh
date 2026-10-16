#!/bin/bash
# A fake agave-validator for the vote history tests. It plays a validator box named by
# $FAKE_BOX (a directory):
#
#   $FAKE_BOX/fake.conf   knobs, sourced: STAKED, UNSTAKED, LOG, plus the ones below
#   $FAKE_BOX/identity    the identity the "validator" runs now
#   $FAKE_BOX/calls.log   one line per call
#
# What it plays, from agave v4.3.2 (validator/src/commands/set_identity/mod.rs,
# validator/src/admin_rpc_service.rs, votor/src/event_handler.rs):
#
#   set-identity [PATH] [--require-tower] [--do-not-require-vote-history]
#       no PATH: the key comes on stdin and is the staked one; the admin RPC gate refuses a
#       staked identity without its tower (--require-tower) or, while GATE=1, without its
#       vote history file (unless --do-not-require-vote-history). A moment later Votor logs
#       "set-identity: from OLD to NEW". Leaving the staked identity, the box keeps "voting"
#       (rewriting its vote history file) for VOTOR_DELAY seconds first. Taking the staked
#       identity, it votes (rewrites the file) after VOTE_AFTER seconds when TARGET_VOTES=1.
#   authorized-voter add   ADD_VOTER=ok | present | error
#   wait-for-restart-window, contact-info --output json
#
# Knobs: VOTOR_DELAY (2) NO_VOTOR_LINE (0) CHURN_FOREVER (0) GATE (1: the cluster runs
#        Alpenglow, 0: it runs TowerBFT) TARGET_VOTES (1) VOTE_AFTER (1) ADD_VOTER (ok)
set -u
box=${FAKE_BOX:?FAKE_BOX names the box}
# shellcheck disable=SC1091
. "$box/fake.conf"
VOTOR_DELAY=${VOTOR_DELAY:-2}
NO_VOTOR_LINE=${NO_VOTOR_LINE:-0}
CHURN_FOREVER=${CHURN_FOREVER:-0}
GATE=${GATE:-1}
TARGET_VOTES=${TARGET_VOTES:-1}
VOTE_AFTER=${VOTE_AFTER:-1}
ADD_VOTER=${ADD_VOTER:-ok}

ledger=
if [ "${1:-}" = "-l" ]; then
  ledger=$2
  shift 2
fi
command=${1:-}
shift || true

stdin_bytes=0
record() { echo "agave-validator -l $ledger $command $* (stdin $stdin_bytes bytes)" >>"$box/calls.log"; }
vote_file() { echo "$ledger/vote_history-$STAKED.bin"; }
write_vote() { # content
  printf '%s\n' "$1" >"$(vote_file).new" && mv "$(vote_file).new" "$(vote_file)"
}
votor_line() { # old new
  printf '[%s WARN  agave_votor::event_handler] set-identity: from %s to %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$1" "$2" >>"$LOG"
}

case $command in
wait-for-restart-window)
  record "$@"
  ;;
contact-info)
  record "$@"
  printf '{"id": "%s"}\n' "$(cat "$box/identity")"
  ;;
authorized-voter)
  if [ "${1:-}" = add ]; then
    shift
    if [ -z "${1:-}" ]; then
      stdin_bytes=$(cat | wc -c)
    fi
    record add "$@"
    case $ADD_VOTER in
    present)
      echo "Validator command failed: admin rpc error: JSON-RPC error: Error { code: InvalidParams, message: \"Authorized voter already present\", data: None }"
      exit 1
      ;;
    error)
      echo "Validator command failed: admin rpc error: JSON-RPC error: Error { code: InvalidParams, message: \"Failed to read authorized voter keypair\", data: None }"
      exit 1
      ;;
    esac
  fi
  ;;
set-identity)
  path=
  require_tower=0
  require_vote_history=1
  for argument in "$@"; do
    case $argument in
    --require-tower) require_tower=1 ;;
    --do-not-require-vote-history) require_vote_history=0 ;;
    *) path=$argument ;;
    esac
  done
  if [ -z "$path" ]; then
    stdin_bytes=$(cat | wc -c)
    new=$STAKED
  elif [[ $path == *unstaked* ]]; then
    new=$UNSTAKED
  else
    new=$STAKED
  fi
  record "$@"
  current=$(cat "$box/identity")
  if [ "$new" = "$STAKED" ]; then
    if [ "$require_tower" = 1 ] && [ ! -e "$ledger/tower-1_9-$STAKED.bin" ]; then
      echo "Validator command failed: admin rpc error: Unable to load tower file for identity $STAKED"
      exit 1
    fi
    if [ "$require_vote_history" = 1 ] && [ "$GATE" = 1 ] && [ ! -e "$(vote_file)" ]; then
      echo "Validator command failed: admin rpc error: Unable to load vote history file for identity $STAKED: IO Error. The vote account has prior Alpenglow votes. Ensure the vote history file is present or (dangerous) use --do-not-require-vote-history if you know what you're doing"
      exit 1
    fi
    if [ -e "$(vote_file)" ]; then
      # what the validator finds when it restores the vote history of the identity it takes
      sha256sum "$(vote_file)" | cut -d' ' -f1 >"$box/sha256-at-set-identity"
      cat "$(vote_file)" >"$box/vh-content-at-set-identity"
      stat -c '%a %U %G' "$(vote_file)" >"$box/vh-stat-at-set-identity"
    fi
  fi
  echo "$new" >"$box/identity"
  [ "$new" = "$current" ] && exit 0
  if [ "$current" = "$STAKED" ]; then
    # leaving the staked identity: Votor has not seen the event yet
    (
      end=$((SECONDS + VOTOR_DELAY))
      n=0
      while [ "$SECONDS" -lt "$end" ]; do
        n=$((n + 1))
        write_vote "vote-$n-$RANDOM"
        sleep 0.2
      done
      write_vote "final-vote-history-of-$STAKED"
      [ "$NO_VOTOR_LINE" = 1 ] || votor_line "$current" "$new"
      if [ "$CHURN_FOREVER" = 1 ]; then
        stop=$((SECONDS + 40))
        while [ "$SECONDS" -lt "$stop" ]; do
          n=$((n + 1))
          write_vote "vote-$n-$RANDOM"
          sleep 0.2
        done
      fi
    ) >/dev/null 2>&1 </dev/null &
    echo $! >>"$box/pids"
  elif [ "$new" = "$STAKED" ]; then
    # taking the staked identity
    (
      votor_line "$current" "$new"
      if [ "$TARGET_VOTES" = 1 ]; then
        sleep "$VOTE_AFTER"
        stop=$((SECONDS + 20))
        n=0
        while [ "$SECONDS" -lt "$stop" ]; do
          n=$((n + 1))
          write_vote "voting-$n-$RANDOM"
          sleep 0.2
        done
      fi
    ) >/dev/null 2>&1 </dev/null &
    echo $! >>"$box/pids"
  fi
  ;;
*)
  record "$@"
  echo "fake agave-validator: no such command $command" >&2
  exit 2
  ;;
esac
exit 0
