#!/usr/bin/env bash
set -euo pipefail

# swap-setup.sh — configure or release a large swap file for model workloads.
#
# Usage (requires root):
#   sudo bash swap-setup.sh up     [size]   Create and enable swap (default: 64G)
#   sudo bash swap-setup.sh down   [path]   Disable and remove swap file
#   sudo bash swap-setup.sh status          Show memory + swap summary

SWAP_FILE="${SWAP_FILE:-/swap_model}"
SIZE="${2:-64G}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (sudo)."
  fi
}

swap_up() {
  require_root

  if swapon --show 2>/dev/null | grep -qF "$SWAP_FILE"; then
    echo "==> $SWAP_FILE is already active. Nothing to do."
    free -h
    return 0
  fi

  if [[ -f "$SWAP_FILE" ]]; then
    fail "$SWAP_FILE already exists but is not active swap. Remove it first: sudo bash $0 down"
  fi

  echo "==> Creating ${SIZE} swap file at $SWAP_FILE ..."
  fallocate -l "$SIZE" "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
  swapon "$SWAP_FILE"

  echo ""
  echo "==> Swap enabled:"
  free -h
  echo ""
  echo "To release the swap when done:"
  echo "  sudo bash $0 down"
}

swap_down() {
  require_root
  local path="${2:-$SWAP_FILE}"

  if swapon --show 2>/dev/null | grep -qF "$path"; then
    echo "==> Deactivating swap at $path ..."
    swapoff "$path"
  else
    echo "  (swap at $path not currently active)"
  fi

  if [[ -f "$path" ]]; then
    echo "==> Removing swap file: $path"
    rm "$path"
  fi

  echo ""
  echo "==> Current memory:"
  free -h
}

swap_status() {
  echo "==> Memory overview:"
  free -h
  echo ""
  echo "==> Active swap devices:"
  swapon --show 2>/dev/null || echo "  (none)"
}

case "${1:-}" in
  up)     swap_up "$@" ;;
  down)   swap_down "$@" ;;
  status) swap_status ;;
  *)
    echo "Usage: sudo bash $(basename "$0") {up|down|status} [size|path]"
    echo ""
    echo "  up     [size]   Create and enable swap (default: 64G)"
    echo "  down   [path]   Disable and remove swap file"
    echo "  status          Show memory + swap summary"
    echo ""
    echo "Examples:"
    echo "  sudo bash $(basename "$0") up          # create 64G swap at /swap_model"
    echo "  sudo bash $(basename "$0") up 32G      # create 32G swap"
    echo "  sudo bash $(basename "$0") down        # release and remove"
    echo "  sudo bash $(basename "$0") status      # print current state"
    exit 1
    ;;
esac
