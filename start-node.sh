#!/usr/bin/env bash
# Start an OpenClaw node host and connect to a gateway running in Docker.
#
# Usage:
#   ./start-node.sh --token <token> [--port <port>] [--host <host>]
#   ./start-node.sh -t <token> [-p <port>] [-h <host>]
#
# Defaults: host=127.0.0.1, port=19000
#
# You can also set OPENCLAW_GATEWAY_TOKEN in the environment instead of
# passing --token. A --token flag takes precedence over the env var.

set -euo pipefail

GATEWAY_HOST="127.0.0.1"
GATEWAY_PORT="19000"
CLI_TOKEN=""

show_help() {
    cat <<EOF
Usage: ./start-node.sh --token <token> [--port <port>] [--host <host>]
  -t, --token  Gateway auth token (or set OPENCLAW_GATEWAY_TOKEN)
  -p, --port   Gateway port (default: 19000)
  -h, --host   Gateway host (default: 127.0.0.1)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --token|-t)
            CLI_TOKEN="${2:-}"
            shift 2
            ;;
        --port|-p)
            GATEWAY_PORT="${2:-}"
            shift 2
            ;;
        --host|-h)
            GATEWAY_HOST="${2:-}"
            shift 2
            ;;
        --help|-\?)
            show_help
            exit 0
            ;;
        *)
            echo "[start-node] ERROR: unknown argument \"$1\""
            show_help
            exit 1
            ;;
    esac
done

if [[ -n "$CLI_TOKEN" ]]; then
    export OPENCLAW_GATEWAY_TOKEN="$CLI_TOKEN"
fi

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    echo "[start-node] ERROR: no gateway token provided."
    echo "Pass one with --token <token> or set OPENCLAW_GATEWAY_TOKEN."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f "dist/entry.mjs" && ! -f "dist/entry.js" ]]; then
    echo "[start-node] dist/ not found - building openclaw first..."
    if ! command -v pnpm >/dev/null 2>&1; then
        echo "[start-node] ERROR: pnpm is not installed."
        echo "Install it with: npm install -g pnpm"
        exit 1
    fi
    pnpm install
    pnpm build
fi

echo "[start-node] Connecting node host to ${GATEWAY_HOST}:${GATEWAY_PORT}"
node "${SCRIPT_DIR}/openclaw.mjs" node run --host "$GATEWAY_HOST" --port "$GATEWAY_PORT"
