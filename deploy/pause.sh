#!/usr/bin/env bash
# Puts Open Generative AI on pause: the publication watcher and the container are stopped (no CPU, no memory)
# but the image is kept, so start.sh brings it back in seconds. It stays stopped after a reboot of the VPS.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tools
trap 'notify_failure pause "${LINENO}"' ERR

stop_watch
state="$(container_state)"
if [[ "${state}" != "running" && "${state}" != "restarting" ]]; then
  log "not running (${state}): nothing to pause"
  exit 0
fi
compose stop
log "paused (start it again with ./start.sh)"
notify "⏸️ Open Generative AI : en pause" "État : ${state} → stopped. CPU et mémoire libérés ; relance avec start.sh." "${COLOR_WARNING}"
