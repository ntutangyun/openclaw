#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
USERS_DIR="$SCRIPT_DIR/users"
SETUP_MARKER="$SCRIPT_DIR/.setup-done"

# Custom workspace skills are sourced from this directory and bind-mounted
# read-only at /home/node/.openclaw/workspace/skills inside every user container.
SKILLS_DIR="$SCRIPT_DIR/skills"

# Default image: use the same as the main repo, fallback to published image
DEFAULT_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"

# Port allocation: each user gets a pair (gateway, bridge) starting from a base
BASE_GATEWAY_PORT="${OPENCLAW_MULTI_BASE_PORT:-19000}"

# China-friendly mirrors (overridable via env vars).
# Docker Hub proxy: used as a prefix for base images, e.g. <mirror>/library/node:24-bookworm.
# Common options: docker.1ms.run, docker.m.daocloud.io.
CHINA_DOCKER_MIRROR="${OPENCLAW_CHINA_DOCKER_MIRROR:-docker.1ms.run}"
# npm registry mirror (pnpm install, corepack prepare).
CHINA_NPM_REGISTRY="${OPENCLAW_CHINA_NPM_REGISTRY:-https://registry.npmmirror.com}"
# PyPI mirror index (pip install markitdown, python-docx, python-pptx).
CHINA_PIP_INDEX="${OPENCLAW_CHINA_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [options]

Setup:
  setup                                             Build Docker image and prepare environment
  rebuild                                           Rebuild Docker image (e.g. after git pull)
  rebuild-china                                     Rebuild with China-friendly mirrors
  cache-warm                                        Pre-seed the BuildKit pnpm cache from the host pnpm
                                                    store (~/.local/share/pnpm/store). Run once before
                                                    the first rebuild to avoid a cold 12-min pnpm fetch.

User management:
  add       <username>                              Create and start a new user gateway
  remove    <username>                              Stop, remove containers/volumes/config
  start     <username>                              Start a user gateway
  stop      <username>                              Stop a user gateway
  restart   <username>                              Restart a user gateway
  start-all                                         Start all user gateways
  stop-all                                          Stop all user gateways
  pair-device <username> [timeout]                    Watch and auto-approve pairing requests
  ask-off     <username> [node-name]                  Disable exec approval prompts (security=full, ask=off)

Info:
  status    [username]                              Show status (all users or one)
  list                                              List all configured users
  logs      <username> [-f]                         Show gateway logs
  export-logs <username>                             Export all logs + generate HTML report
  cli       <username> [args...]                    Run openclaw-cli for a user
  token     <username>                              Show gateway token for a user
  info      <username>                              Show connection details

Ollama:
  sync-ollama    <username> [ollama-host]               Sync Ollama models to user gateway
                                                        (Ollama Web Search uses the same
                                                        baseUrl via runtime fallback)
  list-ollama    [ollama-host]                          List available Ollama models
  restart-ollama [ollama-host]                          Force-unload every loaded model (keep_alive=0)
                                                        to recover from a wedged Ollama runner
                                                        (e.g. size_vram=0 after load, 300 s no-reply
                                                        timeouts). Next request cold-loads cleanly.

vLLM:
  sync-vllm   <username> [vllm-host]                   Sync vLLM models to user gateway
  list-vllm   [vllm-host]                              List available vLLM models

