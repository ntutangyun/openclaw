#!/usr/bin/env bash
set -euo pipefail

# ── sync-deployments.sh ─────────────────────────────────────────────────
# Sync the local openclaw build to Docker gateway and Windows toolbox node.
#
# Usage:
#   ./scripts/sync-deployments.sh status          Show version info for all targets
#   ./scripts/sync-deployments.sh build           Build openclaw from source
#   ./scripts/sync-deployments.sh docker          Build + rebuild Docker image
#   ./scripts/sync-deployments.sh toolbox         Build + update toolbox runtime tar(s)
#   ./scripts/sync-deployments.sh all             Build + sync both Docker and toolbox
#   ./scripts/sync-deployments.sh dist-zip        Build + create dist.zip for manual transfer
# ─────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLBOX_DIR="${OPENCLAW_TOOLBOX_DIR:-$HOME/Desktop/short-range-wireless-toolbox}"
MANAGE_SH="$REPO_ROOT/multi-user-support/manage.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()  { printf "${CYAN}▸${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }
header(){ printf "\n${BOLD}── %s ──${RESET}\n" "$*"; }

# ── Helpers ──────────────────────────────────────────────────────────────

get_source_version() {
  node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "?"
}

get_source_commit() {
  git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

get_source_dirty() {
  if git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null; then
    echo "clean"
  else
    echo "dirty"
  fi
}

get_build_info() {
  local build_info="$REPO_ROOT/dist/build-info.json"
  if [[ -f "$build_info" ]]; then
    node -p "
      const b = require('$build_info');
      JSON.stringify({version: b.version, commit: b.commit || 'null', builtAt: b.builtAt})
    " 2>/dev/null || echo '{"version":"?","commit":"?","builtAt":"?"}'
  else
    echo '{"version":"not built","commit":"?","builtAt":"?"}'
  fi
}

get_docker_info() {
  if ! docker image inspect openclaw:local >/dev/null 2>&1; then
    echo '{"version":"not built","commit":"?","builtAt":"?"}'
    return
  fi
  # Read build-info from the running image
  local info
  info="$(docker run --rm openclaw:local cat /app/dist/build-info.json 2>/dev/null || echo '{}')"
  local version commit builtAt
  version="$(echo "$info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).version}catch{}" 2>/dev/null || echo "?")"
  # Re-read for commit
  commit="$(echo "$info" | node -p "try{JSON.parse('$info').commit||'null'}catch{'?'}" 2>/dev/null || echo "?")"
  builtAt="$(echo "$info" | node -p "try{JSON.parse('$info').builtAt||'?'}catch{'?'}" 2>/dev/null || echo "?")"

  # Also get the image creation time and package.json version
  local pkg_version
  pkg_version="$(docker run --rm openclaw:local node -p "require('/app/package.json').version" 2>/dev/null || echo "?")"
  local img_created
  img_created="$(docker image inspect openclaw:local --format '{{.Created}}' 2>/dev/null | cut -d'.' -f1 || echo "?")"

  echo "{\"version\":\"$pkg_version\",\"buildInfoVersion\":\"$version\",\"commit\":\"$commit\",\"builtAt\":\"$builtAt\",\"imageCreated\":\"$img_created\"}"
}

get_toolbox_tar_info() {
  local tar_path="$1"
  if [[ ! -f "$tar_path" ]]; then
    echo '{"version":"not found","commit":"?","builtAt":"?"}'
    return
  fi
  # Extract build-info.json from tar without writing to disk
  local prefix
  prefix="$(tar -tf "$tar_path" 2>/dev/null | head -1 | cut -d'/' -f1)"
  local info
  info="$(tar -xf "$tar_path" --to-stdout "${prefix}/node_modules/openclaw/dist/build-info.json" 2>/dev/null || echo '{}')"
  if [[ -z "$info" || "$info" == "{}" ]]; then
    # Fallback: try package.json
    local pkg
    pkg="$(tar -xf "$tar_path" --to-stdout "${prefix}/node_modules/openclaw/package.json" 2>/dev/null || echo '{}')"
    local version
    version="$(echo "$pkg" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).version}catch{}" 2>/dev/null || echo "?")"
    echo "{\"version\":\"$version\",\"commit\":\"?\",\"builtAt\":\"?\"}"
    return
  fi
  echo "$info"
}

