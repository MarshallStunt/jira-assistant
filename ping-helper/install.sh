#!/bin/bash
# Installs the DC Ops ping helper so the Chrome extension can ping servers.
# Usage:  bash install.sh <extension-id>
# The exact command (with your extension ID) is shown in the extension's Settings page.
set -euo pipefail

HOST_NAME="com.dcops.ping_helper"
EXT_ID="${1:-}"

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: bash install.sh <extension-id>"
  echo "Copy the full command from the extension's Settings page → Ping helper."
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find a working python3 (Chrome starts the helper with a minimal PATH, so we store the absolute path).
PY=""
for cand in "$(command -v python3 2>/dev/null || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c 'import sys; assert sys.version_info >= (3, 6)' >/dev/null 2>&1; then
    PY="$("$cand" -c 'import sys; print(sys.executable)')"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "✗ python3 not found."
  echo "  On macOS run:  xcode-select --install   (then run this installer again)"
  exit 1
fi

case "$(uname)" in
  Darwin)
    INSTALL_DIR="$HOME/Library/Application Support/DCOpsPingHelper"
    BASE="$HOME/Library/Application Support"
    BROWSERS=("Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" "Microsoft Edge" "BraveSoftware/Brave-Browser")
    ;;
  Linux)
    INSTALL_DIR="$HOME/.local/share/dcops-ping-helper"
    BASE="$HOME/.config"
    BROWSERS=("google-chrome" "google-chrome-beta" "chromium" "microsoft-edge" "BraveSoftware/Brave-Browser")
    ;;
  *)
    echo "✗ Unsupported OS: $(uname). This installer supports macOS and Linux."
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"
cp "$SRC_DIR/dcops_ping_helper.py" "$INSTALL_DIR/dcops_ping_helper.py"
cat > "$INSTALL_DIR/run.sh" <<EOF
#!/bin/sh
exec "$PY" "$INSTALL_DIR/dcops_ping_helper.py" "\$@"
EOF
chmod 755 "$INSTALL_DIR/run.sh" "$INSTALL_DIR/dcops_ping_helper.py"

installed=0
for b in "${BROWSERS[@]}"; do
  dir="$BASE/$b"
  [ -d "$dir" ] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  "$PY" - "$dir/NativeMessagingHosts/$HOST_NAME.json" "$INSTALL_DIR/run.sh" "$EXT_ID" "$HOST_NAME" <<'PYEOF'
import json, sys
out, path, ext_id, name = sys.argv[1:5]
json.dump({
    "name": name,
    "description": "DC Ops ping helper",
    "path": path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}, open(out, "w"), indent=2)
PYEOF
  echo "✓ Registered for $b"
  installed=1
done

if [ "$installed" = 0 ]; then
  echo "✗ No Chrome/Chromium/Edge/Brave profile folder found under $BASE"
  exit 1
fi

# Self-test: send a 'hello' message through the helper exactly like Chrome would.
"$PY" - "$INSTALL_DIR/run.sh" <<'PYEOF'
import json, struct, subprocess, sys
msg = json.dumps({"action": "hello"}).encode()
p = subprocess.run([sys.argv[1]], input=struct.pack("=I", len(msg)) + msg, stdout=subprocess.PIPE, timeout=10)
n = struct.unpack("=I", p.stdout[:4])[0]
r = json.loads(p.stdout[4:4 + n])
print(f"✓ Helper works (v{r['version']}, {r['platform']}, Python {r['python']})")
PYEOF

echo ""
echo "Done. In Chrome, open the extension's Settings and click “Test ping helper”."