Environment variables:
  OPENCLAW_IMAGE              Docker image (default: openclaw:local)
  OPENCLAW_MULTI_BASE_PORT    Base port for auto-assignment (default: 19000)
  OPENCLAW_EXTENSIONS         Space-separated extensions to include in build
  OPENCLAW_VARIANT            Image variant: "default" or "slim"
  OPENCLAW_MARKITDOWN_EXTRAS  markitdown pip extras to install (default: "docx,pptx"
                              for faster builds; set to "all" to restore the
                              upstream Office+PDF+xlsx+audio+youtube bundle)
  OPENCLAW_DOCKER_APT_UPGRADE Set to "1" to run apt-get upgrade during build
                              (default: 0 — skipped; saves 1-3 min on low-bandwidth
                              hosts. The pinned node base image already ships
                              weekly security patches)
  OLLAMA_HOST                 Ollama API host (default: http://localhost:11434)
  VLLM_HOST                   vLLM API host (default: http://localhost:8000)
  OPENCLAW_OLLAMA_CTX_CAP     Cap the num_ctx written to openclaw.json by
                              sync-ollama (default: 0 = no cap; use the
                              native context_length reported by /api/show).
                              Ollama pre-allocates the full KV cache at load,
                              so overly large values can trip the LLM idle
                              watchdog on memory-constrained hosts. The
                              preferred mitigation is to raise
                              agents.defaults.llm.idleTimeoutSeconds (which
                              ensure_llm_idle_timeout backfills to 300s).
                              Use this cap only when you cannot fit the
                              model's native KV cache in RAM at all.
EOF
  exit 1
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing dependency: $1"
}

require_setup() {
  if [[ ! -f "$SETUP_MARKER" ]]; then
    fail "Docker environment not set up yet. Run '$(basename "$0") setup' first."
  fi
}

validate_username() {
  local name="$1"
  if [[ -z "$name" ]]; then
    fail "Username cannot be empty."
  fi
  if [[ ! "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
    fail "Username must start with alphanumeric and contain only [a-zA-Z0-9_-]."
  fi
  if [[ ${#name} -gt 32 ]]; then
    fail "Username must be 32 characters or fewer."
  fi
}

user_dir() {
  echo "$USERS_DIR/$1"
}

user_env_file() {
  echo "$(user_dir "$1")/.env"
}

user_compose_file() {
  echo "$(user_dir "$1")/docker-compose.yml"
}

user_exists() {
  [[ -d "$(user_dir "$1")" && -f "$(user_env_file "$1")" ]]
}

# Collect all gateway ports currently allocated by existing users
allocated_ports() {
  if [[ ! -d "$USERS_DIR" ]]; then
    return
  fi
  for env_file in "$USERS_DIR"/*/.env; do
    [[ -f "$env_file" ]] || continue
    grep '^OPENCLAW_GATEWAY_PORT=' "$env_file" 2>/dev/null | cut -d= -f2
  done
}

# Check if a port is bound on the host (catches non-managed conflicts)
port_in_use_on_host() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :${port}" 2>/dev/null | grep -q . && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -q ":${port} " && return 0
  fi
  return 1
}

# Find the first available port pair starting from BASE_GATEWAY_PORT,
# skipping any port already allocated to an existing user or bound on the host.
next_available_port() {
  local used
  used=" $(allocated_ports | tr '\n' ' ')"
  local candidate=$BASE_GATEWAY_PORT
  while true; do
    local bridge=$((candidate + 1))
    # Skip if allocated to another user
    if [[ "$used" == *" ${candidate} "* ]]; then
      candidate=$((candidate + 2))
      continue
    fi
    # Skip if either port is already bound on the host
    if port_in_use_on_host "$candidate" || port_in_use_on_host "$bridge"; then
      candidate=$((candidate + 2))
      continue
    fi
    echo "$candidate"
    return
  done
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c "import secrets; print(secrets.token_hex(32))"
  fi
}

compose_cmd() {
  local username="$1"
  shift
  docker compose \
    -p "openclaw-${username}" \
    -f "$(user_compose_file "$username")" \
    --env-file "$(user_env_file "$username")" \
    "$@"
}

generate_compose_file() {
  local name="$1"
  local gw_port="$2"
  local br_port="$3"
  local config_vol="openclaw-${name}-config"
  local workspace_vol="openclaw-${name}-workspace"

  local network_name="openclaw-${name}-net"

  cat > "$(user_compose_file "$name")" <<YAML
networks:
  ${network_name}:
    driver: bridge

services:
  openclaw-gateway:
    image: \${OPENCLAW_IMAGE:-openclaw:local}
    container_name: openclaw-${name}-gateway
    networks:
      - ${network_name}
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: \${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}
      # ── Verbose logging & diagnostics ──
      OPENCLAW_LOG_LEVEL: debug
      OPENCLAW_RAW_STREAM: "1"
      OPENCLAW_RAW_STREAM_PATH: /home/node/.openclaw/logs/raw-stream.jsonl
      OPENCLAW_CACHE_TRACE: "1"
      OPENCLAW_CACHE_TRACE_FILE: /home/node/.openclaw/logs/cache-trace.jsonl
      OPENCLAW_CACHE_TRACE_MESSAGES: "1"
      OPENCLAW_CACHE_TRACE_PROMPT: "1"
      OPENCLAW_CACHE_TRACE_SYSTEM: "1"
      OPENCLAW_DIAGNOSTICS: "*"
    volumes:
      - ${config_vol}:/home/node/.openclaw
      - ${workspace_vol}:/home/node/.openclaw/workspace
      - \${OPENCLAW_SKILLS_DIR}:/home/node/.openclaw/workspace/skills:ro
    ports:
      - "${gw_port}:18789"
      - "${br_port}:18790"
    dns:
      - 8.8.8.8
      - 8.8.4.4
    logging:
      driver: json-file
      options:
        max-size: "200m"
        max-file: "5"
    init: true
    restart: unless-stopped
    command:
      [
        "node",
        "--max-old-space-size=4096",
        "dist/index.js",
        "gateway",
        "--bind",
        "\${OPENCLAW_GATEWAY_BIND:-lan}",
        "--port",
        "18789",
        "--verbose",
      ]
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

  openclaw-cli:
    image: \${OPENCLAW_IMAGE:-openclaw:local}
    container_name: openclaw-${name}-cli
    networks:
      - ${network_name}
    dns:
      - 8.8.8.8
      - 8.8.4.4
    cap_drop:
      - NET_RAW
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      OPENCLAW_GATEWAY_URL: ws://openclaw-gateway:18789
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1"
      BROWSER: echo
    volumes:
      - ${config_vol}:/home/node/.openclaw
      - ${workspace_vol}:/home/node/.openclaw/workspace
      - \${OPENCLAW_SKILLS_DIR}:/home/node/.openclaw/workspace/skills:ro
    stdin_open: true
    tty: true
    init: true
    entrypoint: ["node", "dist/index.js"]
    depends_on:
      - openclaw-gateway

volumes:
  ${config_vol}:
  ${workspace_vol}:
YAML
}

# Ensure the user's .env has OPENCLAW_SKILLS_DIR pointing at the current repo,
# and the compose file has the read-only skills bind-mount on both services.
# Idempotent: safe to call on every start/restart.
ensure_tools_deny() {
  # Backfill the sub-agent tools.deny list into an existing user's
  # openclaw.json. Users provisioned before the default-deny change
  # (ccef2168fc) never had these entries written, which lets the agent
  # discover and call `sessions_spawn` etc. — a regression that showed up
  # on 2026-04-23 Run #15 when gemma escaped into a sub-agent spawn
  # attempt and stalled. Helper is idempotent so it is safe to run on
  # every start/restart path.
  local username="$1"
  local container="openclaw-${username}-gateway"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
    return 0
  fi

  local output
  output="$(docker exec "$container" node -e '
    const fs = require("fs");
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (!fs.existsSync(cfgPath)) process.exit(0);
    const REQUIRED = [
      "sessions_spawn",
      "sessions_send",
      "sessions_yield",
      "sessions_list",
      "sessions_history",
      "subagents",
      "agents_list"
    ];
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
    catch { process.exit(0); }
    if (!cfg.tools) cfg.tools = {};
    const existing = Array.isArray(cfg.tools.deny) ? cfg.tools.deny : [];
    const merged = Array.from(new Set([...existing, ...REQUIRED]));
    if (merged.length === existing.length) process.exit(0);
    cfg.tools.deny = merged;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log("updated");
  ' 2>&1)"
  if [[ "$output" == *updated* ]]; then
    echo "==> Backfilled sub-agent tools.deny for '$username'; recreating gateway to apply..."
    compose_cmd "$username" up -d --force-recreate openclaw-gateway >/dev/null
  fi
}

ensure_llm_idle_timeout() {
  # Backfill agents.defaults.llm.idleTimeoutSeconds into an existing user's
  # openclaw.json. The upstream default (120s) was calibrated for cloud
  # providers; self-hosted Ollama on a memory-constrained host (Jetson Orin,
  # anything that has to swap or cold-reload between turns) regularly exceeds
  # 120s just loading the model + allocating a large KV cache. See
  # local_modal_support/qwen3_5/README.md for the measurements.
  # Helper is idempotent: if the key is already set to any positive value we
  # leave it alone. Default bumped to 300s.
  local username="$1"
  local container="openclaw-${username}-gateway"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
    return 0
  fi

  local desired="${OPENCLAW_LLM_IDLE_TIMEOUT_SECONDS:-300}"
  local output
  output="$(docker exec "$container" node -e "
    const fs = require('fs');
    const cfgPath = '/home/node/.openclaw/openclaw.json';
    if (!fs.existsSync(cfgPath)) process.exit(0);
    const desired = Number(process.argv[1]) || 300;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch { process.exit(0); }
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.llm) cfg.agents.defaults.llm = {};
    const current = cfg.agents.defaults.llm.idleTimeoutSeconds;
    if (typeof current === 'number' && current > 0) process.exit(0);
    cfg.agents.defaults.llm.idleTimeoutSeconds = desired;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('updated');
  " "$desired" 2>&1)"
  if [[ "$output" == *updated* ]]; then
    echo "==> Backfilled agents.defaults.llm.idleTimeoutSeconds=${desired}s for '$username'; recreating gateway to apply..."
    compose_cmd "$username" up -d --force-recreate openclaw-gateway >/dev/null
  fi
}

ensure_agents_skills_allow() {
  # Backfill agents.defaults.skills with a conservative allowlist. Small local
  # models (ollama/qwen3.5:4b, ollama/gemma4:e4b) pattern-match on the majority
  # `<location>` template in the `<available_skills>` system-prompt block and
  # substitute the bundled `/app/skills/<name>/SKILL.md` path for workspace
  # skills, producing ENOENT + a silent terminal turn. Probing in
  # local_modal_support/qwen3_5/probes/ shows 4/5 wrong-path substitutions with
  # the default 7-bundled + 1-workspace prompt, vs 4/5 correct reads when the
  # prompt contains only the workspace skill.
  #
  # Helper is idempotent: if the key is already set to any array value we leave
  # it alone. Override via OPENCLAW_AGENTS_SKILLS_ALLOW (comma-separated), or
  # set to the literal "-" to skip the backfill entirely.
  local username="$1"
  local container="openclaw-${username}-gateway"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
    return 0
  fi

  local desired="${OPENCLAW_AGENTS_SKILLS_ALLOW:-ieee-meeting-report}"
  if [[ "$desired" == "-" ]]; then
    return 0
  fi

  local output
  output="$(docker exec "$container" node -e "
    const fs = require('fs');
    const cfgPath = '/home/node/.openclaw/openclaw.json';
    if (!fs.existsSync(cfgPath)) process.exit(0);
    const desired = String(process.argv[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (desired.length === 0) process.exit(0);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch { process.exit(0); }
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (Array.isArray(cfg.agents.defaults.skills)) process.exit(0);
    cfg.agents.defaults.skills = desired;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('updated');
  " "$desired" 2>&1)"
  if [[ "$output" == *updated* ]]; then
    echo "==> Backfilled agents.defaults.skills=[${desired}] for '$username'; recreating gateway to apply..."
    compose_cmd "$username" up -d --force-recreate openclaw-gateway >/dev/null
  fi
}

ensure_skills_wiring() {
  local username="$1"
  local env_file compose_file
  env_file="$(user_env_file "$username")"
  compose_file="$(user_compose_file "$username")"

  [[ -f "$env_file" ]] || return 0
  [[ -d "$SKILLS_DIR" ]] || return 0

  # 1) Sync OPENCLAW_SKILLS_DIR in .env to the current on-disk location.
  if grep -q '^OPENCLAW_SKILLS_DIR=' "$env_file" 2>/dev/null; then
    # portable in-place edit (works on GNU and BSD sed)
    local tmp
    tmp="$(mktemp)"
    sed "s#^OPENCLAW_SKILLS_DIR=.*#OPENCLAW_SKILLS_DIR=${SKILLS_DIR}#" "$env_file" > "$tmp"
    mv "$tmp" "$env_file"
  else
    echo "OPENCLAW_SKILLS_DIR=${SKILLS_DIR}" >> "$env_file"
  fi

  # 2) Patch the compose file if the skills mount line is missing for either service.
  if [[ -f "$compose_file" ]] \
     && ! grep -q 'workspace/skills:ro' "$compose_file" 2>/dev/null; then
    echo "==> Patching compose file to add workspace/skills bind-mount..."
    # Insert the skills mount line after every workspace volume line.
    # The leading 6 spaces match the current indent on volume entries.
    local tmp
    tmp="$(mktemp)"
    awk '
      {
        print
        if ($0 ~ /^      - .+:\/home\/node\/\.openclaw\/workspace$/) {
          print "      - ${OPENCLAW_SKILLS_DIR}:/home/node/.openclaw/workspace/skills:ro"
        }
      }
    ' "$compose_file" > "$tmp"
    mv "$tmp" "$compose_file"
  fi
}

# List all configured usernames (helper for iterating)
all_usernames() {
  if [[ ! -d "$USERS_DIR" ]]; then
    return
  fi
  for udir in "$USERS_DIR"/*/; do
    [[ -d "$udir" ]] || continue
    local name
    name="$(basename "$udir")"
    user_exists "$name" && echo "$name"
  done
}

# ── Setup & Build ─────────────────────────────────────────────

build_image() {
  local dockerfile="$REPO_ROOT/Dockerfile"
  if [[ ! -f "$dockerfile" ]]; then
    fail "Dockerfile not found at $dockerfile. Make sure this folder is inside the openclaw repo."
  fi

  # Lean defaults for multi-user-support builds:
  #   OPENCLAW_MARKITDOWN_EXTRAS=docx,pptx — drops pandas (79 MB),
  #     speech_recognition (43 MB), pdf stack, Azure SDK, youtube-transcript-api
  #     etc. from the image. The multi-user-support workflows only need
  #     Office-file extraction for the bundled skills.
  #     Override with `OPENCLAW_MARKITDOWN_EXTRAS=all bash manage.sh rebuild`
  #     to restore the upstream full-extras bundle.
  #   OPENCLAW_DOCKER_APT_UPGRADE=0 — skip the `apt-get upgrade -y` on the
  #     already-fresh node:24-bookworm base. Saves 1-3 min on low-bandwidth
  #     / low-CPU hosts (Jetson) and has no practical security impact as long
  #     as the base image digest is pinned and rebuilt periodically.
  echo "==> Building Docker image: $DEFAULT_IMAGE"
  docker build \
    --network=host \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS:-}" \
    --build-arg "OPENCLAW_VARIANT=${OPENCLAW_VARIANT:-default}" \
    --build-arg "OPENCLAW_MARKITDOWN_EXTRAS=${OPENCLAW_MARKITDOWN_EXTRAS:-docx,pptx}" \
    --build-arg "OPENCLAW_DOCKER_APT_UPGRADE=${OPENCLAW_DOCKER_APT_UPGRADE:-0}" \
    -t "$DEFAULT_IMAGE" \
    -f "$dockerfile" \
    "$REPO_ROOT"
}

write_setup_marker() {
  cat > "$SETUP_MARKER" <<EOF
image=$DEFAULT_IMAGE
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo_commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
EOF
}

cmd_setup() {
  echo "==> Checking prerequisites"
  require_cmd docker
  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose not available (try: docker compose version)"
  fi
  echo "  Docker:         $(docker --version)"
  echo "  Docker Compose: $(docker compose version --short)"

  if [[ ! -f "$REPO_ROOT/Dockerfile" ]]; then
    fail "Cannot find Dockerfile at $REPO_ROOT/Dockerfile. Ensure multi-user-support/ is inside the openclaw repo root."
  fi

  build_image

  # Verify the image exists
  if ! docker image inspect "$DEFAULT_IMAGE" >/dev/null 2>&1; then
    fail "Image build failed — $DEFAULT_IMAGE not found."
  fi

  mkdir -p "$USERS_DIR"
  write_setup_marker

  echo ""
  echo "==> Setup complete"
  echo "  Image:  $DEFAULT_IMAGE"
  echo "  Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  echo ""
  echo "Add users with:"
  echo "  $(basename "$0") add <username>"
}

cmd_rebuild() {
  build_image
  write_setup_marker

  echo ""
  echo "==> Rebuild complete ($DEFAULT_IMAGE)"

  # Count running users
  local running=0
  while IFS= read -r name; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^openclaw-${name}-gateway$"; then
      running=$((running + 1))
    fi
  done < <(all_usernames)

  if (( running > 0 )); then
    echo ""
    echo "  $running user gateway(s) running on the old image."
    echo "  Restart them to use the new image:"
    echo "    $(basename "$0") stop-all && $(basename "$0") start-all"
  fi
}

# Rebuild with China-friendly mirrors.
#
# Overrides the Docker Hub base images to pull through a Chinese Docker
# registry proxy (default: docker.1ms.run, overridable via
# OPENCLAW_CHINA_DOCKER_MIRROR).  Also sets the npm registry to npmmirror.com
# (Taobao mirror) and the pip index to the Tsinghua PyPI mirror, so every
# package download during the build goes through domestic mirrors.
#
# The digests pinned in the default Dockerfile are dropped because they are
# registry-specific; the build relies on the :24-bookworm tag instead.
#
# If you have Docker daemon registry-mirrors configured in
# /etc/docker/daemon.json, the Docker Hub proxy step may be redundant for
# image pulls — but the build-arg override still helps when daemon mirrors
# are not set up or are unreliable.
cmd_rebuild_china() {
  local dockerfile="$REPO_ROOT/Dockerfile"
  if [[ ! -f "$dockerfile" ]]; then
    fail "Dockerfile not found at $dockerfile. Make sure this folder is inside the openclaw repo."
  fi

  local node_image="${CHINA_DOCKER_MIRROR}/library/node:24-bookworm"
  local node_slim_image="${CHINA_DOCKER_MIRROR}/library/node:24-bookworm-slim"

  echo "==> Building Docker image with China mirrors: $DEFAULT_IMAGE"
  echo "    Docker mirror: ${CHINA_DOCKER_MIRROR}"
  echo "    npm registry:  ${CHINA_NPM_REGISTRY}"
  echo "    pip index:     ${CHINA_PIP_INDEX}"
  echo ""

  docker build \
    --network=host \
    --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS:-}" \
    --build-arg "OPENCLAW_VARIANT=${OPENCLAW_VARIANT:-default}" \
    --build-arg "OPENCLAW_MARKITDOWN_EXTRAS=${OPENCLAW_MARKITDOWN_EXTRAS:-docx,pptx}" \
    --build-arg "OPENCLAW_DOCKER_APT_UPGRADE=${OPENCLAW_DOCKER_APT_UPGRADE:-0}" \
    --build-arg "OPENCLAW_NODE_BOOKWORM_IMAGE=${node_image}" \
    --build-arg "OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE=${node_slim_image}" \
    --build-arg "OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST=" \
    --build-arg "OPENCLAW_NPM_REGISTRY=${CHINA_NPM_REGISTRY}" \
    --build-arg "OPENCLAW_PIP_INDEX_URL=${CHINA_PIP_INDEX}" \
    -t "$DEFAULT_IMAGE" \
    -f "$dockerfile" \
    "$REPO_ROOT"

  write_setup_marker

  echo ""
  echo "==> Rebuild complete ($DEFAULT_IMAGE)"
  echo ""
  echo "To improve reliability, consider configuring Docker daemon registry mirrors:"
  echo "  sudo tee /etc/docker/daemon.json <<'EOF'"
  echo "  {"
  echo "    \"registry-mirrors\": [\"https://${CHINA_DOCKER_MIRROR}\"]"
  echo "  }"
  echo "  EOF"
  echo "  sudo systemctl restart docker"

  # Count running users
  local running=0
  while IFS= read -r name; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^openclaw-${name}-gateway$"; then
      running=$((running + 1))
    fi
  done < <(all_usernames)

  if (( running > 0 )); then
    echo ""
    echo "  $running user gateway(s) running on the old image."
    echo "  Restart them to use the new image:"
    echo "    $(basename "$0") stop-all && $(basename "$0") start-all"
  fi
}

# One-time pre-seed of the BuildKit pnpm cache from the host's pnpm store.
#
# The main Dockerfile uses a BuildKit cache mount to persist the pnpm store
# across builds. That makes the SECOND and subsequent builds fast (~1-2 min
# for the install step), but the very FIRST build on a fresh cache starts
# empty and re-downloads every tarball from npm registry (~12 min on Jetson
# over home broadband).
#
# This command feeds the cache once using the host's existing pnpm store,
# which normally already has every tarball the lockfile needs. Subsequent
# `manage.sh rebuild` invocations then read from a warm cache.
#
# The technique: issue a tiny dedicated `docker build` whose only purpose
# is to `cp -a` from a build context (the host pnpm store dir) into the
# same cache mount the main Dockerfile uses. BuildKit treats the write
# as persistent.
cmd_cache_warm() {
  require_cmd docker
  local host_store
  host_store="${OPENCLAW_HOST_PNPM_STORE:-$HOME/.local/share/pnpm/store}"

  if [[ ! -d "$host_store" ]]; then
    fail "Host pnpm store not found at $host_store. Set OPENCLAW_HOST_PNPM_STORE=<path> if it lives elsewhere. Install pnpm and run \`pnpm install\` against this repo at least once to populate it."
  fi

  local size
  size="$(du -sh "$host_store" 2>/dev/null | cut -f1 || echo '?')"
  echo "==> Pre-seeding BuildKit pnpm cache from $host_store ($size)"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  # Tiny dedicated Dockerfile whose only job is to copy the host pnpm store
  # into the cache mount the real Dockerfile shares (same id).
  cat > "$tmpdir/Dockerfile.cache-warm" <<'WARMDF'
# syntax=docker/dockerfile:1.7
FROM alpine:3.20 AS warm
RUN --mount=type=bind,from=host-pnpm-store,target=/src,readonly \
    --mount=type=cache,id=openclaw-pnpm-store,target=/dst,sharing=locked \
    echo "==> Copying host pnpm store into BuildKit cache..." && \
    apk add --no-cache --quiet rsync 2>/dev/null || true && \
    cp -a /src/. /dst/ && \
    du -sh /dst
WARMDF

  docker build \
    --network=host \
    --build-context "host-pnpm-store=$host_store" \
    -t openclaw-cache-warm-sentinel \
    -f "$tmpdir/Dockerfile.cache-warm" \
    "$tmpdir"

  # The sentinel image itself is useless; remove it to free the layer.
  docker image rm -f openclaw-cache-warm-sentinel >/dev/null 2>&1 || true

  echo ""
  echo "==> Cache-warm complete. The next \`$(basename "$0") rebuild\` should reuse the seeded store."
}

# ── User Commands ─────────────────────────────────────────────

cmd_add() {
  require_setup
  local username="${1:-}"
  [[ -z "$username" ]] && fail "Usage: $(basename "$0") add <username>"
  validate_username "$username"

  if user_exists "$username"; then
    fail "User '$username' already exists. Use 'remove' first to recreate."
  fi

  local gateway_port
  gateway_port="$(next_available_port)"
  local bridge_port=$((gateway_port + 1))
  local token
  token="$(generate_token)"

  local udir
  udir="$(user_dir "$username")"
  mkdir -p "$udir"

  # Write per-user .env
  cat > "$(user_env_file "$username")" <<EOF
OPENCLAW_USER=${username}
OPENCLAW_GATEWAY_PORT=${gateway_port}
OPENCLAW_BRIDGE_PORT=${bridge_port}
OPENCLAW_GATEWAY_TOKEN=${token}
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_IMAGE=${DEFAULT_IMAGE}
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=
OPENCLAW_SKILLS_DIR=${SKILLS_DIR}
EOF

  # Generate compose file with literal volume names for this user
  generate_compose_file "$username" "$gateway_port" "$bridge_port"

  # Make sure the skills bind-mount is present (idempotent; no-op on fresh add).
  ensure_skills_wiring "$username"

  # Fix volume permissions so the container's node user (uid 1000) can write
  echo "==> Fixing volume permissions..."
  compose_cmd "$username" run --rm --user root --entrypoint sh openclaw-cli -c \
    'mkdir -p /home/node/.openclaw/identity /home/node/.openclaw/agents/main/agent /home/node/.openclaw/agents/main/sessions /home/node/.openclaw/logs && find /home/node/.openclaw -path /home/node/.openclaw/workspace/skills -prune -o -exec chown node:node {} +'

  # Start the gateway
  echo "==> Starting gateway for '$username'..."
  compose_cmd "$username" up -d openclaw-gateway

  # Run interactive onboarding
  echo ""
  echo "==> Running onboarding for '$username'..."
  compose_cmd "$username" run --rm openclaw-cli onboard --mode local --no-install-daemon

  # Pin gateway defaults after onboarding.
  # Use the compose-scoped volume name (project prefix + volume name).
  local compose_project="openclaw-${username}"
  local config_vol="${compose_project}_openclaw-${username}-config"

  # Fix permissions after onboarding (may have created files as root)
  docker run --rm --user root \
    -v "${config_vol}:/home/node/.openclaw" \
    "$DEFAULT_IMAGE" \
    chown -R node:node /home/node/.openclaw

  # Apply all post-onboarding config in a single container run.
  # This replaces 15 separate docker-run calls (each with full Node cold-start)
  # with one lightweight shell invocation that merges JSON via node -e.
  echo "==> Applying post-onboarding config..."
  docker run --rm \
    -v "${config_vol}:/home/node/.openclaw" \
    -e HOME=/home/node \
    --user node \
    "$DEFAULT_IMAGE" \
    sh -c '
      CFG=/home/node/.openclaw/openclaw.json

      # Merge our overrides into whatever onboarding wrote
      node -e "
        const fs = require(\"fs\");
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); } catch {}
        const overrides = JSON.parse(process.argv[2]);
        // Deep-merge one level (top-level keys are objects)
        for (const [k, v] of Object.entries(overrides)) {
          if (typeof v === \"object\" && v !== null && !Array.isArray(v)) {
            cfg[k] = { ...cfg[k], ...v };
          } else {
            cfg[k] = v;
          }
        }
        fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + \"\n\");
      " "$CFG" '"'"'{
        "gateway": {
          "mode": "local",
          "bind": "lan",
          "controlUi": {
            "dangerouslyAllowHostHeaderOriginFallback": true,
            "dangerouslyDisableDeviceAuth": true,
            "allowedOrigins": ["http://localhost:5173"]
          },
          "nodes": {
            "allowCommands": ["system.run","system.run.prepare","system.which","system.notify","browser.proxy"]
          }
        },
        "tools": {
          "exec": {
            "security": "full",
            "ask": "off"
          },
          "deny": [
            "sessions_spawn",
            "sessions_send",
            "sessions_yield",
            "sessions_list",
            "sessions_history",
            "subagents",
            "agents_list"
          ]
        },
        "logging": {
          "level": "debug",
          "consoleLevel": "debug",
          "consoleStyle": "json",
          "file": "/home/node/.openclaw/logs/gateway.log"
        },
        "diagnostics": {
          "enabled": true,
          "flags": ["*"]
        }
      }'"'"'

      # Write exec-approvals.json
      cat > /home/node/.openclaw/exec-approvals.json <<APPROVALS
{
  "version": 1,
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full",
    "autoAllowSkills": true
  }
}
APPROVALS
    '

  # Recreate gateway to pick up onboarding config
  compose_cmd "$username" up -d --force-recreate openclaw-gateway

  echo ""
  echo "User '$username' ready."
  echo "  Gateway URL:  http://localhost:${gateway_port}"
  echo "  Token:        ${token}"
  echo "  Config vol:   openclaw-${username}-config"
  echo "  Workspace vol: openclaw-${username}-workspace"
  echo ""
  echo "To pair a device:"
  echo "  $(basename "$0") pair-device ${username}"
}

cmd_remove() {
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  echo "Removing user '$username'..."

  # Stop and remove containers + networks
  compose_cmd "$username" down --remove-orphans --volumes 2>/dev/null || true

  # Remove named volumes (--volumes above handles anonymous volumes;
  # named volumes defined in the top-level volumes section need explicit removal)
  docker volume rm "openclaw-${username}-config" 2>/dev/null || true
  docker volume rm "openclaw-${username}-workspace" 2>/dev/null || true

  # Remove user config directory
  rm -rf "$(user_dir "$username")"

  echo "User '$username' removed (containers, volumes, and config cleaned up)."
}

cmd_start() {
  require_setup
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  ensure_skills_wiring "$username"

  echo "Starting gateway for user '$username'..."
  compose_cmd "$username" up -d openclaw-gateway
  ensure_tools_deny "$username"
  ensure_llm_idle_timeout "$username"
  ensure_agents_skills_allow "$username"
  echo "Gateway started."

  # Start background auto-approve watcher for node pairing requests
  _start_auto_approve_bg "$username"
}

# Background auto-approve loop: watches for pending node pairing requests
# and approves them automatically. Runs as a detached background process.
_start_auto_approve_bg() {
  local username="$1"
  local container="openclaw-${username}-gateway"
  local pidfile="$(user_dir "$username")/.auto-approve.pid"

  # Kill any existing watcher
  if [[ -f "$pidfile" ]]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi

  (
    while true; do
      sleep 5
      # Exit if container is gone
      docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$" || break

      local pending
      pending="$(docker exec "$container" node dist/index.js nodes pending --json 2>/dev/null \
        | grep -v 'DEP0040' || echo "[]")"

      echo "$pending" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    items = data if isinstance(data, list) else data.get('pending', [])
    for item in items:
        rid = item.get('requestId', '')
        if rid:
            print(rid)
except:
    pass
" 2>/dev/null | while IFS= read -r rid; do
        [[ -z "$rid" ]] && continue
        docker exec "$container" node dist/index.js nodes approve "$rid" >/dev/null 2>&1 || true
        echo "  [auto-approve] Approved node pairing: $rid"
      done
    done
  ) &
  echo $! > "$pidfile"
  echo "  Auto-approve watcher started (pid $(cat "$pidfile"))"
}

cmd_stop() {
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  # Kill auto-approve watcher if running
  local pidfile="$(user_dir "$username")/.auto-approve.pid"
  if [[ -f "$pidfile" ]]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi

  echo "Stopping gateway for user '$username'..."
  compose_cmd "$username" down
  echo "Gateway stopped."
}

cmd_restart() {
  require_setup
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  ensure_skills_wiring "$username"

  echo "Stopping gateway for user '$username'..."
  compose_cmd "$username" down
  echo "Starting gateway for user '$username' (picks up new image if rebuilt)..."
  compose_cmd "$username" up -d openclaw-gateway
  ensure_tools_deny "$username"
  ensure_llm_idle_timeout "$username"
  ensure_agents_skills_allow "$username"
  echo "Gateway restarted."
}

cmd_start_all() {
  require_setup
  local count=0
  while IFS= read -r name; do
    ensure_skills_wiring "$name"
    echo "Starting '$name'..."
    compose_cmd "$name" up -d openclaw-gateway
    ensure_tools_deny "$name"
    ensure_llm_idle_timeout "$name"
    ensure_agents_skills_allow "$name"
    count=$((count + 1))
  done < <(all_usernames)

  if (( count == 0 )); then
    echo "No users configured."
  else
    echo ""
    cmd_status
  fi
}

cmd_stop_all() {
  local count=0
  while IFS= read -r name; do
    echo "Stopping '$name'..."
    compose_cmd "$name" down 2>/dev/null || true
    count=$((count + 1))
  done < <(all_usernames)

  if (( count == 0 )); then
    echo "No users configured."
  else
    echo "All $count gateway(s) stopped."
  fi
}

cmd_status() {
  local username="${1:-}"
  if [[ -n "$username" ]]; then
    validate_username "$username"
    user_exists "$username" || fail "User '$username' does not exist."
    compose_cmd "$username" ps
    return
  fi

  local count=0
  printf "%-20s %-8s %-8s %-10s\n" "USER" "GW_PORT" "BR_PORT" "STATUS"
  printf "%-20s %-8s %-8s %-10s\n" "----" "-------" "-------" "------"

  while IFS= read -r name; do
    local gw_port br_port status
    gw_port=$(grep '^OPENCLAW_GATEWAY_PORT=' "$(user_env_file "$name")" | cut -d= -f2)
    br_port=$(grep '^OPENCLAW_BRIDGE_PORT=' "$(user_env_file "$name")" | cut -d= -f2)

    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^openclaw-${name}-gateway$"; then
      status="running"
    else
      status="stopped"
    fi

    printf "%-20s %-8s %-8s %-10s\n" "$name" "$gw_port" "$br_port" "$status"
    count=$((count + 1))
  done < <(all_usernames)

  if (( count == 0 )); then
    echo "No users configured."
  fi
}

cmd_list() {
  local count=0
  while IFS= read -r name; do
    echo "$name"
    count=$((count + 1))
  done < <(all_usernames)

  if (( count == 0 )); then
    echo "No users configured."
  fi
}

cmd_logs() {
  local username="$1"
  shift
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."
  compose_cmd "$username" logs "$@" openclaw-gateway
}

cmd_cli() {
  local username="$1"
  shift
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."
  compose_cmd "$username" run --rm openclaw-cli "$@"
}

cmd_token() {
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."
  grep '^OPENCLAW_GATEWAY_TOKEN=' "$(user_env_file "$username")" | cut -d= -f2
}

cmd_pair_device() {
  local username="$1"
  local timeout="${2:-120}"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  # Verify gateway is running
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^openclaw-${username}-gateway$"; then
    fail "Gateway for '$username' is not running. Start it first."
  fi

  echo "==> Watching for device pairing requests for '$username' (${timeout}s timeout, Ctrl+C to stop)..."
  echo "    Connect your device now. Pending requests will be auto-approved."

  local elapsed=0
  local interval=3
  while (( elapsed < timeout )); do
    # Use docker exec on the running gateway container (no throwaway containers)
    local container="openclaw-${username}-gateway"
    local devices_json
    devices_json="$(docker exec "$container" node dist/index.js devices list --json 2>/dev/null \
      | grep -v 'DEP0040\|trace-deprecation' || echo "{}")"

    # Extract pending requestIds
    local request_ids
    request_ids="$(echo "$devices_json" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for item in data.get('pending', []):
        rid = item.get('requestId', '')
        if rid:
            platform = item.get('platform', 'unknown')
            client = item.get('clientId', 'unknown')
            print(f'{rid}\t{platform}\t{client}')
except:
    pass
" 2>/dev/null || true)"

    if [[ -n "$request_ids" ]]; then
      while IFS=$'\t' read -r rid platform client; do
        [[ -z "$rid" ]] && continue
        echo "  Approving device: ${client} (${platform}) [${rid}]"
        docker exec "$container" node dist/index.js devices approve "$rid" >/dev/null 2>&1 || true
      done <<< "$request_ids"

      # Re-check; exit if no more pending requests
      local recheck
      recheck="$(docker exec "$container" node dist/index.js devices list --json 2>/dev/null \
        | grep -v 'DEP0040\|trace-deprecation' || echo "{}")"
      local remaining
      remaining="$(echo "$recheck" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(len(data.get('pending', [])))
except:
    print(0)
" 2>/dev/null || echo "0")"
      if (( remaining == 0 )); then
        echo "All pending requests approved."
        return
      fi
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  echo "Pair-device watch ended (${timeout}s elapsed)."
}

cmd_ask_off() {
  local username="$1"
  local node_name="${2:-}"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  local container="openclaw-${username}-gateway"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
    fail "Gateway for '$username' is not running. Start it first."
  fi

  echo "==> Disabling exec approval prompts for '$username'..."

  # Build the tools.exec override, optionally including node name and host=auto
  # Use host=auto (not host=node) so the agent can run commands on both the
  # gateway and the remote node.  The "node" field sets the default node target.
  local exec_override='{"security":"full","ask":"off"}'
  if [[ -n "$node_name" ]]; then
    exec_override="{\"security\":\"full\",\"ask\":\"off\",\"host\":\"auto\",\"node\":\"${node_name}\"}"
  fi

  # Write the exec override JSON to a temp file to avoid shell quoting issues
  local tmp_override
  tmp_override="$(mktemp)"
  echo "$exec_override" > "$tmp_override"

  # Copy the override file into the container
  docker cp "$tmp_override" "${container}:/tmp/exec-override.json"
  rm -f "$tmp_override"

  # Update openclaw.json tools.exec and exec-approvals.json in a single container exec
  docker exec "$container" sh -c '
    CFG=/home/node/.openclaw/openclaw.json
    APPROVALS=/home/node/.openclaw/exec-approvals.json
    OVERRIDE=/tmp/exec-override.json

    # Merge tools.exec into openclaw.json
    node -e "
      const fs = require(\"fs\");
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); } catch {}
      const execOverride = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\"));
      if (!cfg.tools) cfg.tools = {};
      cfg.tools.exec = { ...cfg.tools.exec, ...execOverride };
      fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + \"\n\");
    " "$CFG" "$OVERRIDE"

    rm -f "$OVERRIDE"

    # Write exec-approvals.json
    cat > "$APPROVALS" <<APPROVALS
{
  "version": 1,
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full",
    "autoAllowSkills": true
  }
}
APPROVALS
  '

  echo "  tools.exec: $exec_override"
  echo "  exec-approvals.json: defaults.ask=off, defaults.security=full"

  # Bump approved scopes on every paired operator/CLI device to the full
  # CLI_DEFAULT_OPERATOR_SCOPES set. Without this, the agent's `openclaw …`
  # subprocess connects with the 6-scope CLI default and the gateway emits
  # "scope upgrade pending approval (requestId: …)" because the original
  # pairing was only approved for a subset (typically operator.pairing +
  # operator.read). This is upstream's new scope-gate behavior added during
  # the v2026.4.30 merge.
  echo "==> Bumping CLI device approvedScopes to the full operator set..."
  docker exec "$container" node -e '
    (() => {
      const fs = require("fs");
      const path = "/home/node/.openclaw/devices/paired.json";
      const FULL = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
        "operator.talk.secrets",
      ];
      let paired;
      try {
        paired = JSON.parse(fs.readFileSync(path, "utf8"));
      } catch {
        console.log("  (no paired.json — nothing to bump)");
        return;
      }
      let changed = 0;
      for (const dev of Object.values(paired)) {
        const isCli =
          dev && dev.role === "operator" && (dev.clientId === "cli" || dev.clientMode === "cli");
        if (!isCli) continue;
        const before = JSON.stringify(dev.approvedScopes || []);
        dev.approvedScopes = [...FULL];
        dev.scopes = [...FULL];
        if (dev.tokens && dev.tokens.operator) {
          dev.tokens.operator.scopes = [...FULL];
        }
        if (before !== JSON.stringify(dev.approvedScopes)) changed++;
      }
      fs.writeFileSync(path, JSON.stringify(paired, null, 2) + "\n");
      console.log(`  approvedScopes bumped on ${changed} CLI device(s)`);
    })();
  '

  # Write agent tools.md with host-selection instructions when a node is configured
  if [[ -n "$node_name" ]]; then
    echo "==> Writing agent tools.md (exec host-selection instructions)..."
    local tmp_tools
    tmp_tools="$(mktemp)"
    cat > "$tmp_tools" <<TOOLS_MD