# ── Status ───────────────────────────────────────────────────────────────

cmd_status() {
  header "Source (working tree)"
  local src_version src_commit src_dirty
  src_version="$(get_source_version)"
  src_commit="$(get_source_commit)"
  src_dirty="$(get_source_dirty)"
  printf "  version:  ${BOLD}%s${RESET}\n" "$src_version"
  printf "  commit:   %s" "$src_commit"
  if [[ "$src_dirty" == "dirty" ]]; then
    printf " ${YELLOW}(uncommitted changes)${RESET}"
  fi
  printf "\n"

  header "Local build (dist/)"
  local build_json
  build_json="$(get_build_info)"
  local b_ver b_commit b_at
  b_ver="$(echo "$build_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null)"
  b_commit="$(echo "$build_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).commit" 2>/dev/null)"
  b_at="$(echo "$build_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).builtAt" 2>/dev/null)"
  printf "  version:  %s\n" "$b_ver"
  printf "  commit:   %s\n" "$b_commit"
  printf "  built:    %s\n" "$b_at"
  if [[ "$b_ver" != "$src_version" ]]; then
    warn "Build version ($b_ver) differs from source ($src_version) — rebuild needed"
  fi

  header "Docker gateway (openclaw:local)"
  if docker image inspect openclaw:local >/dev/null 2>&1; then
    local d_pkg d_bi_ver d_commit d_at d_created
    d_pkg="$(docker run --rm openclaw:local node -p "require('/app/package.json').version" 2>/dev/null || echo "?")"
    local d_info
    d_info="$(docker run --rm openclaw:local cat /app/dist/build-info.json 2>/dev/null || echo '{}')"
    d_bi_ver="$(echo "$d_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).version}catch{'?'}" 2>/dev/null || echo "?")"
    d_commit="$(echo "$d_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).commit||'null'}catch{'?'}" 2>/dev/null || echo "?")"
    d_at="$(echo "$d_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).builtAt||'?'}catch{'?'}" 2>/dev/null || echo "?")"
    d_created="$(docker image inspect openclaw:local --format '{{.Created}}' 2>/dev/null | cut -dT -f1 || echo "?")"
    printf "  version:  %s\n" "$d_pkg"
    printf "  commit:   %s\n" "$d_commit"
    printf "  built:    %s\n" "$d_at"
    printf "  image:    %s\n" "$d_created"
    if [[ "$d_pkg" != "$src_version" ]]; then
      warn "Docker version ($d_pkg) differs from source ($src_version)"
    elif [[ "$d_commit" == "null" && "$src_dirty" == "clean" ]]; then
      warn "Docker has no commit hash — consider rebuilding"
    fi
  else
    printf "  ${DIM}(image not found)${RESET}\n"
  fi

  header "Toolbox node tars ($TOOLBOX_DIR)"
  if [[ ! -d "$TOOLBOX_DIR/bundled/openclaw" ]]; then
    printf "  ${DIM}(toolbox not found at $TOOLBOX_DIR)${RESET}\n"
  else
    for tar_file in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*.tar; do
      [[ -f "$tar_file" ]] || continue
      local tar_name
      tar_name="$(basename "$tar_file" .tar)"
      local t_info t_ver t_commit t_at
      t_info="$(get_toolbox_tar_info "$tar_file")"
      t_ver="$(echo "$t_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).version}catch{'?'}" 2>/dev/null || echo "?")"
      t_commit="$(echo "$t_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).commit||'null'}catch{'?'}" 2>/dev/null || echo "?")"
      t_at="$(echo "$t_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).builtAt||'?'}catch{'?'}" 2>/dev/null || echo "?")"
      printf "  ${BOLD}%s${RESET}\n" "$tar_name"
      printf "    version:  %s\n" "$t_ver"
      printf "    commit:   %s\n" "$t_commit"
      printf "    built:    %s\n" "$t_at"
      if [[ "$t_ver" != "$src_version" ]]; then
        warn "  $tar_name ($t_ver) differs from source ($src_version)"
      fi
    done
    # Check unarchived runtime dirs too
    for rt_dir in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*/; do
      [[ -d "$rt_dir" ]] || continue
      local bi="$rt_dir/node_modules/openclaw/dist/build-info.json"
      local pk="$rt_dir/node_modules/openclaw/package.json"
      local dir_name
      dir_name="$(basename "$rt_dir")"
      if [[ -f "$bi" ]]; then
        local u_ver u_commit u_at
        u_ver="$(node -p "require('$bi').version" 2>/dev/null || echo "?")"
        u_commit="$(node -p "require('$bi').commit||'null'" 2>/dev/null || echo "?")"
        u_at="$(node -p "require('$bi').builtAt||'?'" 2>/dev/null || echo "?")"
        printf "  ${BOLD}%s${RESET} ${DIM}(unarchived)${RESET}\n" "$dir_name"
        printf "    version:  %s\n" "$u_ver"
        printf "    commit:   %s\n" "$u_commit"
        printf "    built:    %s\n" "$u_at"
      elif [[ -f "$pk" ]]; then
        local u_ver
        u_ver="$(node -p "require('$pk').version" 2>/dev/null || echo "?")"
        printf "  ${BOLD}%s${RESET} ${DIM}(unarchived)${RESET}\n" "$dir_name"
        printf "    version:  %s\n" "$u_ver"
      fi
    done
  fi

  # Summary
  header "Summary"
  local all_match=true
  if [[ -f "$REPO_ROOT/dist/build-info.json" ]]; then
    [[ "$b_ver" == "$src_version" ]] || all_match=false
  else
    all_match=false
  fi
  if docker image inspect openclaw:local >/dev/null 2>&1; then
    [[ "$d_pkg" == "$src_version" ]] || all_match=false
  fi
  for tar_file in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*.tar; do
    [[ -f "$tar_file" ]] || continue
    local chk_info chk_ver
    chk_info="$(get_toolbox_tar_info "$tar_file")"
    chk_ver="$(echo "$chk_info" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).version}catch{'?'}" 2>/dev/null || echo "?")"
    [[ "$chk_ver" == "$src_version" ]] || all_match=false
  done

  if [[ "$all_match" == "true" ]]; then
    ok "All targets are on version $src_version"
  else
    warn "Version mismatch detected — run './scripts/sync-deployments.sh all' to sync"
  fi
}

