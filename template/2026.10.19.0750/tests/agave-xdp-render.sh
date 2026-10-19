#!/usr/bin/env bash
# Render contract test for the agave start scripts and solv unit templates
# (no network or host access). Needs ansible-core on PATH:
#   bash template/2026.6.6.2026/tests/agave-xdp-render.sh
#
# Every case is rendered once through the Ansible template engine, then checked:
#   - validator scripts: below 4.1 the --experimental-retransmit-xdp-* flags as
#     before; from 4.1 --xdp-interface, --xdp-cpu-cores and --xdp-zero-copy; from
#     4.2 --no-xdp when xdp_enabled is false or absent
#   - RPC scripts: RPC nodes carry no XDP settings and their units grant no
#     capability, so from 4.2 they say --no-xdp whatever xdp_* says
#   - which version a host's client uses: the agave-validator installed on the
#     host first (installed_agave_version), else the -e override, else the
#     section of versions.yml; and that a missing or unreadable version stops
#     the render
#   - that the units grant the XDP capabilities only when xdp_enabled is true
#   - that each play that renders a start script reads the installed binary
#     (every play runs for real against a fake agave-validator, with its paths
#     moved into a temporary directory): an old binary under a newer configured
#     version renders for the old one and the reverse, a binary that does not
#     report a version stops the play before anything is written, and with no
#     binary installed the configured version applies
set -uo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
jinja="$root/template/2026.6.6.2026/jinja"
command -v ansible-playbook >/dev/null 2>&1 || {
  echo 'ansible-playbook is required on PATH' >&2
  exit 2
}

work=$(mktemp -d /tmp/slv-xdp-render.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/out" "$work/skeleton"
export ANSIBLE_HOME="$work/ansible-home" ANSIBLE_NOCOLOR=1 \
  ANSIBLE_LOCALHOST_WARNING=False ANSIBLE_INVENTORY_UNPARSED_WARNING=False

versions=(3.1.10 4.0.0-beta.2 4.1.0 4.2.0 4.3.0 4.3.0-jito.0 4.3.0-allnodes.1 4.4.0-beta.0)
script_configs=(zc nozc off absent nocores noiface)
unit_configs=(zc nozc off absent)

# name|template|section|clients|kind
scripts=(
  'mainnet-validator|mainnet-validator/start-validator.sh.j2|mainnet_validators|agave,jito,allnodes-jito|validator'
  'testnet-validator|testnet-validator/start-validator.sh.j2|testnet_validators|agave,jito,allnodes-jito|validator'
  'testnet-agave|testnet-validator/start-validator-agave.sh.j2|testnet_validators|agave|validator'
  'testnet-jito|testnet-validator/start-validator-jito.sh.j2|testnet_validators|jito|validator'
  'mainnet-rpc|mainnet-rpc/start-validator.sh.j2|mainnet_rpcs|agave,jito,allnodes-jito|rpc'
  'testnet-rpc|testnet-rpc/start-validator.sh.j2|testnet_rpcs|agave,jito,allnodes-jito|rpc'
  'devnet-rpc|devnet-rpc/start-validator.sh.j2|devnet_rpcs|agave,jito,allnodes-jito|rpc'
)
# directory|section|grants capabilities when xdp_enabled
unit_dirs=(
  'mainnet-validator|mainnet_validators|yes'
  'testnet-validator|testnet_validators|yes'
  'mainnet-rpc|mainnet_rpcs|no'
  'testnet-rpc|testnet_rpcs|no'
  'devnet-rpc|devnet_rpcs|no'
)

failures=0
fail() {
  failures=$((failures + 1))
  echo "FAIL $*" >&2
}

version_key() {
  case $1 in
    agave) echo version_agave ;;
    jito) echo version_jito ;;
    allnodes-jito) echo version_allnodes_jito ;;
  esac
}

# XDP settings as JSON members for each configuration.
config_json() {
  case $1 in
    zc) echo '"xdp_enabled":true,"xdp_interface":"eth0","xdp_cpu_cores":2,"xdp_zero_copy":true,"xdp_poh_pinned_cpu_core":3' ;;
    nozc) echo '"xdp_enabled":true,"xdp_interface":"eth0","xdp_cpu_cores":2,"xdp_zero_copy":false' ;;
    off) echo '"xdp_enabled":false' ;;
    absent) echo '' ;;
    nocores) echo '"xdp_enabled":true,"xdp_interface":"eth0"' ;;
    noiface) echo '"xdp_enabled":true' ;;
  esac
}

