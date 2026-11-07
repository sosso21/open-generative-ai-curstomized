#!/usr/bin/env bash
# Stops the publication watcher and removes every Docker object of Open Generative AI (container, network,
# volumes, image, builder) and nothing else: the other projects of the VPS are never touched. Deleting this
# folder afterwards leaves no trace (except the git-lfs package; the GitHub repository is kept).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tools
trap 'notify_failure désinstallation "${LINENO}"' ERR

stop_watch
state="$(container_state)"
compose down --volumes --remove-orphans --rmi all >/dev/null 2>&1 || true
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
if image_exists "${IMAGE}"; then
  docker image rm -f "${IMAGE}" >/dev/null
fi
remove_builder
# Leftovers of an interrupted setup.sh: the builder state volume and its BuildKit image, when nothing uses it.
docker volume rm "buildx_buildkit_${BUILDER}0_state" >/dev/null 2>&1 || true
if image_exists "${BUILDKIT_IMAGE}" && [[ -z "$(docker ps -aq --filter "ancestor=${BUILDKIT_IMAGE}")" ]]; then
  docker image rm "${BUILDKIT_IMAGE}" >/dev/null 2>&1 || true
fi

log "uninstalled: the folder ${AI_DIR} can now be deleted"
notify "🗑️ Open Generative AI : désinstallé" "État : ${state} → supprimé. Conteneur, image et volumes supprimés ; espace libéré." "${COLOR_WARNING}"
