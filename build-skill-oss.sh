#!/usr/bin/env bash
# build-skill-oss.sh — Build self-contained SLV skill directories for OSS distribution
#
# This script produces clean, public-safe skill packages containing ONLY:
#   - Ansible playbooks (deploy/operate Solana nodes)
#   - Jinja2 templates
#   - OSS SKILL.md documentation
#
# NO internal API info, NO master-api references, NO private infrastructure details.
#
# Usage: ./build-skill-oss.sh <skill> [version]
#   skill:   validator | rpc | grpc-geyser
#   version: template version (default: detect from version.ts)
#
# Output: dist/oss-skills/slv-<skill>/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL="${1:?Usage: $0 <validator|rpc|grpc-geyser> [version]}"

# Detect version
if [[ -n "${2:-}" ]]; then
  VERSION="$2"
else
  VERSION=$(sed -n "s/.*VERSION\s*=\s*['\"]\\([0-9]*\\.[0-9]*\\.[0-9]*\\).*/\\1/p" "$SCRIPT_DIR/cmn/constants/version.ts" 2>/dev/null | head -1)
  if [[ -z "$VERSION" ]]; then
    echo "ERROR: Could not detect version from version.ts. Pass version as second arg." >&2
    exit 1
  fi
fi

TEMPLATE_DIR="$SCRIPT_DIR/template/$VERSION"
ANSIBLE_DIR="$TEMPLATE_DIR/ansible"
JINJA_DIR="$TEMPLATE_DIR/jinja"
DIST_DIR="$SCRIPT_DIR/dist/oss-skills/slv-$SKILL"
OSS_SKILL_DIR="$SCRIPT_DIR/oss-skills/slv-$SKILL"

if [[ ! -d "$ANSIBLE_DIR" ]]; then
  echo "ERROR: Template dir not found: $ANSIBLE_DIR" >&2
  exit 1
fi

# Skill → directory mapping
declare -a ANSIBLE_DIRS
declare -a JINJA_DIRS

case "$SKILL" in
  validator)
    ANSIBLE_DIRS=(mainnet-validator testnet-validator)
    JINJA_DIRS=(mainnet-validator testnet-validator)
    ;;
  rpc)
    ANSIBLE_DIRS=(mainnet-rpc testnet-rpc devnet-rpc)
    JINJA_DIRS=(mainnet-rpc testnet-rpc devnet-rpc)
    ;;
  grpc-geyser)
    ANSIBLE_DIRS=(mainnet-rpc)
    JINJA_DIRS=(mainnet-rpc)
    ;;
  *)
    echo "ERROR: Unknown skill '$SKILL'. Use: validator, rpc, grpc-geyser" >&2
    exit 1
    ;;
esac

# Clean and create output
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/ansible/cmn" "$DIST_DIR/jinja"

# --- Copy skill-specific ansible directories ---
for dir in "${ANSIBLE_DIRS[@]}"; do
  if [[ -d "$ANSIBLE_DIR/$dir" ]]; then
    cp -r "$ANSIBLE_DIR/$dir" "$DIST_DIR/ansible/$dir"
  fi
done

