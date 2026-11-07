#!/usr/bin/env bash
# Publishes the working copy to GitHub: when the code changed or output/ holds new results, it creates the
# branch change/YYYY-MM-DD_HH-MM-SS (Africa/Algiers time), commits everything (output media through Git LFS),
# pushes it (HTTPS, gh login of root), checks that the remote branch head is the local commit and that every LFS
# object is on GitHub, and only then removes the published files from output/ (that removal is committed
# locally and travels with the next branch). Run by watch.sh every 5 minutes; can be run by hand.
# Usage (root): ./publish.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

readonly DEPLOY_FILES=(compose.yml lib.sh setup.sh start.sh pause.sh uninstall.sh publish.sh watch.sh)
readonly BRANCH_PREFIX="change/"
readonly BRANCH_TIME_ZONE="Africa/Algiers"
readonly LFS_MEDIA_TYPE="application/vnd.git-lfs+json"

require_tools
command -v git-lfs >/dev/null || fail "missing tool: git-lfs"
command -v gh >/dev/null || fail "missing tool: gh"
trap '[[ "${PUBLISH_NOTIFY_FAILURE:-1}" == 1 ]] && notify_failure publication "${LINENO}"' ERR

exec 9>"${PUBLISH_LOCK}"
if ! flock -n 9; then
  log "another publication is running"
  exit 0
fi

repo() { git -C "${REPO_DIR}" "$@"; }

# deploy/ in the repository mirrors the scripts of this folder, which stay the ones that run.
sync_deploy_files() {
  local file mode
  mkdir -p "${REPO_DIR}/deploy"
  for file in "${DEPLOY_FILES[@]}"; do
    cmp -s "${AI_DIR}/${file}" "${REPO_DIR}/deploy/${file}" && continue
    mode=0644
    [[ "${file}" == *.sh ]] && mode=0755
    install -m "${mode}" "${AI_DIR}/${file}" "${REPO_DIR}/deploy/${file}"
  done
}

published_outputs() { repo ls-files -- output/ | grep -v '^output/\.gitkeep$' || true; }

lfs_paths() {
  repo diff-tree --root --no-commit-id --name-only -r --diff-filter=AM "$1" -- output/ |
    repo check-attr --stdin filter | sed -n 's/: filter: lfs$//p'
}

# Asks the GitHub LFS batch API (same gh credentials as git) whether every object exists remotely.
verify_lfs_objects() {
  local commit="$1" path pointer oid size objects="[]" headers response missing
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    pointer="$(repo cat-file -p "${commit}:${path}")"
    oid="$(sed -n 's/^oid sha256://p' <<<"${pointer}")"
    size="$(sed -n 's/^size //p' <<<"${pointer}")"
    [[ -n "${oid}" && -n "${size}" ]] || fail "not stored with Git LFS: ${path}"
    objects="$(jq -c --arg oid "${oid}" --argjson size "${size}" '. + [{oid: $oid, size: $size}]' <<<"${objects}")"
  done < <(lfs_paths "${commit}")
  [[ "$(jq length <<<"${objects}")" -gt 0 ]] || return 0

  # The token only goes through a 0600 file of this folder: never on a command line or in the output.
  headers="$(mktemp -p "${AI_DIR}" .lfs-headers.XXXXXX)"
  printf 'Authorization: Basic %s\n' "$(printf 'x-access-token:%s' "$(gh auth token)" | base64 -w0)" >"${headers}"
  response="$(curl -fsS -m 60 -X POST "${REPO_URL}/info/lfs/objects/batch" -H "@${headers}" \
    -H "Accept: ${LFS_MEDIA_TYPE}" -H "Content-Type: ${LFS_MEDIA_TYPE}" \
    -d "$(jq -c '{operation: "download", transfers: ["basic"], objects: .}' <<<"${objects}")")" ||
    { rm -f "${headers}"; fail "LFS verification request failed"; }
  rm -f "${headers}"
  missing="$(jq '[.objects[] | select(.actions.download == null)] | length' <<<"${response}")"
  [[ "${missing}" == 0 ]] || fail "${missing} LFS object(s) missing on GitHub"
  log "LFS verified: $(jq length <<<"${objects}") object(s) on GitHub"
}

remote_head() { repo ls-remote origin "refs/heads/$1" | cut -f1; }

clear_published_outputs() {
  local branch="$1" files
  mapfile -t files < <(published_outputs)
  ((${#files[@]} > 0)) || return 0
  repo rm -q -- "${files[@]}"
  repo commit -q -m "chore: clear outputs published in ${branch}"
  find "${OUTPUT_DIR}" -mindepth 1 -type d -empty -delete
  log "output/ cleaned (${#files[@]} file(s))"
}

new_branch_name() {
  local name
  while :; do
    name="${BRANCH_PREFIX}$(TZ="${BRANCH_TIME_ZONE}" date +%Y-%m-%d_%H-%M-%S)"
    if ! repo show-ref --verify --quiet "refs/heads/${name}" && [[ -z "$(remote_head "${name}")" ]]; then
      printf '%s' "${name}"
      return 0
    fi
    sleep 1
  done
}

current="$(repo symbolic-ref --short -q HEAD || true)"
# Resumes a run interrupted after its push: the branch is on GitHub but output/ was not cleaned yet.
if [[ "${current}" == "${BRANCH_PREFIX}"* && -n "$(published_outputs)" &&
  "$(remote_head "${current}")" == "$(repo rev-parse HEAD)" ]]; then
  verify_lfs_objects HEAD
  clear_published_outputs "${current}"
fi

sync_deploy_files
if [[ -z "$(repo status --porcelain --untracked-files=all)" ]]; then
  exit 0
fi

branch="$(new_branch_name)"
repo switch -q -c "${branch}"
repo add -A
total="$(repo diff --cached --name-only | wc -l)"
outputs="$(repo diff --cached --name-only -- output/ | wc -l)"
repo commit -q -m "chore: publish ${branch#"${BRANCH_PREFIX}"}" \
  -m "${total} file(s) changed, ${outputs} of them in output/."
commit="$(repo rev-parse HEAD)"
log "pushing ${branch} (${total} file(s), ${outputs} in output/)"
repo push -q -u origin "${branch}"

[[ "$(remote_head "${branch}")" == "${commit}" ]] || fail "remote ${branch} does not point to ${commit}"
verify_lfs_objects "${commit}"
clear_published_outputs "${branch}"

log "published ${branch}"
notify "📦 Open Generative AI : publication" \
  "Branche \`${branch}\` poussée et vérifiée : ${total} fichier(s), dont ${outputs} dans output/ (vidé ensuite). https://github.com/${REPO_SLUG}/tree/${branch}" \
  "${COLOR_SUCCESS}"