# major*1000000 + minor*1000 + patch of the numeric part before any suffix.
version_number() {
  local numeric=${1#v} major minor patch
  numeric=${numeric%%-*}
  IFS=. read -r major minor patch <<<"$numeric"
  echo $((10#${major:-0} * 1000000 + 10#${minor:-0} * 1000 + 10#${patch:-0}))
}

add_case() { # id template-path json-members
  printf '{"id":"%s","src":"%s","vars":{%s}}\n' "$1" "$jinja/$2" "$3" >>"$work/cases.jsonl"
}

natural_client() { # client list, version
  local list=$1 version=$2
  case $version in
    *-jito.*) [[ ,$list, == *,jito,* ]] && { echo jito; return; } ;;
    *-allnodes.*) [[ ,$list, == *,allnodes-jito,* ]] && { echo allnodes-jito; return; } ;;
  esac
  echo "${list%%,*}"
}

# 1. every start script x version x XDP configuration
for entry in "${scripts[@]}"; do
  IFS='|' read -r name template section clients kind <<<"$entry"
  for version in "${versions[@]}"; do
    client=$(natural_client "$clients" "$version")
    for config in "${script_configs[@]}"; do
      members="\"vote_account\":\"VOTE\",\"validator_type\":\"$client\",\"$section\":{\"$(version_key "$client")\":\"$version\"}"
      [[ $kind == rpc ]] && members+=',"rpc_type":"Geyser gRPC"'
      xdp=$(config_json "$config")
      add_case "script__${name}__${client}__${version}__${config}" "$template" "$members${xdp:+,$xdp}"
    done
  done
done

# 2. every unit template x version x XDP configuration
for entry in "${unit_dirs[@]}"; do
  IFS='|' read -r dir section grants <<<"$entry"
  for unit in "$jinja/$dir"/solv*.service.j2; do
    unit_name=$(basename "$unit" .service.j2)
    for version in "${versions[@]}"; do
      for config in "${unit_configs[@]}"; do
        members="\"$section\":{\"version_agave\":\"$version\"}"
        xdp=$(config_json "$config")
        add_case "unit__${dir}__${unit_name}__${version}__${config}" "$dir/$(basename "$unit")" "$members${xdp:+,$xdp}"
      done
    done
  done
done

# 2b. every rpc_type branch of the RPC scripts
rpc_type_cases=() # id|version
rpc_types=('Geyser gRPC' 'SendTx RPC' 'Index RPC' 'Index RPC + gRPC' 'Other')
for entry in "${scripts[@]}"; do
  IFS='|' read -r name template section clients kind <<<"$entry"
  [[ $kind == rpc ]] || continue
  for rpc_type in "${rpc_types[@]}"; do
    for version in 3.1.10 4.3.0; do
      id="rpctype__${name}__${rpc_type// /-}__${version}"
      add_case "$id" "$template" "\"vote_account\":\"VOTE\",\"validator_type\":\"agave\",\"$section\":{\"version_agave\":\"$version\"},\"rpc_type\":\"$rpc_type\""
      rpc_type_cases+=("$id|$version|$name|${rpc_type// /-}")
    done
  done
done

# 3. which version a host's client uses: section value, then -e override
source_cases=() # id|expectation (yes = --no-xdp)
add_source() { # script-name template section id expectation members
  local extra=''
  [[ $kind == rpc ]] && extra=',"rpc_type":"Geyser gRPC"'
  add_case "source__$1__$4" "$2" "\"vote_account\":\"VOTE\"$extra,$6"
  source_cases+=("source__$1__$4|$5")
}
for entry in "${scripts[@]}"; do
  IFS='|' read -r name template section clients kind <<<"$entry"
  all_old="\"version_agave\":\"3.1.10\",\"version_jito\":\"3.1.10\",\"version_allnodes_jito\":\"3.1.10\""
  if [[ $name == testnet-agave ]]; then
    add_source "$name" "$template" "$section" agave-section-new yes "\"$section\":{\"version_agave\":\"4.3.0\",\"version_jito\":\"3.1.10\"}"
    add_source "$name" "$template" "$section" agave-section-old no "\"$section\":{\"version_agave\":\"3.1.10\",\"version_jito\":\"4.3.0-jito.0\"},\"validator_type\":\"jito\""
    add_source "$name" "$template" "$section" agave-override-new yes "\"$section\":{\"version_agave\":\"3.1.10\"},\"agave_version\":\"4.3.0\""
    add_source "$name" "$template" "$section" agave-override-old no "\"$section\":{\"version_agave\":\"4.3.0\"},\"agave_version\":\"3.1.10\""
    add_source "$name" "$template" "$section" agave-empty-override yes "\"$section\":{\"version_agave\":\"4.3.0\"},\"agave_version\":\"\""
    add_source "$name" "$template" "$section" agave-v-prefix yes "\"$section\":{\"version_agave\":\"v4.3.0\"}"
    continue
  fi
  if [[ $name == testnet-jito ]]; then
    add_source "$name" "$template" "$section" jito-section-new yes "\"$section\":{\"version_agave\":\"3.1.10\",\"version_jito\":\"4.3.0-jito.0\"}"
    add_source "$name" "$template" "$section" jito-section-old no "\"$section\":{\"version_agave\":\"4.3.0\",\"version_jito\":\"3.1.10\"},\"validator_type\":\"agave\""
    add_source "$name" "$template" "$section" jito-override-new yes "\"$section\":{\"version_jito\":\"3.1.10\"},\"jito_version\":\"4.3.0\""
    add_source "$name" "$template" "$section" jito-override-old no "\"$section\":{\"version_jito\":\"4.3.0-jito.0\"},\"jito_version\":\"3.1.10\""
    add_source "$name" "$template" "$section" jito-empty-override yes "\"$section\":{\"version_jito\":\"4.3.0-jito.0\"},\"jito_version\":\"\""
    continue
  fi
  add_source "$name" "$template" "$section" agave-section-new yes "\"validator_type\":\"agave\",\"$section\":{\"version_agave\":\"4.3.0\",\"version_jito\":\"3.1.10\",\"version_allnodes_jito\":\"3.1.10\"}"
  add_source "$name" "$template" "$section" agave-section-old no "\"validator_type\":\"agave\",\"$section\":{\"version_agave\":\"3.1.10\",\"version_jito\":\"4.3.0-jito.0\",\"version_allnodes_jito\":\"4.3.0-allnodes.1\"}"
  add_source "$name" "$template" "$section" jito-section-new yes "\"validator_type\":\"jito\",\"$section\":{\"version_agave\":\"3.1.10\",\"version_jito\":\"4.3.0-jito.0\",\"version_allnodes_jito\":\"3.1.10\"}"
  add_source "$name" "$template" "$section" jito-section-old no "\"validator_type\":\"jito\",\"$section\":{\"version_agave\":\"4.3.0\",\"version_jito\":\"3.1.10\",\"version_allnodes_jito\":\"4.3.0-allnodes.1\"}"
  add_source "$name" "$template" "$section" allnodes-section-new yes "\"validator_type\":\"allnodes-jito\",\"$section\":{$all_old,\"version_allnodes_jito\":\"4.3.0-allnodes.1\"}"
  add_source "$name" "$template" "$section" allnodes-section-old no "\"validator_type\":\"allnodes-jito\",\"$section\":{\"version_agave\":\"4.3.0\",\"version_jito\":\"4.3.0-jito.0\",\"version_allnodes_jito\":\"3.1.10\"}"
  add_source "$name" "$template" "$section" agave-override-new yes "\"validator_type\":\"agave\",\"$section\":{$all_old},\"agave_version\":\"4.3.0\""
  add_source "$name" "$template" "$section" agave-override-old no "\"validator_type\":\"agave\",\"$section\":{\"version_agave\":\"4.3.0\"},\"agave_version\":\"3.1.10\""
  add_source "$name" "$template" "$section" jito-override-new yes "\"validator_type\":\"jito\",\"$section\":{$all_old},\"jito_version\":\"4.3.0\""
  add_source "$name" "$template" "$section" jito-override-old no "\"validator_type\":\"jito\",\"$section\":{\"version_jito\":\"4.3.0-jito.0\"},\"jito_version\":\"3.1.10\""
  add_source "$name" "$template" "$section" allnodes-override-new yes "\"validator_type\":\"allnodes-jito\",\"$section\":{$all_old},\"allnodes_jito_version\":\"4.3.0-allnodes.1\""
  add_source "$name" "$template" "$section" allnodes-override-old no "\"validator_type\":\"allnodes-jito\",\"$section\":{\"version_allnodes_jito\":\"4.3.0-allnodes.1\"},\"allnodes_jito_version\":\"3.1.10\""
  add_source "$name" "$template" "$section" agave-empty-override yes "\"validator_type\":\"agave\",\"$section\":{\"version_agave\":\"4.3.0\"},\"agave_version\":\"\""
  add_source "$name" "$template" "$section" agave-v-prefix yes "\"validator_type\":\"agave\",\"$section\":{\"version_agave\":\"v4.3.0\"}"
done

# 3b. the binary installed on the host decides when the play found one
for entry in "${scripts[@]}"; do
  IFS='|' read -r name template section clients kind <<<"$entry"
  client=${clients%%,*}
  key=$(version_key "$client")
  override=agave_version
  [[ $client == jito ]] && override=jito_version
  base="\"validator_type\":\"$client\""
  add_source "$name" "$template" "$section" installed-old-section-new no "$base,\"$section\":{\"$key\":\"4.3.0\"},\"installed_agave_version\":\"3.1.10\""
  add_source "$name" "$template" "$section" installed-new-section-old yes "$base,\"$section\":{\"$key\":\"3.1.10\"},\"installed_agave_version\":\"4.3.0\""
  add_source "$name" "$template" "$section" installed-old-override-new no "$base,\"$section\":{\"$key\":\"4.3.0\"},\"$override\":\"4.3.0\",\"installed_agave_version\":\"3.1.10\""
  add_source "$name" "$template" "$section" installed-new-override-old yes "$base,\"$section\":{\"$key\":\"3.1.10\"},\"$override\":\"3.1.10\",\"installed_agave_version\":\"4.4.0\""
  add_source "$name" "$template" "$section" installed-empty-section-new yes "$base,\"$section\":{\"$key\":\"4.3.0\"},\"installed_agave_version\":\"\""
done

cat >"$work/render.yml" <<EOF
---
- hosts: localhost
  gather_facts: false
  connection: local
  vars:
    ansible_python_interpreter: auto_silent
  tasks:
    - name: Render every case through the Ansible template engine
      ansible.builtin.copy:
        dest: "${work}/all.txt"
        content: |
          {% for line in lookup('ansible.builtin.file', '${work}/cases.jsonl').splitlines() %}
          {% set c = line | from_json %}
          @@CASE {{ c.id }}@@
          {{ lookup('ansible.builtin.template', c.src, template_vars=c.vars) }}
          {% endfor %}
EOF

# 4. a host whose client version cannot be found, or has no digits, must not get a script
{
  cat <<EOF
---
- hosts: localhost
  gather_facts: false
  connection: local
  vars:
    ansible_python_interpreter: auto_silent
  tasks:
EOF
  for entry in "${scripts[@]}"; do
    IFS='|' read -r name template section clients kind <<<"$entry"
    cat <<EOF
    - name: Render ${name} without any version
      ansible.builtin.set_fact:
        unresolved: "{{ lookup('ansible.builtin.template', '${jinja}/${template}', template_vars={'vote_account': 'VOTE', 'validator_type': 'agave'}) }}"
      register: unresolved_${name//-/_}
      ignore_errors: true
    - name: Keep the outcome of ${name}
      ansible.builtin.copy:
        dest: "${work}/out/unresolved__${name}"
        content: "{{ unresolved_${name//-/_}.msg | default('RENDERED') }}"
    - name: Render ${name} with a version that has no digits
      ansible.builtin.set_fact:
        unresolved: "{{ lookup('ansible.builtin.template', '${jinja}/${template}', template_vars={'vote_account': 'VOTE', 'validator_type': 'agave', 'agave_version': 'master'}) }}"
      register: garbage_${name//-/_}
      ignore_errors: true
    - name: Keep the outcome of ${name} with a version that has no digits
      ansible.builtin.copy:
        dest: "${work}/out/unresolved__${name}__garbage"
        content: "{{ garbage_${name//-/_}.msg | default('RENDERED') }}"
    - name: Render ${name} with an installed version that has no digits next to a good configured one
      ansible.builtin.set_fact:
        unresolved: "{{ lookup('ansible.builtin.template', '${jinja}/${template}', template_vars={'vote_account': 'VOTE', 'validator_type': 'agave', '${section}': {'version_agave': '4.3.0', 'version_jito': '4.3.0'}, 'installed_agave_version': 'master'}) }}"
      register: installed_garbage_${name//-/_}
      ignore_errors: true
    - name: Keep the outcome of ${name} with an installed version that has no digits
      ansible.builtin.copy:
        dest: "${work}/out/unresolved__${name}__installed_garbage"
        content: "{{ installed_garbage_${name//-/_}.msg | default('RENDERED') }}"
EOF
  done
} >"$work/unresolved.yml"

for playbook in render unresolved; do
  if ! ansible-playbook -i localhost, "$work/$playbook.yml" >"$work/$playbook.log" 2>&1 </dev/null; then
    echo "ansible-playbook failed for $playbook.yml" >&2
    tail -n 25 "$work/$playbook.log" >&2
    exit 1
  fi
done

awk -v dir="$work/out" '
  /^@@CASE .*@@$/ {
    id = $0; sub(/^@@CASE /, "", id); sub(/@@$/, "", id)
    out = dir "/" id; printf "" > out; next
  }
  { print >> out }
' "$work/all.txt"

xdp_lines() { grep -E '^--(experimental-retransmit-xdp-|xdp-|no-xdp|experimental-poh-pinned-cpu-core)' "$1" || true; }

expected_xdp_lines() { # kind version config
  local kind=$1 number prefix cores
  number=$(version_number "$2")
  if [[ $kind == rpc ]]; then
    ((number >= 4002000)) && printf '%s\n' '--no-xdp \'
    return 0
  fi
  case $3 in
    zc | nozc | nocores)
      prefix=--experimental-retransmit-xdp-
      ((number >= 4001000)) && prefix=--xdp-
      cores=2
      [[ $3 == nocores ]] && cores=1
      printf '%s\n' "${prefix}interface eth0 \\" "${prefix}cpu-cores $cores \\"
      if [[ $3 == zc ]]; then
        printf '%s\n' "${prefix}zero-copy \\" '--experimental-poh-pinned-cpu-core 3 \'
      fi
      ;;
    off | absent)
      ((number >= 4002000)) && printf '%s\n' '--no-xdp \'
      ;;
  esac
  return 0
}

# every line but the last ends in a backslash, so the command stays one command
continuation_problems() {
  awk '/^#!/ { next } NF { lines[++n] = $0 } END { for (i = 1; i < n; i++) if (lines[i] !~ /\\$/) print "line " i ": " lines[i] }' "$1"
}

checked=0
for entry in "${scripts[@]}"; do
  IFS='|' read -r name template section clients kind <<<"$entry"
  for version in "${versions[@]}"; do
    client=$(natural_client "$clients" "$version")
    for config in "${script_configs[@]}"; do
      id="script__${name}__${client}__${version}__${config}"
      file="$work/out/$id"
      checked=$((checked + 1))
      if [[ ! -s $file ]]; then
        fail "$id: nothing rendered"
        continue
      fi
      diff_out=$(diff <(expected_xdp_lines "$kind" "$version" "$config") <(xdp_lines "$file") 2>&1) ||
        fail "$id: XDP lines differ from the contract (< expected, > rendered)"$'\n'"$diff_out"
      if [[ $(xdp_lines "$file" | grep -cF -- '--no-xdp') -gt 0 ]] &&
        [[ $(xdp_lines "$file" | grep -cE -- '^--(xdp-|experimental-retransmit-xdp-)') -gt 0 ]]; then
        fail "$id: --no-xdp rendered together with an XDP interface or core flag"
      fi
      problems=$(continuation_problems "$file")
      [[ -z $problems ]] || fail "$id: broken line continuation: $problems"
      bash -n "$file" 2>"$work/syntax.err" || fail "$id: bash -n: $(cat "$work/syntax.err")"
      # everything outside the XDP lines is the same for every version and configuration
      grep -vE '^--(experimental-retransmit-xdp-|xdp-|no-xdp|experimental-poh-pinned-cpu-core)' "$file" |
        awk 'NF { lines[++n] = $0 } END { for (i = 1; i <= n; i++) print lines[i] }' >"$work/skeleton/$id"
      reference="$work/skeleton/reference__${name}__${client}"
      if [[ -e $reference ]]; then
        cmp -s "$reference" "$work/skeleton/$id" ||
          fail "$id: lines outside the XDP flags changed between versions or configurations"
      else
        cp "$work/skeleton/$id" "$reference"
      fi
    done
  done
done

for entry in "${unit_dirs[@]}"; do
  IFS='|' read -r dir section grants <<<"$entry"
  for unit in "$jinja/$dir"/solv*.service.j2; do
    unit_name=$(basename "$unit" .service.j2)
    for config in "${unit_configs[@]}"; do
      reference=""
      for version in "${versions[@]}"; do
        id="unit__${dir}__${unit_name}__${version}__${config}"
        file="$work/out/$id"
        checked=$((checked + 1))
        if [[ ! -s $file ]]; then
          fail "$id: nothing rendered"
          continue
        fi
        ambient=$(grep -c '^AmbientCapabilities=' "$file" || true)
        bounding=$(grep -c '^CapabilityBoundingSet=' "$file" || true)
        caps='CAP_NET_RAW CAP_NET_ADMIN CAP_BPF CAP_PERFMON'
        if [[ $unit_name == solv && $grants == yes && ($config == zc || $config == nozc) ]]; then
          grep -Fxq "AmbientCapabilities=$caps" "$file" && grep -Fxq "CapabilityBoundingSet=$caps" "$file" ||
            fail "$id: capabilities are not granted when xdp_enabled is true"
        elif ((ambient + bounding > 0)); then
          fail "$id: capabilities are granted without xdp_enabled (or in a unit that never grants them)"
        fi
        if [[ -z $reference ]]; then reference=$file; else
          cmp -s "$reference" "$file" || fail "$id: the unit changes with the agave version"
        fi
      done
    done
  done
done

for entry in "${rpc_type_cases[@]}"; do
  IFS='|' read -r id version name rpc_label <<<"$entry"
  file="$work/out/$id"
  checked=$((checked + 1))
  if [[ ! -s $file ]]; then
    fail "$id: nothing rendered"
    continue
  fi
  expected=0
  (($(version_number "$version") >= 4002000)) && expected=1
  rendered=$(grep -cFx -- '--no-xdp \' "$file" || true)
  [[ $rendered -eq $expected ]] || fail "$id: expected $expected --no-xdp, found $rendered"
  [[ -z $(xdp_lines "$file" | grep -vFx -- '--no-xdp \') ]] || fail "$id: an XDP interface or core flag is rendered for an RPC node"
  problems=$(continuation_problems "$file")
  [[ -z $problems ]] || fail "$id: broken line continuation: $problems"
  bash -n "$file" 2>"$work/syntax.err" || fail "$id: bash -n: $(cat "$work/syntax.err")"
  grep -vFx -- '--no-xdp \' "$file" | awk 'NF' >"$work/skeleton/$id"
  reference="$work/skeleton/rpctype__${name}__${rpc_label}"
  if [[ -e $reference ]]; then
    cmp -s "$reference" "$work/skeleton/$id" || fail "$id: lines outside --no-xdp changed between versions"
  else
    cp "$work/skeleton/$id" "$reference"
  fi
done

for entry in "${source_cases[@]}"; do
  IFS='|' read -r id expectation <<<"$entry"
  file="$work/out/$id"
  checked=$((checked + 1))
  if [[ ! -s $file ]]; then
    fail "$id: nothing rendered"
    continue
  fi
  rendered=$(grep -cFx -- '--no-xdp \' "$file" || true)
  if [[ $expectation == yes && $rendered -ne 1 ]]; then
    fail "$id: expected one --no-xdp, found $rendered"
  elif [[ $expectation == no && $rendered -ne 0 ]]; then
    fail "$id: expected no --no-xdp, found $rendered"
  fi
done

for entry in "${scripts[@]}"; do
  IFS='|' read -r name template section clients kind <<<"$entry"
  for suffix in '' __garbage __installed_garbage; do
    file="$work/out/unresolved__${name}${suffix}"
    checked=$((checked + 1))
    grep -Fq 'Cannot tell which agave version this host runs' "$file" 2>/dev/null ||
      fail "unresolved__${name}${suffix}: a script was rendered without a usable agave version: $(head -c 200 "$file" 2>/dev/null)"
  done
done

# 5. every play that renders a start script reads the agave-validator installed
# on the host. The play runs for real on a local connection: its /home/solv and
# /mnt move into a temporary directory, sudo and systemctl are fakes that do
# nothing, and agave-validator is a fake that prints what the case says.
me=$(id -un)
mygroup=$(id -gn)
# play|network directory|versions.yml section|version key|validator_type|kind
play_rows=(
  'mainnet-validator/create-start-validator-sh.yml|mainnet-validator|mainnet_validators|version_agave|agave|validator'
  'mainnet-validator/update_startup_config.yml|mainnet-validator|mainnet_validators|version_agave|agave|validator'
  'testnet-validator/create-start-validator-sh-agave.yml|testnet-validator|testnet_validators|version_agave|agave|validator'
  'testnet-validator/create-start-validator-sh-jito.yml|testnet-validator|testnet_validators|version_jito|jito|validator'
  'testnet-validator/deploy-start-validator-sh.yml|testnet-validator|testnet_validators|version_agave|agave|validator'
  'testnet-validator/update_startup_config.yml|testnet-validator|testnet_validators|version_agave|agave|validator'
  'mainnet-rpc/create-start-validator-sh.yml|mainnet-rpc|mainnet_rpcs|version_agave|agave|rpc'
  'mainnet-rpc/update_startup_config.yml|mainnet-rpc|mainnet_rpcs|version_agave|agave|rpc'
  'testnet-rpc/create-start-validator-sh.yml|testnet-rpc|testnet_rpcs|version_agave|agave|rpc'
  'testnet-rpc/update_startup_config.yml|testnet-rpc|testnet_rpcs|version_agave|agave|rpc'
  'devnet-rpc/create-start-validator-sh.yml|devnet-rpc|devnet_rpcs|version_agave|agave|rpc'
  'devnet-rpc/update_startup_config.yml|devnet-rpc|devnet_rpcs|version_agave|agave|rpc'
)
# name|scope|what agave-validator --version prints (- = no binary installed)|its exit status|configured version (- = none)|outcome|XDP settings|where the binary is (unit = the directory the solv unit puts on PATH, else the active_release link)
# outcome: the agave version the script has to follow, or stop:<text the message has to carry>
play_cases=(
  'installed-old-configured-new|all|agave-validator 3.1.10 (src:0123abcd; feat:00000001, client:Agave)|0|4.3.0|3.1.10|off'
  'installed-new-configured-old|all|agave-validator 4.3.0 (src:0123abcd; feat:00000001, client:Agave)|0|3.1.10|4.3.0|off'
  'installed-unparsable|all|error while loading shared libraries: libudev.so.1: cannot open shared object file|127|4.3.0|stop:did not report a version|off'
  'no-binary-configured-new|all|-|0|4.3.0|4.3.0|off'
  'installed-old-configured-new-xdp-on|sample|agave-validator 3.1.10 (src:0123abcd; feat:00000001, client:Agave)|0|4.3.0|3.1.10|zc'
  'installed-new-configured-old-xdp-on|sample|agave-validator 4.3.0 (src:0123abcd; feat:00000001, client:Agave)|0|3.1.10|4.3.0|zc'
  'installed-beta-configured-old|sample|agave-validator 4.4.0-beta.0 (src:0123abcd; feat:00000001, client:Agave)|0|3.1.10|4.4.0-beta.0|off'
  'installed-jito-configured-new|sample|agave-validator 3.1.10 (src:0123abcd; feat:00000001, client:JitoLabs)|0|4.3.0|3.1.10|off'
  'installed-silent|sample||0|4.3.0|stop:did not report a version|off'
  'installed-fails-after-printing|sample|agave-validator 4.3.0 (src:0123abcd; feat:00000001, client:Agave)|1|4.3.0|stop:did not report a version|off'
  'no-binary-configured-old|sample|-|0|3.1.10|3.1.10|off'
  'no-binary-no-config|sample|-|0|-|stop:Cannot tell which agave version|off'
  'installed-in-the-unit-path|sample|agave-validator 3.1.10 (src:0123abcd; feat:00000001, client:Agave)|0|4.3.0|3.1.10|off|unit'
)
sample_plays=(0 6) # mainnet-validator and mainnet-rpc create-start-validator-sh.yml

run_play_case() { # play index, case index
  local play net section key client kind
  IFS='|' read -r play net section key client kind <<<"${play_rows[$1]}"
  local name scope printed status configured outcome xdp where
  IFS='|' read -r name scope printed status configured outcome xdp where <<<"${play_cases[$2]}"
  local run="$work/plays/$1__$2"
  local bindir="$run/solv/.local/share/solana/install/active_release/bin"
  [[ ${where:-} == unit ]] && bindir="$run/unit/bin"
  mkdir -p "$run/bin" "$run/home/.slv" "$run/mnt" "$run/solv" "$bindir"
  cp -r "$jinja/." "$run/home/.slv/"
  printf '#!/bin/sh\nexit 0\n' >"$run/bin/systemctl"
  if [[ ${where:-} == unit ]]; then
    printf '#!/bin/sh\nif [ "$1" = show ] && [ "$2" = solv ]; then\n  echo "PATH=%s SOLANA_METRICS_CONFIG=host=https://metrics.solana.com:8086,db=mainnet-beta,u=u,p=p"\nfi\nexit 0\n' "$bindir" >"$run/bin/systemctl"
  fi
  printf '#!/bin/sh\nexit 0\n' >"$run/bin/sudo"
  chmod +x "$run/bin/systemctl" "$run/bin/sudo"
  if [[ $printed != - ]]; then
    printf '#!/bin/sh\nprintf "%%s\\n" "%s"\nexit %s\n' "$printed" "$status" >"$bindir/agave-validator"
    chmod +x "$bindir/agave-validator"
  fi
  if [[ $configured == - ]]; then
    printf '%s: {}\n' "$section" >"$run/home/.slv/versions.yml"
  else
    printf '%s:\n  %s: "%s"\n' "$section" "$key" "$configured" >"$run/home/.slv/versions.yml"
  fi
  printf 'OLD SCRIPT\n' >"$run/solv/start-validator.sh"
  sed -e "s#/home/solv#$run/solv#g" -e "s#/mnt#$run/mnt#g" -e "s#owner: solv#owner: $me#g" -e "s#group: solv#group: $mygroup#g" \
    "$root/template/2026.6.6.2026/ansible/$play" >"$run/play.yml"
  if grep -Eq '(^|[^A-Za-z0-9_])/(home/solv|mnt)([^A-Za-z0-9_]|$)' "$run/play.yml"; then
    echo "a path of the real host is left in $play" >"$run/refused"
    echo 99 >"$run/rc"
    return 0
  fi
  local xdp_vars=''
  [[ $xdp == zc ]] && xdp_vars='      xdp_enabled: true
      xdp_interface: eth0
      xdp_cpu_cores: 2
      xdp_zero_copy: true
      xdp_poh_pinned_cpu_core: 3'
  cat >"$run/inventory.yml" <<EOF
all:
  hosts:
    rig:
      ansible_connection: local
      ansible_python_interpreter: auto_silent
      validator_type: $client
      vote_account: VOTE
      rpc_type: SendTx RPC
      shredstream_address: 127.0.0.1:1002
      port_rpc: 8899
      limit_ledger_size: 100000000
$xdp_vars
EOF
  env HOME="$run/home" PATH="$run/bin:$PATH" ANSIBLE_HOME="$run/ansible-home" ANSIBLE_NOCOLOR=1 \
    ANSIBLE_GATHERING=explicit ANSIBLE_LOCALHOST_WARNING=False ANSIBLE_INVENTORY_UNPARSED_WARNING=False \
    ansible-playbook -i "$run/inventory.yml" -e ansible_become=false "$run/play.yml" >"$run/log" 2>&1 </dev/null
  echo $? >"$run/rc"
}

selected_play_case() { # play index, case index
  local scope
  IFS='|' read -r _ scope _ <<<"${play_cases[$2]}"
  [[ $scope == all || " ${sample_plays[*]} " == *" $1 "* ]]
}

for pi in "${!play_rows[@]}"; do
  for ci in "${!play_cases[@]}"; do
    selected_play_case "$pi" "$ci" || continue
    run_play_case "$pi" "$ci" &
    while (($(jobs -rp | wc -l) >= 8)); do wait -n; done
  done
done
wait

for pi in "${!play_rows[@]}"; do
  IFS='|' read -r play net section key client kind <<<"${play_rows[$pi]}"
  for ci in "${!play_cases[@]}"; do
    selected_play_case "$pi" "$ci" || continue
    IFS='|' read -r name scope printed status configured outcome xdp where <<<"${play_cases[$ci]}"
    run="$work/plays/${pi}__${ci}"
    id="play__${play%.yml}__${name}"
    checked=$((checked + 1))
    rc=$(cat "$run/rc" 2>/dev/null || echo missing)
    if [[ -e $run/refused ]]; then
      fail "$id: $(cat "$run/refused")"
      continue
    fi
    if [[ $outcome == stop:* ]]; then
      text=${outcome#stop:}
      [[ $rc != 0 && $rc != missing ]] || fail "$id: the play went on (rc $rc)"
      grep -Fq -- "$text" "$run/log" || fail "$id: the stop message lacks \"$text\": $(tail -n 5 "$run/log")"
      [[ $(cat "$run/solv/start-validator.sh") == 'OLD SCRIPT' ]] || fail "$id: the start script was rewritten although the play stopped"
    else
      [[ $rc == 0 ]] || { fail "$id: the play failed (rc $rc): $(tail -n 8 "$run/log")"; continue; }
      diff_out=$(diff <(expected_xdp_lines "$kind" "$outcome" "$xdp") <(xdp_lines "$run/solv/start-validator.sh") 2>&1) ||
        fail "$id: XDP lines do not follow agave $outcome (< expected, > rendered)"$'\n'"$diff_out"
    fi
  done
done

if ((failures > 0)); then
  echo "agave xdp render contract: $failures failure(s) in $checked checks" >&2
  exit 1
fi
echo "agave xdp render contract: PASS ($checked checks)"
