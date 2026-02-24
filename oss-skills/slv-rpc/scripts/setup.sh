#!/usr/bin/env bash
# setup.sh — Auto-install prerequisites for the SLV RPC skill
# Usage: bash setup.sh
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " SLV RPC — Prerequisite Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Detect OS
OS="unknown"
if [[ "$(uname)" == "Darwin" ]]; then
  OS="macos"
elif [[ -f /etc/os-release ]]; then
  OS="linux"
fi

# 1. Check/install ansible-core
echo "Checking ansible-core..."
if command -v ansible-playbook &>/dev/null; then
  VERSION=$(ansible-playbook --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  info "ansible-core $VERSION found"
else
  warn "ansible-core not found. Installing..."
  if command -v pip3 &>/dev/null; then
    pip3 install --user ansible-core
  elif command -v pip &>/dev/null; then
    pip install --user ansible-core
  elif [[ "$OS" == "macos" ]] && command -v brew &>/dev/null; then
    brew install ansible
  elif [[ "$OS" == "linux" ]]; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get update && sudo apt-get install -y ansible-core
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y ansible-core
    else
      error "Cannot auto-install ansible-core. Please install manually: pip3 install ansible-core"
      exit 1
    fi
  else
    error "Cannot auto-install ansible-core. Please install manually: pip3 install ansible-core"
    exit 1
  fi
  info "ansible-core installed"
fi

# 2. Check SSH agent
echo ""
echo "Checking SSH..."
if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  KEY_COUNT=$(ssh-add -l 2>/dev/null | grep -c '' || echo 0)
  if [[ "$KEY_COUNT" -gt 0 ]]; then
    info "SSH agent running with $KEY_COUNT key(s)"
  else
    warn "SSH agent running but no keys loaded"
    echo "  → Run: ssh-add ~/.ssh/id_rsa (or your key path)"
  fi
elif [[ -f "$HOME/.ssh/id_rsa" ]] || [[ -f "$HOME/.ssh/id_ed25519" ]]; then
  info "SSH keys found (agent not running — Ansible will use key files directly)"
else
  warn "No SSH keys found"
  echo ""
  echo "  To generate a new SSH key:"
  echo "    ssh-keygen -t ed25519 -C \"your-email@example.com\""
  echo ""
  echo "  Then copy it to your server:"
  echo "    ssh-copy-id solv@<server-ip>"
fi

# 3. Check solana-cli (optional)
echo ""
echo "Checking solana-cli (optional)..."
if command -v solana-keygen &>/dev/null; then
  info "solana-cli found ($(solana-keygen --version 2>/dev/null | head -1))"
else
  warn "solana-cli not found (optional — only needed for local key generation)"
  echo "  → Install: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup complete!"
echo ""
echo " Next steps:"
echo "   1. Ensure SSH access to your target server"
echo "   2. Ask your AI agent: \"Deploy a mainnet RPC node on <server-ip>\""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
