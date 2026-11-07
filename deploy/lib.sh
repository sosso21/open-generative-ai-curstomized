#!/usr/bin/env bash
# Shared helpers of the Open Generative AI scripts. Everything lives in this folder: the only things created
# outside it are the Docker image, container and network (removed by uninstall.sh) and the git-lfs package.
set -Eeuo pipefail

AI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly AI_DIR
readonly REPO_SLUG="sosso21/open-generative-ai-curstomized"
readonly REPO_URL="https://github.com/${REPO_SLUG}.git"
readonly UPSTREAM_URL="https://github.com/Anil-matcha/Open-Generative-AI.git"
readonly REPO_DIR="${AI_DIR}/Open-Generative-AI"
readonly OUTPUT_DIR="${REPO_DIR}/output"
readonly APP_UID=1000
# Git authenticates over HTTPS with the gh login of root: the helper of `gh auth setup-git`, set in the
# repository config only (the global ~/.gitconfig of the VPS is left untouched).
readonly GH_CREDENTIAL_HELPER='!gh auth git-credential'
readonly WATCH_PID_FILE="${AI_DIR}/.watch.pid"
readonly WATCH_LOG="${AI_DIR}/.watch.log"
readonly PUBLISH_LOCK="${AI_DIR}/.publish.lock"
readonly WATCH_INTERVAL_SECONDS=300
readonly WATCH_LOG_MAX_BYTES=1048576
readonly CONTAINER="ai-open-generative"
readonly IMAGE="ai-open-generative:local"
readonly BUILDER="ai-open-generative-builder"
readonly BUILDKIT_IMAGE="moby/buildkit:buildx-stable-1"
readonly APP_URL="http://10.13.13.1:3100"
# Machine-specific settings stay out of the repository: local.env (next to this file, never published) may set
# ALERTS_ENV, the env file of the VPS holding DISCORD_WEBHOOK (read at each notification, never copied).
if [[ -r "${AI_DIR}/local.env" ]]; then
  # shellcheck source=/dev/null
  source "${AI_DIR}/local.env"
fi
readonly ALERTS_ENV="${ALERTS_ENV:-}"
readonly HEALTH_POLL_SECONDS=5
readonly HEALTH_MAX_POLLS=60
readonly COLOR_SUCCESS=3066993
readonly COLOR_INFO=3447003
readonly COLOR_WARNING=15105570
readonly COLOR_FAILURE=15158332

log() { printf '\033[1;34m[ai-project]\033[0m %s\n' "$*"; }

fail() {
  printf '\033[1;31m[ai-project]\033[0m %s\n' "$*" >&2
  exit 1
}

require_tools() {
  [[ ${EUID} -eq 0 ]] || fail "run as root"
  local tool
  for tool in docker git jq curl; do
    command -v "${tool}" >/dev/null || fail "missing tool: ${tool}"
  done
}

compose() { docker compose --project-directory "${AI_DIR}" -f "${AI_DIR}/compose.yml" "$@"; }

discord_webhook() {
  if [[ -n "${DISCORD_WEBHOOK:-}" ]]; then
    printf '%s' "${DISCORD_WEBHOOK}"
  elif [[ -r "${ALERTS_ENV}" ]]; then
    sed -n 's/^DISCORD_WEBHOOK=//p' "${ALERTS_ENV}" | tail -1
  fi
}

# Posts a status change to Discord; a Discord failure never stops the calling script.
notify() {
  local title="$1" description="$2" color="$3" webhook payload
  webhook="$(discord_webhook || true)"
  if [[ -z "${webhook}" ]]; then
    log "no Discord webhook: notification skipped"
    return 0
  fi
  payload="$(jq -n --arg title "${title}" --arg description "${description}" --argjson color "${color}" \
    --arg host "$(hostname)" \
    '{username: "VPS STA", embeds: [{title: $title, description: $description, color: $color,
      footer: {text: ("Open Generative AI · " + $host)}, timestamp: (now | todate)}]}')"
  curl -fsS -m 15 -H "Content-Type: application/json" -d "${payload}" "${webhook}" >/dev/null ||
    log "Discord notification failed"
}

notify_failure() {
  notify "🔴 Open Generative AI : échec ($1)" "Erreur ligne $2 du script. Détails dans la sortie sur le VPS." "${COLOR_FAILURE}"
}

container_state() { docker inspect -f '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || echo "missing"; }

image_exists() { docker image inspect "$1" >/dev/null 2>&1; }

wait_until_healthy() {
  local poll status
  for ((poll = 0; poll < HEALTH_MAX_POLLS; poll++)); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "${CONTAINER}" 2>/dev/null || echo missing)"
    case "${status}" in
      healthy) return 0 ;;
      unhealthy | exited | dead | missing) return 1 ;;
    esac
    sleep "${HEALTH_POLL_SECONDS}"
  done
  return 1
}

remove_builder() { docker buildx rm --force "${BUILDER}" >/dev/null 2>&1 || true; }

# The bind-mounted output folder must exist and belong to the container user (uid 1000).
ensure_output_dir() {
  mkdir -p "${OUTPUT_DIR}"
  chown "${APP_UID}:${APP_UID}" "${OUTPUT_DIR}"
}

watch_pid() {
  local pid
  pid="$(cat "${WATCH_PID_FILE}" 2>/dev/null || true)"
  if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null &&
    grep -q "watch.sh" "/proc/${pid}/cmdline" 2>/dev/null; then
    printf '%s' "${pid}"
  fi
}

# Starts the publication watcher (watch.sh) in the background, tracked by a pidfile in this folder.
start_watch() {
  if ! gh auth status >/dev/null 2>&1; then
    log "gh is not logged in: watcher not started"
    return 0
  fi
  if [[ -n "$(watch_pid)" ]]; then
    log "watcher already running (pid $(watch_pid))"
    return 0
  fi
  nohup setsid "${AI_DIR}/watch.sh" >>"${WATCH_LOG}" 2>&1 </dev/null &
  local poll
  for ((poll = 0; poll < 10; poll++)); do
    [[ -n "$(watch_pid)" ]] && break
    sleep 0.5
  done
  [[ -n "$(watch_pid)" ]] || fail "the watcher did not start (see ${WATCH_LOG})"
  log "watcher started (pid $(watch_pid), every ${WATCH_INTERVAL_SECONDS}s)"
}

stop_watch() {
  local pid
  pid="$(watch_pid)"
  if [[ -z "${pid}" ]]; then
    rm -f "${WATCH_PID_FILE}"
    return 0
  fi
  # watch.sh exits at once when idle, or right after the publication it is running (never half-way).
  kill -TERM "${pid}" 2>/dev/null || true
  local poll
  for ((poll = 0; poll < 120; poll++)); do
    kill -0 "${pid}" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "${pid}" 2>/dev/null; then
    log "watcher still finishing a publication: it stops by itself right after"
  else
    rm -f "${WATCH_PID_FILE}"
    log "watcher stopped"
  fi
}

configure_repo_auth() {
  git -C "${REPO_DIR}" config --local --replace-all credential.https://github.com.helper ""
  git -C "${REPO_DIR}" config --local --add credential.https://github.com.helper "${GH_CREDENTIAL_HELPER}"
}
