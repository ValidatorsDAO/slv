#!/usr/bin/env bash
# Stops unless the ansible-playbook that a test is going to run is the pinned one: the file that
# ANSIBLE_PLAYBOOK names is the first ansible-playbook on PATH, and it reports ansible-core
# ANSIBLE_CORE_VERSION. .github/workflows/slv-template-tests.yml runs this first in every step that
# runs a test, because the ubuntu-24.04 runner image has an ansible-core of its own (pipx, in
# /opt/pipx_bin) ahead of /usr/bin on PATH: without this, the job named for the apt ansible-core would
# test the one of the image and say nothing.
set -euo pipefail

pinned="${ANSIBLE_PLAYBOOK:-}"
core="${ANSIBLE_CORE_VERSION:-}"
if [ -z "$pinned" ] || [ -z "$core" ]; then
  echo "FAIL pinned_ansible: ANSIBLE_PLAYBOOK (the pinned ansible-playbook) and ANSIBLE_CORE_VERSION (its ansible-core) have to be set" >&2
  exit 1
fi

found=$(command -v ansible-playbook || true)
if [ "$found" != "$pinned" ]; then
  echo "FAIL pinned_ansible: the ansible-playbook on PATH is ${found:-missing}, not the pinned $pinned" >&2
  exit 1
fi

output=$("$found" --version 2>&1) || {
  echo "FAIL pinned_ansible: $found --version failed: $output" >&2
  exit 1
}
first=${output%%$'\n'*}
case "$first" in
  *"[core ${core}]"*) echo "pinned ansible-playbook: $found, $first" ;;
  *)
    echo "FAIL pinned_ansible: $found reports '$first', not ansible-core $core" >&2
    exit 1
    ;;
esac