# ── Build ────────────────────────────────────────────────────────────────

cmd_build() {
  header "Building openclaw from source"
  info "Running pnpm build..."
  (cd "$REPO_ROOT" && pnpm build)
  ok "Build complete"

  local build_json
  build_json="$(get_build_info)"
  local b_ver b_commit b_at
  b_ver="$(echo "$build_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null)"
  b_commit="$(echo "$build_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).commit" 2>/dev/null)"
  b_at="$(echo "$build_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).builtAt" 2>/dev/null)"
  printf "  version: ${BOLD}%s${RESET}  commit: %s  built: %s\n" "$b_ver" "$b_commit" "$b_at"
}

# ── Docker ───────────────────────────────────────────────────────────────

cmd_docker() {
  cmd_build

  header "Rebuilding Docker image (openclaw:local)"
  info "Running docker build..."
  docker build \
    --network=host \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS:-}" \
    --build-arg "OPENCLAW_VARIANT=${OPENCLAW_VARIANT:-default}" \
    -t "openclaw:local" \
    -f "$REPO_ROOT/Dockerfile" \
    "$REPO_ROOT"
  ok "Docker image rebuilt"

  # Check for running containers that need restart
  local running=0
  for name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep "^openclaw-.*-gateway$" || true); do
    running=$((running + 1))
  done
  if [[ $running -gt 0 ]]; then
    warn "$running gateway container(s) running on the old image. Restart them:"
    for name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep "^openclaw-.*-gateway$" || true); do
      local user="${name#openclaw-}"
      user="${user%-gateway}"
      printf "    ${DIM}./multi-user-support/manage.sh restart %s${RESET}\n" "$user"
    done
  fi
}

# ── Toolbox ──────────────────────────────────────────────────────────────

