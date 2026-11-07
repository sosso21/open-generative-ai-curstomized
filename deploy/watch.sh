#!/usr/bin/env bash
# Publication watcher, started by setup.sh / start.sh and stopped by pause.sh / uninstall.sh (pidfile
# .watch.pid, log .watch.log, both in this folder). Every WATCH_INTERVAL_SECONDS it runs publish.sh, which
# does nothing when the working copy has no change and output/ no new file.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

stopping=false
sleeper=""
on_term() {
  stopping=true
  [[ -n "${sleeper}" ]] && kill "${sleeper}" 2>/dev/null
  return 0
}
trap on_term TERM INT
trap 'rm -f "${WATCH_PID_FILE}"' EXIT

echo "$$" >"${WATCH_PID_FILE}"
log "$(date -Is) watcher started (pid $$)"

failing=false
while [[ "${stopping}" == false ]]; do
  if [[ -f "${WATCH_LOG}" && "$(stat -c %s "${WATCH_LOG}")" -gt "${WATCH_LOG_MAX_BYTES}" ]]; then
    tail -c $((WATCH_LOG_MAX_BYTES / 2)) "${WATCH_LOG}" >"${WATCH_LOG}.tmp" && mv "${WATCH_LOG}.tmp" "${WATCH_LOG}"
  fi
  # A failure is notified once on Discord, not at every poll while it lasts.
  if PUBLISH_NOTIFY_FAILURE="$([[ "${failing}" == true ]] && echo 0 || echo 1)" "${AI_DIR}/publish.sh"; then
    failing=false
  else
    failing=true
    log "$(date -Is) publish.sh failed (retry in ${WATCH_INTERVAL_SECONDS}s)"
  fi
  [[ "${stopping}" == true ]] && break
  sleep "${WATCH_INTERVAL_SECONDS}" &
  sleeper=$!
  wait "${sleeper}" 2>/dev/null || true
  sleeper=""
done
log "$(date -Is) watcher stopped"
