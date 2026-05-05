#!/usr/bin/env bash
# Disable exec approval prompts on this node host.
# Run this once before starting the node with start-node.sh.
#
# What it does:
#   1. Sets tools.exec.security=full and tools.exec.ask=off in openclaw.json
#   2. Writes exec-approvals.json with matching defaults
#
# After running this, restart the node for changes to take effect.

set -uo pipefail

echo "[node-ask-off] Configuring node host to skip exec approval prompts..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! node "${SCRIPT_DIR}/openclaw.mjs" config set tools.exec.security full; then
    echo "[node-ask-off] WARNING: 'openclaw config set tools.exec.security full' failed."
    echo "  Make sure the project is built (pnpm install && pnpm build)."
fi

if ! node "${SCRIPT_DIR}/openclaw.mjs" config set tools.exec.ask off; then
    echo "[node-ask-off] WARNING: 'openclaw config set tools.exec.ask off' failed."
fi

# Write exec-approvals.json (openclaw config set does not touch this file)
APPROVALS_DIR="${HOME}/.openclaw"
APPROVALS_FILE="${APPROVALS_DIR}/exec-approvals.json"

mkdir -p "$APPROVALS_DIR"

cat > "$APPROVALS_FILE" <<'EOF'
{
  "version": 1,
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full",
    "autoAllowSkills": true
  }
}
EOF

echo
echo "[node-ask-off] Done."
echo "  tools.exec.security = full"
echo "  tools.exec.ask = off"
echo "  exec-approvals.json = ${APPROVALS_FILE}"
echo
echo "Restart the node for changes to take effect."