cmd_toolbox() {
  if [[ ! -d "$TOOLBOX_DIR/bundled/openclaw" ]]; then
    fail "Toolbox not found at $TOOLBOX_DIR/bundled/openclaw. Set OPENCLAW_TOOLBOX_DIR to override."
  fi

  cmd_build

  header "Updating toolbox runtime tars"

  for tar_file in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*.tar; do
    [[ -f "$tar_file" ]] || continue
    local tar_name
    tar_name="$(basename "$tar_file" .tar)"
    info "Updating $tar_name..."

    # Extract the tar to a temp dir, replace dist/ and package.json, re-tar
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    tar -xf "$tar_file" -C "$tmp_dir"

    local openclaw_dir="$tmp_dir/$tar_name/node_modules/openclaw"
    if [[ ! -d "$openclaw_dir" ]]; then
      warn "Unexpected tar structure for $tar_name — skipping"
      rm -rf "$tmp_dir"
      continue
    fi

    # Replace dist/
    rm -rf "$openclaw_dir/dist"
    cp -r "$REPO_ROOT/dist" "$openclaw_dir/dist"

    # Update package.json version (keep existing deps/structure, just patch version)
    local src_version
    src_version="$(get_source_version)"
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$openclaw_dir/package.json', 'utf8'));
      pkg.version = '$src_version';
      fs.writeFileSync('$openclaw_dir/package.json', JSON.stringify(pkg, null, 2) + '\n');
    "

    # Update openclaw.mjs if it exists in source
    if [[ -f "$REPO_ROOT/openclaw.mjs" ]]; then
      cp "$REPO_ROOT/openclaw.mjs" "$openclaw_dir/openclaw.mjs"
    fi

    # Re-create the tar
    tar -cf "$tar_file" -C "$tmp_dir" "$tar_name"
    rm -rf "$tmp_dir"

    ok "$tar_name updated to $src_version"
  done

  # Also update unarchived runtime dirs if they exist
  for rt_dir in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*/; do
    [[ -d "$rt_dir/node_modules/openclaw" ]] || continue
    local dir_name
    dir_name="$(basename "$rt_dir")"
    info "Updating $dir_name (unarchived)..."

    local openclaw_dir="$rt_dir/node_modules/openclaw"
    rm -rf "$openclaw_dir/dist"
    cp -r "$REPO_ROOT/dist" "$openclaw_dir/dist"

    local src_version
    src_version="$(get_source_version)"
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$openclaw_dir/package.json', 'utf8'));
      pkg.version = '$src_version';
      fs.writeFileSync('$openclaw_dir/package.json', JSON.stringify(pkg, null, 2) + '\n');
    "

    if [[ -f "$REPO_ROOT/openclaw.mjs" ]]; then
      cp "$REPO_ROOT/openclaw.mjs" "$openclaw_dir/openclaw.mjs"
    fi

    ok "$dir_name updated to $src_version"
  done
}

# ── dist.zip ─────────────────────────────────────────────────────────────

cmd_dist_zip() {
  cmd_build

  header "Creating dist.zip"
  local zip_path="$REPO_ROOT/dist.zip"
  rm -f "$zip_path"
  (cd "$REPO_ROOT" && zip -r -q "$zip_path" dist/)
  local size
  size="$(du -sh "$zip_path" | cut -f1)"
  ok "dist.zip created ($size)"
  printf "  ${DIM}Manual transfer: copy dist.zip to Windows, then extract dist/ into${RESET}\n"
  printf "  ${DIM}%%APPDATA%%/NWRCAIToolbox/openclaw-runtime/node_modules/openclaw/${RESET}\n"
}

# ── All ──────────────────────────────────────────────────────────────────

