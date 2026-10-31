#!/bin/bash
# One-time setup for the Lambda DC Ops Assistant on a Mac.
# Installs what the extension needs on this computer, asking before each install:
#   - python3 (Apple Command Line Tools)   → for the ping / BMC helper
#   - Homebrew + 1Password CLI             → for BMC logins
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

echo "${BOLD}Lambda DC Ops Assistant — setup${RESET}"
echo "This installs the tools the extension needs. You'll be asked before anything is installed."

# 1. python3 ------------------------------------------------------------
step "1/4  Python (for the ping and BMC helper)"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
  ok "python3 is installed"
else
  warn "python3 is missing. macOS will now offer to install Apple's Command Line Tools."
  xcode-select --install >/dev/null 2>&1 || true
  echo "  Click Install in the window that opens, wait for it to finish, then run this setup again."
  exit 1
fi

# 2. Homebrew -----------------------------------------------------------
step "2/4  Homebrew (installs the 1Password CLI)"
BREW="$(command -v brew || true)"
[ -z "$BREW" ] && [ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew
[ -z "$BREW" ] && [ -x /usr/local/bin/brew ] && BREW=/usr/local/bin/brew
if [ -n "$BREW" ]; then
  ok "Homebrew is installed"
elif ask "Homebrew isn't installed. Install it now? (asks for your Mac password)"; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  [ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew || BREW=/usr/local/bin/brew
  [ -x "$BREW" ] && ok "Homebrew installed" || { fail "Homebrew didn't install. Ask IT for help, then run this setup again."; exit 1; }
else
  warn "Skipped. BMC logins from 1Password won't work until the 1Password CLI is installed."
fi

# 3. 1Password CLI ------------------------------------------------------
step "3/4  1Password CLI (for BMC logins)"
OP="$(command -v op || true)"
[ -z "$OP" ] && [ -x /opt/homebrew/bin/op ] && OP=/opt/homebrew/bin/op
[ -z "$OP" ] && [ -x /usr/local/bin/op ] && OP=/usr/local/bin/op
if [ -n "$OP" ]; then
  ok "1Password CLI is installed ($("$OP" --version))"
elif [ -n "$BREW" ] && ask "Install the 1Password CLI now?"; then
  "$BREW" install 1password-cli && OP="$(command -v op || echo /opt/homebrew/bin/op)" && ok "1Password CLI installed"
else
  warn "Skipped 1Password CLI."
fi

# 4. Helper -------------------------------------------------------------
step "4/4  Ping and BMC helper"
if bash "$DIR/ping-helper/install.sh" "$EXT_ID"; then
  ok "Helper installed"
else
  fail "Helper install failed (see above)."
  exit 1
fi

# 1Password app integration ------------------------------------------------
if [ -n "$OP" ]; then
  step "Connect the 1Password CLI to the 1Password app"
  if "$OP" account list 2>/dev/null | grep -q .; then
    ok "1Password CLI is connected to your 1Password app"
  else
    echo "  One manual step: in the 1Password app, open ${BOLD}Settings → Developer${RESET}"
    echo "  and turn on ${BOLD}Integrate with 1Password CLI${RESET}."
    open -a 1Password >/dev/null 2>&1 || warn "1Password app not found. Ask IT to install it."
    read -r -p "  Press Enter once it's on… " _ </dev/tty
    if "$OP" account list 2>/dev/null | grep -q .; then
      ok "1Password CLI is connected"
    else
      warn "Still not connected. You can turn it on later and use Settings → Test 1Password in the extension."
    fi
  fi
fi

echo
ok "${BOLD}Setup done.${RESET} Go back to Chrome, reload the extension, and click Test ping helper in Settings."
