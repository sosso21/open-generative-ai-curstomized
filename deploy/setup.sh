#!/usr/bin/env bash
# Installs Open Generative AI in one go: clone our fork if missing (submodules are vendored in it), build the
# image from the working copy in a throwaway BuildKit builder (its cache disappears with it), start the app on
# the WireGuard address only, then the publication watcher (watch.sh).
# Usage (root): ./setup.sh        Run it again to rebuild after a change of the code.
# Upstream updates are merged by hand: git -C Open-Generative-AI fetch upstream && git merge upstream/main
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tools
trap 'notify_failure installation "${LINENO}"' ERR

buildkit_was_present=false
if image_exists "${BUILDKIT_IMAGE}"; then
  buildkit_was_present=true
fi

cleanup() {
  remove_builder
  if [[ "${buildkit_was_present}" == false ]] && image_exists "${BUILDKIT_IMAGE}"; then
    docker image rm "${BUILDKIT_IMAGE}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

notify "🟡 Open Generative AI : installation en cours" "Clonage et construction de l'image (plusieurs minutes)." "${COLOR_INFO}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  log "cloning ${REPO_URL}"
  git -c credential.https://github.com.helper= -c "credential.https://github.com.helper=${GH_CREDENTIAL_HELPER}" \
    clone --quiet "${REPO_URL}" "${REPO_DIR}"
  configure_repo_auth
  git -C "${REPO_DIR}" lfs install --local >/dev/null
  git -C "${REPO_DIR}" remote add upstream "${UPSTREAM_URL}"
fi
ensure_output_dir

previous_image="$(docker image inspect -f '{{.Id}}' "${IMAGE}" 2>/dev/null || true)"
remove_builder
docker buildx create --name "${BUILDER}" --driver docker-container --driver-opt "image=${BUILDKIT_IMAGE}" >/dev/null
log "building ${IMAGE}"
docker buildx build --builder "${BUILDER}" --pull --load --tag "${IMAGE}" "${REPO_DIR}"

compose up -d --force-recreate --remove-orphans
if ! wait_until_healthy; then
  docker logs --tail 30 "${CONTAINER}" >&2 || true
  notify_failure installation "${LINENO}"
  fail "the app did not become healthy"
fi

current_image="$(docker image inspect -f '{{.Id}}' "${IMAGE}")"
if [[ -n "${previous_image}" && "${previous_image}" != "${current_image}" ]]; then
  docker image rm "${previous_image}" >/dev/null 2>&1 || true
fi

start_watch
log "ready: ${APP_URL} (WireGuard)"
notify "🟢 Open Generative AI : installé et démarré" "Accessible par WireGuard uniquement : ${APP_URL}" "${COLOR_SUCCESS}"
