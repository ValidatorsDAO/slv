#!/usr/bin/env bash
# setup.sh — Auto-install prerequisites for the SLV App skill
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
echo " SLV App — Prerequisite Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Detect OS
OS="unknown"
if [[ "$(uname)" == "Darwin" ]]; then
  OS="macos"
elif [[ -f /etc/os-release ]]; then
  OS="linux"
fi

# 1. Check/install Deno
echo "Checking Deno..."
if command -v deno &>/dev/null; then
  VERSION=$(deno --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  info "Deno $VERSION found"

  # Check minimum version (2.0)
  MAJOR=$(echo "$VERSION" | cut -d. -f1)
  if [[ "$MAJOR" -lt 2 ]]; then
    warn "Deno $VERSION found but >= 2.0 required"
    echo "  → Upgrading Deno..."
    deno upgrade
    info "Deno upgraded"
  fi
else
  warn "Deno not found. Installing..."
  if [[ "$OS" == "macos" ]] && command -v brew &>/dev/null; then
    brew install deno
  else
    curl -fsSL https://deno.land/install.sh | sh
  fi
  info "Deno installed"
fi

# 2. Check solana-cli (optional)
echo ""
echo "Checking solana-cli (optional)..."
if command -v solana-keygen &>/dev/null; then
  info "solana-cli found ($(solana-keygen --version 2>/dev/null | head -1))"
elif command -v agave-keygen &>/dev/null; then
  info "agave-keygen found ($(agave-keygen --version 2>/dev/null | head -1))"
else
  warn "solana-cli not found (optional — only needed for local key generation)"
  echo "  → Install: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup complete!"
echo ""
echo " Next steps:"
echo "   1. Run: slv bot init"
echo "   2. Configure .env with your RPC endpoint"
echo "   3. Run: deno task dev"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
