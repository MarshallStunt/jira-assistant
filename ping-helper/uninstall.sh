#!/bin/bash
# Removes the DC Ops ping helper.
set -uo pipefail
HOST_NAME="com.dcops.ping_helper"
case "$(uname)" in
  Darwin) INSTALL_DIR="$HOME/Library/Application Support/DCOpsPingHelper"; BASE="$HOME/Library/Application Support" ;;
  *)      INSTALL_DIR="$HOME/.local/share/dcops-ping-helper"; BASE="$HOME/.config" ;;
esac
find "$BASE" -maxdepth 4 -path "*NativeMessagingHosts/$HOST_NAME.json" -print -delete 2>/dev/null
rm -rf "$INSTALL_DIR" && echo "✓ Removed $INSTALL_DIR"