# --- Resolve cmn/ dependencies ---
resolve_cmn_deps() {
  local seen=()
  local queue=()

  for dir in "${ANSIBLE_DIRS[@]}"; do
    while IFS= read -r ref; do
      ref=$(echo "$ref" | sed 's|.*\.\./cmn/||; s|[[:space:]]*$||')
      [[ -n "$ref" ]] && queue+=("$ref")
    done < <(grep -rh '\.\./cmn/' "$ANSIBLE_DIR/$dir" 2>/dev/null || true)
  done

  while [[ ${#queue[@]} -gt 0 ]]; do
    local current="${queue[0]}"
    queue=("${queue[@]:1}")

    local found=0
    for s in "${seen[@]+"${seen[@]}"}"; do
      [[ "$s" == "$current" ]] && found=1 && break
    done
    [[ $found -eq 1 ]] && continue

    seen+=("$current")

    if [[ -f "$ANSIBLE_DIR/cmn/$current" ]]; then
      cp "$ANSIBLE_DIR/cmn/$current" "$DIST_DIR/ansible/cmn/$current"

      while IFS= read -r ref2; do
        ref2=$(echo "$ref2" | sed 's|.*import_playbook:[[:space:]]*||; s|.*include_tasks:[[:space:]]*||; s|[[:space:]]*$||')
        [[ -n "$ref2" && "$ref2" != *"/"* ]] && queue+=("$ref2")
      done < <(grep -h 'import_playbook:\|include_tasks:' "$ANSIBLE_DIR/cmn/$current" 2>/dev/null | grep -v '\.\.' || true)
    fi
  done

  if grep -rq 'tasks/' "$DIST_DIR/ansible/cmn/" 2>/dev/null; then
    if [[ -d "$ANSIBLE_DIR/cmn/tasks" ]]; then
      cp -r "$ANSIBLE_DIR/cmn/tasks" "$DIST_DIR/ansible/cmn/tasks"
    fi
  fi
}

resolve_cmn_deps

# --- Copy skill-specific jinja directories ---
for dir in "${JINJA_DIRS[@]}"; do
  if [[ -d "$JINJA_DIR/$dir" ]]; then
    cp -r "$JINJA_DIR/$dir" "$DIST_DIR/jinja/$dir"
  fi
done

if grep -rq '\.slv/cmn/' "$DIST_DIR/ansible/" 2>/dev/null; then
  if [[ -d "$JINJA_DIR/cmn" ]]; then
    cp -r "$JINJA_DIR/cmn" "$DIST_DIR/jinja/cmn"
  fi
fi

# --- Copy OSS documentation files ---
for f in SKILL.md AGENT.md README.md; do
  if [[ -f "$OSS_SKILL_DIR/$f" ]]; then
    cp "$OSS_SKILL_DIR/$f" "$DIST_DIR/$f"
  fi
done

# --- Copy and version-stamp skill.json ---
if [[ -f "$OSS_SKILL_DIR/skill.json" ]]; then
  sed "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$OSS_SKILL_DIR/skill.json" > "$DIST_DIR/skill.json"
fi

# Copy examples/
if [[ -d "$OSS_SKILL_DIR/examples" ]]; then
  cp -r "$OSS_SKILL_DIR/examples" "$DIST_DIR/examples"
fi

# --- Safety check: ensure no internal API references leaked ---
# Security check: scan for internal API references
# erpc.global (public website) is allowed; only internal subdomains are blocked
LEAKED=$(grep -rl 'master.api\|master-api\|server.api\|server-api\|kafka.api\|kafka-api\|ansible-api\|Bearer solv\|heySOLV\|queue(' "$DIST_DIR/" 2>/dev/null || true)
# Also check for internal subdomains (but allow bare erpc.global and snapshot endpoints)
LEAKED_INTERNAL=$(grep -rPl '(?<!solana-snapshot-\w{2,8}\.)(?<!solana-snapshot-\w{2,12}\.)(?<!\w)(master-api|user-api|server-api|kafka-api|ansible-api)\.erpc\.global' "$DIST_DIR/" 2>/dev/null || true)
LEAKED="$LEAKED$LEAKED_INTERNAL"
if [[ -n "$LEAKED" ]]; then
  echo "🚨 SECURITY: Internal API references found in OSS output!" >&2
  echo "$LEAKED" >&2
  echo "Aborting. Fix the source templates or SKILL.md." >&2
  rm -rf "$DIST_DIR"
  exit 1
fi

# --- Summary ---
echo "✅ Built OSS skill: slv-$SKILL (v$VERSION)"
echo "   Output: $DIST_DIR"
echo ""
echo "   ansible/:"
for dir in "${ANSIBLE_DIRS[@]}"; do
  count=$(find "$DIST_DIR/ansible/$dir" -name '*.yml' 2>/dev/null | wc -l)
  echo "     $dir/ ($count playbooks)"
done
cmn_count=$(find "$DIST_DIR/ansible/cmn" -name '*.yml' 2>/dev/null | wc -l)
echo "     cmn/ ($cmn_count shared playbooks)"
echo ""
echo "   jinja/:"
for dir in "${JINJA_DIRS[@]}"; do
  count=$(find "$DIST_DIR/jinja/$dir" -type f 2>/dev/null | wc -l)
  echo "     $dir/ ($count templates)"
done
if [[ -d "$DIST_DIR/jinja/cmn" ]]; then
  count=$(find "$DIST_DIR/jinja/cmn" -type f 2>/dev/null | wc -l)
  echo "     cmn/ ($count shared templates)"
fi
echo ""
echo "   🔒 Security check: PASSED (no internal API references)"