# TOOLS.md - Local Notes

## Remote Node Access (Windows)

You have a paired Windows node named \`${node_name}\` (case-sensitive). The node holds the user's files at Windows paths like \`C:\\Users\\<user>\\...\`.

### Read/write workflow — always copy through the gateway

For any task that needs to read, write, create, or modify files on the node, use this single workflow. Do not run commands directly on the node.

1. **Pull** the files from the node into your local gateway workspace.
2. **Work on them locally** inside the gateway (Linux) — read, edit, run scripts, extract, render.
3. **Push** the results back to the node.

The same pair of gateway-side commands covers every task, so the workflow is deterministic and avoids Windows path, quoting, and interpreter issues that routinely derail agents.

### Commands (always run on the gateway: \`"host": "gateway"\` on \`exec\`)

- **List remote files:**
  \`openclaw nodes ls --node ${node_name} --path "C:\\Users\\<user>\\Desktop\\folder"\`
- **Copy from node to gateway:**
  \`openclaw nodes copy --node ${node_name} --from "node:C:\\Users\\<user>\\Desktop\\folder" --to ./working-copy\`
- **Copy from gateway back to node:**
  \`openclaw nodes copy --node ${node_name} --from ./output.md --to "node:C:\\Users\\<user>\\Desktop\\folder\\output.md" --overwrite\`

Relative paths like \`./working-copy\` resolve inside the gateway workspace (\`/home/node/.openclaw/workspace/\`). Copy the user's Windows path verbatim into \`--path\` / \`--from\` / \`--to\` — do not reformat it.

### Hard rules

- **Do NOT set \`"host": "node"\` on \`exec\` calls.** Do not run \`dir\`, \`type\`, \`mkdir\`, \`findstr\`, \`markitdown\`, Python, or any other command on the Windows node. Pull the files to the gateway, do the work in Linux, push the results back.
- **Do use \`"host": "gateway"\`** (or leave \`host\` unset — gateway is the default) for every shell command, including \`openclaw nodes ...\`, \`bash\`, \`python\`, \`ls\`, \`cat\`, and any skill script under \`/home/node/.openclaw/workspace/skills/\`.

## Environment-Specific Notes

Add your own notes below (cameras, SSH hosts, voices, etc.)
TOOLS_MD
    docker cp "$tmp_tools" "${container}:/home/node/.openclaw/workspace/TOOLS.md"
    rm -f "$tmp_tools"
    echo "  TOOLS.md written to workspace for node '${node_name}'"
  fi

  # Restart gateway to pick up config changes
  echo "==> Restarting gateway to apply changes..."
  compose_cmd "$username" up -d --force-recreate openclaw-gateway
  ensure_tools_deny "$username"
  ensure_llm_idle_timeout "$username"
  ensure_agents_skills_allow "$username"

  echo ""
  echo "Exec approval prompts disabled for '$username' (gateway side)."
  if [[ -n "$node_name" ]]; then
    echo "  Exec host: auto (gateway + node)"
    echo "  Default node target: $node_name"
  fi
  echo ""
  echo "IMPORTANT: The node host has its own independent approval layer."
  echo "  On the Windows machine, run node-ask-off.bat (in multi-user-support/):"
  echo ""
  echo "    node-ask-off.bat"
  echo ""
  echo "  Then restart the node."
}

cmd_export_logs() {
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  local container="openclaw-${username}-gateway"
  local out_dir
  out_dir="$(user_dir "$username")/logs"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local export_dir="${out_dir}/${ts}"

  mkdir -p "$export_dir"

  echo "==> Exporting logs for '$username' to ${export_dir}"

  # 1. Docker stdout logs (WS frames, diagnostics, console output)
  echo "  [1/6] Docker container stdout logs..."
  docker logs "$container" > "${export_dir}/docker-stdout.log" 2>&1 || echo "    (container not running or no logs)"

  # 2. Gateway file log (persisted on config volume)
  echo "  [2/6] Gateway file log..."
  docker exec "$container" sh -c 'cat /home/node/.openclaw/logs/gateway.log 2>/dev/null' \
    > "${export_dir}/gateway.log" 2>/dev/null \
    || echo "    (not found — gateway may use /tmp/openclaw/ if logging.file was not set)"
  # Also grab any rolling logs from /tmp/openclaw/ inside the container
  docker exec "$container" sh -c 'cat /tmp/openclaw/openclaw-*.log 2>/dev/null' \
    >> "${export_dir}/gateway.log" 2>/dev/null || true

  # 3. Raw LLM stream
  echo "  [3/6] Raw LLM stream..."
  docker exec "$container" sh -c 'cat /home/node/.openclaw/logs/raw-stream.jsonl 2>/dev/null' \
    > "${export_dir}/raw-stream.jsonl" 2>/dev/null \
    || echo "    (not found — set OPENCLAW_RAW_STREAM=1 to enable)"

  # 4. Cache trace
  echo "  [4/6] Cache trace..."
  docker exec "$container" sh -c 'cat /home/node/.openclaw/logs/cache-trace.jsonl 2>/dev/null' \
    > "${export_dir}/cache-trace.jsonl" 2>/dev/null \
    || echo "    (not found — set OPENCLAW_CACHE_TRACE=1 to enable)"

  # 5. Session transcripts (all agents/sessions)
  echo "  [5/6] Session transcripts..."
  local sessions_dir="${export_dir}/sessions"
  mkdir -p "$sessions_dir"
  # List all .jsonl session files and copy them out preserving relative paths
  docker exec "$container" find /home/node/.openclaw/agents -name '*.jsonl' -type f 2>/dev/null \
    | while IFS= read -r fpath; do
        [[ -z "$fpath" ]] && continue
        # Derive a flat filename from the path: agents/<id>/sessions/<file> → <id>--<file>
        local rel="${fpath#/home/node/.openclaw/agents/}"
        local flat
        flat="$(echo "$rel" | sed 's|/|--|g')"
        docker cp "${container}:${fpath}" "${sessions_dir}/${flat}" 2>/dev/null || true
      done
  # Also copy sessions.json index if present
  docker exec "$container" find /home/node/.openclaw/agents -name 'sessions.json' -type f 2>/dev/null \
    | while IFS= read -r fpath; do
        [[ -z "$fpath" ]] && continue
        local rel="${fpath#/home/node/.openclaw/agents/}"
        local flat
        flat="$(echo "$rel" | sed 's|/|--|g')"
        docker cp "${container}:${fpath}" "${sessions_dir}/${flat}" 2>/dev/null || true
      done

  # 6. Gateway config snapshot (for reference)
  echo "  [6/6] Gateway config snapshot..."
  docker exec "$container" sh -c 'cat /home/node/.openclaw/openclaw.json 2>/dev/null || cat /home/node/.openclaw/config.json5 2>/dev/null' \
    > "${export_dir}/openclaw-config.json" 2>/dev/null || true

  # Remove empty files
  find "$export_dir" -type f -empty -delete 2>/dev/null || true

  echo ""
  echo "==> Export complete: ${export_dir}"
  echo "  Files:"
  ls -lhS "$export_dir" 2>/dev/null | tail -n +2
  if [[ -d "$sessions_dir" ]] && ls "$sessions_dir"/*.jsonl >/dev/null 2>&1; then
    echo "  Sessions:"
    ls -lhS "$sessions_dir" 2>/dev/null | tail -n +2
  fi

  # Auto-generate HTML report
  echo ""
  echo "==> Generating HTML report..."
  python3 "$SCRIPT_DIR/analyze-logs.py" "$export_dir" -o "${export_dir}/report.html"
  echo "  Report: ${export_dir}/report.html"
}

cmd_info() {
  local username="$1"
  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  local gw_port br_port token
  gw_port=$(grep '^OPENCLAW_GATEWAY_PORT=' "$(user_env_file "$username")" | cut -d= -f2)
  br_port=$(grep '^OPENCLAW_BRIDGE_PORT=' "$(user_env_file "$username")" | cut -d= -f2)
  token=$(grep '^OPENCLAW_GATEWAY_TOKEN=' "$(user_env_file "$username")" | cut -d= -f2)

  echo "User:           $username"
  echo "Gateway port:   $gw_port"
  echo "Bridge port:    $br_port"
  echo "Token:          $token"
  echo "Config volume:  openclaw-${username}-config"
  echo "Workspace vol:  openclaw-${username}-workspace"
  echo "Gateway URL:    http://localhost:${gw_port}"
  echo "Control UI URL: http://localhost:${gw_port}/#token=${token}"
  echo ""
  echo "CLI usage:"
  echo "  $(basename "$0") cli ${username} config get gateway.auth.token"
  echo "  $(basename "$0") cli ${username} channels status --probe"
  echo "  $(basename "$0") logs ${username} -f"
}

# ── Ollama ────────────────────────────────────────────────────

# Resolve the Ollama API base URL.
# Priority: argument > OLLAMA_HOST env > default localhost.
resolve_ollama_host() {
  local arg="${1:-}"
  if [[ -n "$arg" ]]; then
    echo "$arg"
  elif [[ -n "${OLLAMA_HOST:-}" ]]; then
    echo "$OLLAMA_HOST"
  else
    echo "http://localhost:11434"
  fi
}

# Resolve the Ollama URL reachable from inside Docker containers.
# The host's localhost isn't reachable from Docker; use the Docker bridge gateway IP.
resolve_ollama_docker_url() {
  local host_url="$1"
  local bridge_ip
  bridge_ip="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || echo "172.17.0.1")"
  # Replace localhost / 127.0.0.1 with the bridge IP using Python for reliability
  python3 -c "
import sys, re
url = sys.argv[1]
bridge = sys.argv[2]
url = re.sub(r'://localhost([:/]|$)', '://' + bridge + r'\1', url)
url = re.sub(r'://127\.0\.0\.1([:/]|$)', '://' + bridge + r'\1', url)
print(url)
" "$host_url" "$bridge_ip"
}

# Query Ollama for available models and return JSON array.
query_ollama_models() {
  local ollama_url="$1"
  curl -sf --connect-timeout 5 "${ollama_url}/api/tags" 2>/dev/null \
    || { echo ""; return 1; }
}

cmd_list_ollama() {
  local ollama_url
  ollama_url="$(resolve_ollama_host "${1:-}")"

  echo "==> Querying Ollama at ${ollama_url}"
  local raw
  raw="$(query_ollama_models "$ollama_url")"
  if [[ -z "$raw" ]]; then
    fail "Cannot reach Ollama at ${ollama_url}. Is Ollama running?"
  fi

  echo ""
  echo "$raw" | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('models', [])
if not models:
    print('  No models found.')
else:
    print(f'  Found {len(models)} model(s):')
    print()
    for m in models:
        name = m['name']
        size_gb = m.get('size', 0) / (1024**3)
        family = m.get('details', {}).get('family', '?')
        params = m.get('details', {}).get('parameter_size', '?')
        quant = m.get('details', {}).get('quantization_level', '?')
        print(f'    {name:<30s}  {params:<10s}  {quant:<10s}  {size_gb:.1f} GB  ({family})')
"
}

cmd_restart_ollama() {
  # Recover from a wedged Ollama runner state (e.g. size_vram=0 after load,
  # 300 s no-reply timeouts on the first turn). Ollama does not offer a
  # systemctl-free "reset" — the closest is to send keep_alive=0 per loaded
  # model, which forces the runner to release each model's weights and KV
  # cache. The next inference then cold-loads into a clean runner.
  #
  # Does not restart ollama.service itself (that needs sudo and is out of
  # scope here). If the runner is wedged badly enough that keep_alive=0
  # does not clear it, run `sudo systemctl restart ollama` on the host.
  local ollama_url
  ollama_url="$(resolve_ollama_host "${1:-}")"

  echo "==> Querying Ollama at ${ollama_url}"
  local raw
  raw="$(curl -sf --connect-timeout 5 "${ollama_url}/api/ps" 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    fail "Cannot reach Ollama at ${ollama_url}. Is Ollama running?"
  fi

  local models
  models="$(echo "$raw" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('models', []):
    print(m.get('name', ''))
" 2>/dev/null)"

  if [[ -z "$models" ]]; then
    echo "No models currently loaded. Nothing to unload."
    return 0
  fi

  local count=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    echo "==> Unloading '${name}' (keep_alive=0)"
    curl -s --max-time 30 "${ollama_url}/api/chat" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c "import json; print(json.dumps({'model': '$name', 'keep_alive': 0}))")" \
      >/dev/null 2>&1 || true
    count=$((count + 1))
  done <<<"$models"

  # Short pause, then re-query to confirm the unload took effect.
  sleep 2
  local remaining
  remaining="$(curl -sf --connect-timeout 5 "${ollama_url}/api/ps" 2>/dev/null \
    | python3 -c "import json, sys; d=json.load(sys.stdin); print(len(d.get('models', [])))" 2>/dev/null || echo "?")"
  echo "Unloaded ${count} model(s). Currently loaded: ${remaining}."
  if [[ "$remaining" != "0" && "$remaining" != "?" ]]; then
    echo "Note: some models are still reported as loaded. Ollama may finalize eviction asynchronously."
    echo "      If the next inference still stalls, escalate with: sudo systemctl restart ollama"
  fi
}

cmd_sync_ollama() {
  local username="${1:?Username required}"
  local ollama_url
  ollama_url="$(resolve_ollama_host "${2:-}")"

  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  local container="openclaw-${username}-gateway"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
    fail "Gateway for '$username' is not running. Start it first."
  fi

  echo "==> Querying Ollama at ${ollama_url}"
  local raw
  raw="$(query_ollama_models "$ollama_url")"
  if [[ -z "$raw" ]]; then
    fail "Cannot reach Ollama at ${ollama_url}. Is Ollama running?"
  fi

  local docker_url
  docker_url="$(resolve_ollama_docker_url "$ollama_url")"

  local ctx_cap="${OPENCLAW_OLLAMA_CTX_CAP:-0}"
  if [[ "$ctx_cap" -gt 0 ]]; then
    echo "    Clamping contextWindow to ${ctx_cap} (OPENCLAW_OLLAMA_CTX_CAP)"
  fi

  # Build the config JSON using Python, write to temp files to avoid shell quoting issues
  local tmp_provider tmp_models
  tmp_provider="$(mktemp)"
  tmp_models="$(mktemp)"
  echo "$raw" | python3 -c "
import json, sys, urllib.request

data = json.load(sys.stdin)
models = data.get('models', [])

ollama_url = sys.argv[1]
docker_url = sys.argv[2]
provider_file = sys.argv[3]
models_file = sys.argv[4]
# Cap comes from OPENCLAW_OLLAMA_CTX_CAP (0 = no cap). See the env docs in
# usage() for the rationale; the short version is that OpenClaw's Ollama
# stream adapter sends options.num_ctx = model.contextWindow, and Ollama
# pre-allocates the full KV cache at load. On Jetson Orin, a 256K cache
# takes ~160s to allocate and trips the 120s LLM idle watchdog on the first
# turn. 131072 (128K) loads in ~18s and generally fits; anything larger
# needs measurement.
ctx_cap = int(sys.argv[5])

DEFAULT_CTX = 131072

def get_context_window(model_name, base_url):
    \"\"\"Query /api/show to get the model's context_length, clamped to ctx_cap.\"\"\"
    detected = DEFAULT_CTX
    try:
        req = urllib.request.Request(
            base_url.rstrip('/') + '/api/show',
            data=json.dumps({'name': model_name}).encode(),
            headers={'Content-Type': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            info = json.load(resp)
        for key, value in (info.get('model_info') or {}).items():
            if key.endswith('.context_length') and isinstance(value, (int, float)) and value > 0:
                detected = int(value)
                break
    except Exception:
        pass
    if ctx_cap > 0 and detected > ctx_cap:
        return ctx_cap
    return detected

# Mirror src/agents/self-hosted-provider-defaults.ts. 8192 is usually too
# tight for reasoning-capable self-hosted models (ollama/gemma4, qwen3,
# etc.) because the thinking stream, visible output, and tool-call JSON
# share one budget; 16384 gives the agent room to emit a tool_call after
# a long thinking pass. Keeping this hard-coded (rather than inferred
# from the shared default constant inside the image) means the resulting
# openclaw.json stays explicit after sync-ollama and is independent
# of which image version the container is running.
SELF_HOSTED_MAX_TOKENS = 16384

provider_models = []
for m in models:
    name = m['name']
    params = m.get('details', {}).get('parameter_size', '')
    ctx = get_context_window(name, ollama_url)
    provider_models.append({
        'id': name,
        'name': f'{name} ({params})' if params else name,
        'contextWindow': ctx,
        'maxTokens': SELF_HOSTED_MAX_TOKENS,
    })

with open(provider_file, 'w') as f:
    json.dump({'baseUrl': docker_url, 'models': provider_models}, f)

ollama_models = {}
for m in models:
    name = m['name']
    params = m.get('details', {}).get('parameter_size', '')
    alias = f'{name} ({params})' if params else name
    ollama_models[f'ollama/{name}'] = {'alias': alias}

with open(models_file, 'w') as f:
    json.dump(ollama_models, f)
" "$ollama_url" "$docker_url" "$tmp_provider" "$tmp_models" "$ctx_cap"

  local provider_config models_config
  provider_config="$(cat "$tmp_provider")"
  models_config="$(cat "$tmp_models")"
  rm -f "$tmp_provider" "$tmp_models"

  echo "==> Updating Ollama provider config for '$username'"
  echo "    Docker Ollama URL: ${docker_url}"
  docker exec "$container" node dist/index.js config set \
    models.providers.ollama "$provider_config" 2>&1 | grep -v DEP0040

  # Merge ollama models into existing agents.defaults.models (preserve non-ollama entries)
  echo "==> Updating model selection list"
  docker exec "$container" node -e "
    const fs = require('fs');
    const cfgPath = '/home/node/.openclaw/openclaw.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const existing = cfg.agents?.defaults?.models || {};
    // Remove old ollama entries
    for (const key of Object.keys(existing)) {
      if (key.startsWith('ollama/')) delete existing[key];
    }
    // Add new ollama entries
    const newOllama = JSON.parse(process.argv[1]);
    Object.assign(existing, newOllama);
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    cfg.agents.defaults.models = existing;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('  Models updated:', Object.keys(existing).join(', '));
  " "$models_config" 2>&1 | grep -v DEP0040

  # NOTE on Ollama Web Search base URL: the bundled plugin's
  # resolveOllamaWebSearchBaseUrl (extensions/ollama/src/web-search-provider.ts)
  # falls back to models.providers.ollama.baseUrl when no plugin-scoped override
  # is set. Since we just set that above to the docker-reachable host, the web
  # search plugin will resolve to the same URL at runtime — no extra write
  # needed here. (We tried writing plugins.entries.ollama.config.webSearch.baseUrl
  # but extensions/ollama/openclaw.plugin.json's configSchema only whitelists
  # `discovery`, so adding webSearch causes config validation to fail and the
  # gateway to enter a restart loop. If/when the ollama plugin's configSchema
  # gains a webSearch slot — like extensions/brave/openclaw.plugin.json has —
  # we can pin it explicitly. Until then, the fallback path is enough.)
  #
  # The wizard's "Expected host: http://127.0.0.1:11434" prereq message that
  # appears during `manage.sh add` is stale — the wizard runs before
  # sync-ollama, so models.providers.ollama.baseUrl isn't set yet. After
  # sync-ollama runs, the actual web-search request goes to $docker_url.

  # Ensure OLLAMA env vars are set in the user .env
  local env_file
  env_file="$(user_env_file "$username")"
  if ! grep -q 'OLLAMA_API_KEY' "$env_file" 2>/dev/null; then
    echo "OLLAMA_API_KEY=ollama-local" >> "$env_file"
    echo "  Added OLLAMA_API_KEY to env"
  fi
  if ! grep -q 'OLLAMA_HOST' "$env_file" 2>/dev/null; then
    echo "OLLAMA_HOST=${docker_url}" >> "$env_file"
    echo "  Added OLLAMA_HOST=${docker_url} to env"
  else
    sed -i "s#^OLLAMA_HOST=.*#OLLAMA_HOST=${docker_url}#" "$env_file"
  fi
  # Ensure compose file has OLLAMA env vars in gateway service
  local compose_file
  compose_file="$(user_compose_file "$username")"
  if ! grep -q 'OLLAMA_API_KEY' "$compose_file" 2>/dev/null; then
    sed -i '/OPENCLAW_DIAGNOSTICS/a\      OLLAMA_HOST: ${OLLAMA_HOST:-}\n      OLLAMA_API_KEY: ${OLLAMA_API_KEY:-ollama-local}' "$compose_file"
    echo "  Added OLLAMA env vars to compose file"
  fi

  # Show summary
  echo ""
  echo "$provider_config" | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('models', [])
print(f'  Synced {len(models)} Ollama model(s):')
for m in models:
    ctx_k = m.get('contextWindow', 0) // 1024
    print(f'    ollama/{m[\"id\"]} — {ctx_k}k context')
"
  echo "  Ollama provider baseUrl:    ${docker_url}"
  echo "  (Ollama Web Search resolves to the same baseUrl via runtime fallback)"
  echo ""
  echo "==> Restarting gateway for '$username' to apply changes..."
  cmd_restart "$username"
  echo ""
  echo "Done. Select Ollama models from the control UI model picker."
}

# ── vLLM ─────────────────────────────────────────────────────

# Resolve the vLLM API base URL.
# Priority: argument > VLLM_HOST env > default localhost.
resolve_vllm_host() {
  local arg="${1:-}"
  if [[ -n "$arg" ]]; then
    echo "$arg"
  elif [[ -n "${VLLM_HOST:-}" ]]; then
    echo "$VLLM_HOST"
  else
    echo "http://localhost:8000"
  fi
}

# Resolve the vLLM URL reachable from inside Docker containers.
resolve_vllm_docker_url() {
  local host_url="$1"
  local bridge_ip
  bridge_ip="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || echo "172.17.0.1")"
  python3 -c "
import sys, re
url = sys.argv[1]
bridge = sys.argv[2]
url = re.sub(r'://localhost([:/]|$)', '://' + bridge + r'\1', url)
url = re.sub(r'://127\.0\.0\.1([:/]|$)', '://' + bridge + r'\1', url)
print(url)
" "$host_url" "$bridge_ip"
}

# Query vLLM for available models (OpenAI-compatible /v1/models endpoint).
query_vllm_models() {
  local vllm_url="$1"
  curl -sf --connect-timeout 5 "${vllm_url}/v1/models" 2>/dev/null \
    || { echo ""; return 1; }
}

cmd_list_vllm() {
  local vllm_url
  vllm_url="$(resolve_vllm_host "${1:-}")"

  echo "==> Querying vLLM at ${vllm_url}"
  local raw
  raw="$(query_vllm_models "$vllm_url")"
  if [[ -z "$raw" ]]; then
    fail "Cannot reach vLLM at ${vllm_url}. Is vLLM running?"
  fi

  echo ""
  echo "$raw" | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('data', [])
if not models:
    print('  No models found.')
else:
    print(f'  Found {len(models)} model(s):')
    print()
    for m in models:
        mid = m.get('id', '?')
        owned_by = m.get('owned_by', '?')
        max_model_len = m.get('max_model_len', '?')
        print(f'    {mid:<40s}  owner={owned_by:<12s}  max_len={max_model_len}')
"
}

cmd_sync_vllm() {
  local username="${1:?Username required}"
  local vllm_url
  vllm_url="$(resolve_vllm_host "${2:-}")"

  validate_username "$username"
  user_exists "$username" || fail "User '$username' does not exist."

  local container="openclaw-${username}-gateway"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
    fail "Gateway for '$username' is not running. Start it first."
  fi

  echo "==> Querying vLLM at ${vllm_url}"
  local raw
  raw="$(query_vllm_models "$vllm_url")"
  if [[ -z "$raw" ]]; then
    fail "Cannot reach vLLM at ${vllm_url}. Is vLLM running?"
  fi

  local docker_url
  docker_url="$(resolve_vllm_docker_url "$vllm_url")"

  # Build the config JSON using Python
  local tmp_provider tmp_models
  tmp_provider="$(mktemp)"
  tmp_models="$(mktemp)"
  echo "$raw" | python3 -c "
import json, sys

data = json.load(sys.stdin)
models = data.get('data', [])

docker_url = sys.argv[1]
provider_file = sys.argv[2]
models_file = sys.argv[3]

DEFAULT_CTX = 131072
# Same 16384 rationale as cmd_sync_ollama: reasoning-capable self-hosted
# models share one output budget across thinking + visible text + tool
# calls, and 8192 is often exhausted by thinking alone on a ~30k-token
# prompt. Keep this explicit in the written config.
SELF_HOSTED_MAX_TOKENS = 16384

provider_models = []
for m in models:
    mid = m.get('id', '')
    ctx = m.get('max_model_len', DEFAULT_CTX) or DEFAULT_CTX
    provider_models.append({
        'id': mid,
        'name': mid,
        'contextWindow': ctx,
        'maxTokens': SELF_HOSTED_MAX_TOKENS,
    })

# vLLM exposes an OpenAI-compatible API at /v1
with open(provider_file, 'w') as f:
    json.dump({
        'baseUrl': docker_url + '/v1',
        'models': provider_models,
        'apiKey': 'vllm-local',
    }, f)

vllm_models = {}
for m in models:
    mid = m.get('id', '')
    vllm_models[f'vllm/{mid}'] = {'alias': mid}

with open(models_file, 'w') as f:
    json.dump(vllm_models, f)
" "$docker_url" "$tmp_provider" "$tmp_models"

  local provider_config models_config
  provider_config="$(cat "$tmp_provider")"
  models_config="$(cat "$tmp_models")"
  rm -f "$tmp_provider" "$tmp_models"

  echo "==> Updating vLLM provider config for '$username'"
  echo "    Docker vLLM URL: ${docker_url}"
  docker exec "$container" node dist/index.js config set \
    models.providers.vllm "$provider_config" 2>&1 | grep -v DEP0040

  # Merge vllm models into existing agents.defaults.models (preserve non-vllm entries)
  echo "==> Updating model selection list"
  docker exec "$container" node -e "
    const fs = require('fs');
    const cfgPath = '/home/node/.openclaw/openclaw.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const existing = cfg.agents?.defaults?.models || {};
    // Remove old vllm entries
    for (const key of Object.keys(existing)) {
      if (key.startsWith('vllm/')) delete existing[key];
    }
    // Add new vllm entries
    const newVllm = JSON.parse(process.argv[1]);
    Object.assign(existing, newVllm);
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    cfg.agents.defaults.models = existing;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('  Models updated:', Object.keys(existing).join(', '));
  " "$models_config" 2>&1 | grep -v DEP0040

  # Ensure VLLM env vars are set in the user .env
  local env_file
  env_file="$(user_env_file "$username")"
  if ! grep -q 'VLLM_API_KEY' "$env_file" 2>/dev/null; then
    echo "VLLM_API_KEY=vllm-local" >> "$env_file"
    echo "  Added VLLM_API_KEY to env"
  fi
  if ! grep -q 'VLLM_HOST' "$env_file" 2>/dev/null; then
    echo "VLLM_HOST=${docker_url}" >> "$env_file"
    echo "  Added VLLM_HOST=${docker_url} to env"
  else
    sed -i "s#^VLLM_HOST=.*#VLLM_HOST=${docker_url}#" "$env_file"
  fi
  # Ensure compose file has VLLM env vars in gateway service
  local compose_file
  compose_file="$(user_compose_file "$username")"
  if ! grep -q 'VLLM_API_KEY' "$compose_file" 2>/dev/null; then
    sed -i '/OPENCLAW_DIAGNOSTICS/a\      VLLM_HOST: ${VLLM_HOST:-}\n      VLLM_API_KEY: ${VLLM_API_KEY:-vllm-local}' "$compose_file"
    echo "  Added VLLM env vars to compose file"
  fi

  # Show summary
  echo ""
  echo "$provider_config" | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = data.get('models', [])
print(f'  Synced {len(models)} vLLM model(s):')
for m in models:
    ctx_k = m.get('contextWindow', 0) // 1024
    print(f'    vllm/{m[\"id\"]} — {ctx_k}k context')
"
  echo ""
  echo "==> Restarting gateway for '$username' to apply changes..."
  cmd_restart "$username"
  echo ""
  echo "Done. Select vLLM models from the control UI model picker."
}

# ── Main ──────────────────────────────────────────────────────

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose not available (try: docker compose version)"
fi

[[ $# -lt 1 ]] && usage

command="$1"
shift

case "$command" in
  setup)          cmd_setup ;;
  rebuild)        cmd_rebuild ;;
  rebuild-china)  cmd_rebuild_china ;;
  cache-warm)     cmd_cache_warm ;;
  add)       cmd_add "$@"; echo ""; cmd_info "${1:-}" ;;
  remove)    cmd_remove "${1:?Username required}" ;;
  start)     cmd_start "${1:?Username required}"; echo ""; cmd_info "${1}" ;;
  stop)      cmd_stop "${1:?Username required}"; echo ""; cmd_info "${1}" ;;
  restart)   cmd_restart "${1:?Username required}"; echo ""; cmd_info "${1}" ;;
  start-all) cmd_start_all ;;
  stop-all)  cmd_stop_all ;;
  pair-device) cmd_pair_device "${1:?Username required}" "${2:-120}"; echo ""; cmd_info "${1}" ;;
  ask-off)   cmd_ask_off "${1:?Username required}" "${2:-}"; echo ""; cmd_info "${1}" ;;
  status)    cmd_status "${1:-}" ;;
  list)      cmd_list ;;
  logs)      cmd_logs "${1:?Username required}" "${@:2}" ;;
  export-logs) cmd_export_logs "${1:?Username required}"; echo ""; cmd_info "${1}" ;;
  cli)       cmd_cli "${1:?Username required}" "${@:2}" ;;
  token)     cmd_token "${1:?Username required}"; echo ""; cmd_info "${1}" ;;
  info)      cmd_info "${1:?Username required}" ;;
  sync-ollama)     cmd_sync_ollama "${1:?Username required}" "${2:-}"; echo ""; cmd_info "${1}" ;;
  list-ollama)     cmd_list_ollama "${1:-}" ;;
  restart-ollama)  cmd_restart_ollama "${1:-}" ;;
  sync-vllm)    cmd_sync_vllm "${1:?Username required}" "${2:-}"; echo ""; cmd_info "${1}" ;;
  list-vllm)    cmd_list_vllm "${1:-}" ;;
  help|-h|--help) usage ;;
  *)         fail "Unknown command: $command. Run '$(basename "$0") help' for usage." ;;
esac
