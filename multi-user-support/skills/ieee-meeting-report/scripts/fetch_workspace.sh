#!/usr/bin/env bash
# fetch_workspace.sh — thin wrapper around `openclaw nodes copy` / `openclaw nodes ls`
# so the calling agent does not have to remember the `node:` prefix convention
# or the subcommand names.
#
# Usage:
#   fetch_workspace.sh ls    <node> <remote-path>
#   fetch_workspace.sh pull  <node> <remote-path> <local-dest>
#   fetch_workspace.sh push  <node> <local-src>   <remote-path>
#
# Always invoke with the `exec` tool on the gateway host. Never run on the node.

set -euo pipefail

die() {
  echo "fetch_workspace.sh: $*" >&2
  exit 2
}

usage() {
  cat >&2 <<EOF
Usage:
  $(basename "$0") ls    <node> <remote-path>
  $(basename "$0") pull  <node> <remote-path> <local-dest>
  $(basename "$0") push  <node> <local-src>   <remote-path>

Examples (substitute your own <node-name> and <remote-path>):
  $(basename "$0") ls    <node-name> "<remote-folder>"
  $(basename "$0") pull  <node-name> "<remote-folder>" ./input
  $(basename "$0") push  <node-name> ./Report.md "<remote-folder>"

The <node-name> is whatever the user's node is called (e.g. a Linux Jetson or
a Windows host); run \`openclaw nodes status\` on the gateway to see available
names. <remote-path> can be a Linux path ('/home/user/...') or a Windows path
('C:\\Users\\user\\...') — pass it exactly as given.
EOF
  exit 2
}

command -v openclaw >/dev/null 2>&1 || die "openclaw CLI not on PATH"

[[ $# -lt 1 ]] && usage
action="$1"; shift

case "$action" in
  ls)
    [[ $# -ne 2 ]] && usage
    node="$1"; remote="$2"
    exec openclaw nodes ls --node "$node" --path "$remote"
    ;;

  pull)
    [[ $# -ne 3 ]] && usage
    node="$1"; remote="$2"; local_dest="$3"

    # Wipe the destination before copying so ad-hoc files from a previous run
    # (e.g. agent-written extract_*.py, stale _extracted/) don't get mixed with
    # the authoritative pulled copy. Guardrail: only wipe paths that resolve
    # strictly under the gateway workspace. realpath -m normalizes even for
    # not-yet-existing targets, and the suffix check rejects both the
    # workspace root itself and any ../ escape.
    WORKSPACE_ROOT="/home/node/.openclaw/workspace"
    abs_dest="$(realpath -m -- "$local_dest" 2>/dev/null || true)"
    suffix=""
    if [[ "$abs_dest" == "$WORKSPACE_ROOT"/* ]]; then
      suffix="${abs_dest#$WORKSPACE_ROOT/}"
    fi
    if [[ -n "$suffix" ]]; then
      if [[ -d "$local_dest" ]]; then
        echo "Wiping ${local_dest} before pull" >&2
        rm -rf "$local_dest"
      fi
    else
      echo "Refusing to wipe ${local_dest} — does not resolve under ${WORKSPACE_ROOT}/<name>. Proceeding without wipe." >&2
    fi

    mkdir -p "$local_dest"
    echo "Pulling ${remote} → ${local_dest} (node=${node})" >&2
    exec openclaw nodes copy \
      --node "$node" \
      --from "node:${remote}" \
      --to   "$local_dest"
    ;;

  push)
    [[ $# -ne 3 ]] && usage
    node="$1"; local_src="$2"; remote="$3"
    [[ -e "$local_src" ]] || die "local source does not exist: ${local_src}"

    # If the destination looks like a directory (trailing slash or existing dir
    # on the far side), append the basename so we don't get a "destination must
    # be a file" error from the copy plugin.
    if [[ "$remote" == */ ]]; then
      remote="${remote}$(basename "$local_src")"
    elif ! [[ "$remote" =~ \.[A-Za-z0-9]+$ ]]; then
      # no file extension → treat as folder
      remote="${remote%/}/$(basename "$local_src")"
    fi

    echo "Pushing ${local_src} → ${remote} (node=${node})" >&2
    exec openclaw nodes copy \
      --node "$node" \
      --from "$local_src" \
      --to   "node:${remote}" \
      --overwrite
    ;;

  -h|--help|help)
    usage
    ;;

  *)
    die "unknown action: $action (expected ls|pull|push)"
    ;;
esac