cmd_all() {
  cmd_build

  header "Syncing Docker gateway"
  info "Running docker build..."
  docker build \
    --network=host \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS:-}" \
    --build-arg "OPENCLAW_VARIANT=${OPENCLAW_VARIANT:-default}" \
    -t "openclaw:local" \
    -f "$REPO_ROOT/Dockerfile" \
    "$REPO_ROOT"
  ok "Docker image rebuilt"

  if [[ -d "$TOOLBOX_DIR/bundled/openclaw" ]]; then
    # Reuse toolbox logic without rebuilding
    header "Updating toolbox runtime tars"
    for tar_file in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*.tar; do
      [[ -f "$tar_file" ]] || continue
      local tar_name
      tar_name="$(basename "$tar_file" .tar)"
      info "Updating $tar_name..."
      local tmp_dir
      tmp_dir="$(mktemp -d)"
      tar -xf "$tar_file" -C "$tmp_dir"
      local openclaw_dir="$tmp_dir/$tar_name/node_modules/openclaw"
      if [[ ! -d "$openclaw_dir" ]]; then
        warn "Unexpected tar structure for $tar_name — skipping"
        rm -rf "$tmp_dir"
        continue
      fi
      rm -rf "$openclaw_dir/dist"
      cp -r "$REPO_ROOT/dist" "$openclaw_dir/dist"
      local src_version
      src_version="$(get_source_version)"
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$openclaw_dir/package.json', 'utf8'));
        pkg.version = '$src_version';
        fs.writeFileSync('$openclaw_dir/package.json', JSON.stringify(pkg, null, 2) + '\n');
      "
      if [[ -f "$REPO_ROOT/openclaw.mjs" ]]; then
        cp "$REPO_ROOT/openclaw.mjs" "$openclaw_dir/openclaw.mjs"
      fi
      tar -cf "$tar_file" -C "$tmp_dir" "$tar_name"
      rm -rf "$tmp_dir"
      ok "$tar_name updated to $src_version"
    done
    for rt_dir in "$TOOLBOX_DIR"/bundled/openclaw/runtime-*/; do
      [[ -d "$rt_dir/node_modules/openclaw" ]] || continue
      local dir_name
      dir_name="$(basename "$rt_dir")"
      info "Updating $dir_name (unarchived)..."
      local openclaw_dir="$rt_dir/node_modules/openclaw"
      rm -rf "$openclaw_dir/dist"
      cp -r "$REPO_ROOT/dist" "$openclaw_dir/dist"
      local src_version
      src_version="$(get_source_version)"
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$openclaw_dir/package.json', 'utf8'));
        pkg.version = '$src_version';
        fs.writeFileSync('$openclaw_dir/package.json', JSON.stringify(pkg, null, 2) + '\n');
      "
      if [[ -f "$REPO_ROOT/openclaw.mjs" ]]; then
        cp "$REPO_ROOT/openclaw.mjs" "$openclaw_dir/openclaw.mjs"
      fi
      ok "$dir_name updated to $src_version"
    done
  else
    warn "Toolbox not found at $TOOLBOX_DIR — skipping toolbox sync"
  fi

  # Also create dist.zip for manual transfer
  header "Creating dist.zip"
  local zip_path="$REPO_ROOT/dist.zip"
  rm -f "$zip_path"
  (cd "$REPO_ROOT" && zip -r -q "$zip_path" dist/)
  ok "dist.zip created ($(du -sh "$zip_path" | cut -f1))"

  header "Done"
  ok "All targets synced. Run './scripts/sync-deployments.sh status' to verify."
}

# ── Main ─────────────────────────────────────────────────────────────────

usage() {
  printf "${BOLD}sync-deployments.sh${RESET} — sync openclaw builds across deployment targets\n"
  printf "\n"
  printf "${BOLD}Usage:${RESET}\n"
  printf "  %s <command>\n" "$(basename "$0")"
  printf "\n"
  printf "${BOLD}Commands:${RESET}\n"
  printf "  status      Show version info for source, Docker, and toolbox targets\n"
  printf "  build       Build openclaw from source only\n"
  printf "  docker      Build + rebuild Docker image (openclaw:local)\n"
  printf "  toolbox     Build + update toolbox runtime tar(s)\n"
  printf "  all         Build + sync Docker + toolbox + create dist.zip\n"
  printf "  dist-zip    Build + create dist.zip for manual transfer\n"
  printf "\n"
  printf "${BOLD}Environment:${RESET}\n"
  printf "  OPENCLAW_TOOLBOX_DIR    Path to short-range-wireless-toolbox\n"
  printf "                          (default: ~/Desktop/short-range-wireless-toolbox)\n"
  printf "  OPENCLAW_EXTENSIONS     Space-separated extensions for Docker build\n"
  printf "  OPENCLAW_VARIANT        Docker variant: default or slim\n"
}

case "${1:-}" in
  status)   cmd_status ;;
  build)    cmd_build ;;
  docker)   cmd_docker ;;
  toolbox)  cmd_toolbox ;;
  all)      cmd_all ;;
  dist-zip) cmd_dist_zip ;;
  -h|--help|help) usage ;;
  *)
    if [[ -n "${1:-}" ]]; then
      fail "Unknown command: $1"
    fi
    usage
    ;;
esac
