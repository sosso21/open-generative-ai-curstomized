#!/usr/bin/env bash
# Starts Open Generative AI again after pause.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tools
trap 'notify_failure démarrage "${LINENO}"' ERR

state="$(container_state)"
if [[ "${state}" == "running" ]]; then
  start_watch
  log "already running: ${APP_URL}"
  exit 0
fi
image_exists "${IMAGE}" || fail "not installed: run ./setup.sh"

ensure_output_dir
compose up -d
if ! wait_until_healthy; then
  docker logs --tail 30 "${CONTAINER}" >&2 || true
  notify_failure démarrage "${LINENO}"
  fail "the app did not become healthy"
fi
start_watch
log "running: ${APP_URL} (WireGuard)"
notify "🟢 Open Generative AI : démarré" "État : ${state} → running. ${APP_URL} (WireGuard)" "${COLOR_SUCCESS}"
