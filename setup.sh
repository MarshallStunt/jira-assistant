#!/bin/bash
# One-time setup for the Lambda Rackside on a Mac.
# Installs what the extension needs on this computer, asking before each install:
#   - python3 (Apple Command Line Tools)   → for the ping / BMC helper
#   - the ping / BMC helper itself
# Usage:  bash setup.sh <extension-id>     (copy the exact command from the extension's Settings page)
set -uo pipefail

EXT_ID="${1:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'

ok()   { echo "${GREEN}✓${RESET} $*"; }
warn() { echo "${YELLOW}!${RESET} $*"; }
fail() { echo "${RED}✗${RESET} $*"; }
step() { echo; echo "${BOLD}$*${RESET}"; }
ask()  { local a; read -r -p "$1 [Y/n] " a </dev/tty; [[ -z "$a" || "$a" =~ ^[Yy] ]]; }

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  fail "Missing or wrong extension ID."
  echo "  Open the extension's Settings → Getting started, click Copy next to the setup command, and paste it here."
  exit 1
fi
if [ "$(uname)" != "Darwin" ]; then
  warn "This setup script is for macOS. On Linux, run: bash \"$DIR/ping-helper/install.sh\" $EXT_ID"
  exit 1
fi

echo "${BOLD}Lambda Rackside — setup${RESET}"
echo "This installs the tools the extension needs. You'll be asked before anything is installed."

# 1. python3 ------------------------------------------------------------
step "1/2  Python (for the ping and BMC helper)"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
  ok "python3 is installed"
else
  warn "python3 is missing. macOS will now offer to install Apple's Command Line Tools."
  xcode-select --install >/dev/null 2>&1 || true
  echo "  Click Install in the window that opens, wait for it to finish, then run this setup again."
  exit 1
fi

# 2. Helper -------------------------------------------------------------
step "2/2  Ping and BMC helper"
if bash "$DIR/ping-helper/install.sh" "$EXT_ID"; then
  ok "Helper installed"
else
  fail "Helper install failed (see above)."
  exit 1
fi

echo
ok "${BOLD}Setup done.${RESET} Go back to Chrome, reload the extension, and click Test ping helper in Settings."
