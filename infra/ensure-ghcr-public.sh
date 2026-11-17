#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# After the images are pushed: ask GitHub to mark each package public,
# then prove an anonymous client can pull every required tag.
#
# The publish workflow used to do this with `gh api` and a pre-encoded
# package name. `gh` encodes the path again, so `%2F` became `%252F`,
# the visibility call 404'd, and every publish job went red. The
# script-runner job waits for those jobs, so it never ran and
# ghcr.io/.../script-runner was never pushed. Anonymous GHCR then
# answers DENIED for that name.
#
# curl is used here so the slash in `gratis-gis/<image>` is encoded
# exactly once. The anonymous token request is the real pass/fail:
# a visibility API that we misunderstand must not hide a private package.
#
# Env:
#   OWNER     GitHub owner (palavido-dev)
#   SHA       full commit sha being published
#   REF_TYPE  branch or tag
#   REF_NAME  branch name or tag (v1.2.3)
#   GH_TOKEN  token that can admin the package (GITHUB_TOKEN). Optional
#             when --check-only is passed.
#   --check-only   skip the visibility PUT; only test anonymous pull
set -euo pipefail

CHECK_ONLY=0
if [ "${1:-}" = "--check-only" ]; then
  CHECK_ONLY=1
fi

: "${OWNER:?OWNER is required}"
: "${SHA:?SHA is required}"
: "${REF_TYPE:?REF_TYPE is required}"
: "${REF_NAME:?REF_NAME is required}"

images=(postgres portal-api portal-web pointcloud-worker script-runner)
short="${SHA::12}"
if [ "$REF_TYPE" = "tag" ]; then
  tags=("$REF_NAME" latest)
else
  tags=(edge "sha-${short}")
fi

fail=0

ui_hint() {
  local image="$1"
  cat <<EOF
${image} is not anonymously pullable.
The package is missing, or it is still private.
If the image was pushed and only visibility is left, the owner does this once:
  1. Open https://github.com/${OWNER}?tab=packages
  2. Click gratis-gis/${image}
     (direct: https://github.com/${OWNER}/gratis-gis/pkgs/container/gratis-gis%2F${image}/settings)
  3. Package settings, on the right.
  4. Danger Zone, Change visibility, Public.
  5. Type the package name and confirm.
A package cannot be made private again after that.
EOF
}

set_public() {
  local image="$1"
  local enc="gratis-gis%2F${image}"
  local url code body
  local ok=0
  for url in \
    "https://api.github.com/orgs/${OWNER}/packages/container/${enc}/visibility" \
    "https://api.github.com/user/packages/container/${enc}/visibility" \
    "https://api.github.com/users/${OWNER}/packages/container/${enc}/visibility"
  do
    body="$(mktemp)"
    code="$(curl -sS -o "$body" -w '%{http_code}' -X PUT \
      -H "Authorization: Bearer ${GH_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$url" \
      -d '{"visibility":"public"}' || true)"
    echo "${image}: PUT ${url} -> HTTP ${code} $(tr '\n' ' ' < "$body" | head -c 240)"
    rm -f "$body"
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
      ok=1
      break
    fi
  done
  if [ "$ok" != "1" ]; then
    echo "${image}: visibility API did not return 200 or 204. Anonymous pull is still required." >&2
  fi
}

anonymous_ok() {
  local image="$1"
  local tag token_file token code
  token_file="$(mktemp)"
  code="$(curl -sS -o "$token_file" -w '%{http_code}' \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:${OWNER}/gratis-gis/${image}:pull" || true)"
  if [ "$code" != "200" ] || ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))["token"]' "$token_file" >/dev/null 2>&1; then
    echo "${image}: anonymous token HTTP ${code}" >&2
    rm -f "$token_file"
    return 1
  fi
  token="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$token_file")"
  rm -f "$token_file"
  for tag in "${tags[@]}"; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json" \
      "https://ghcr.io/v2/${OWNER}/gratis-gis/${image}/manifests/${tag}" || true)"
    echo "${image}: anonymous manifest ${tag} -> HTTP ${code}"
    if [ "$code" != "200" ]; then
      return 1
    fi
  done
  return 0
}

for image in "${images[@]}"; do
  echo "=== ${image} ==="
  if [ "$CHECK_ONLY" != "1" ]; then
    if [ -z "${GH_TOKEN:-}" ]; then
      echo "GH_TOKEN is required to set visibility" >&2
      exit 1
    fi
    set_public "$image"
  fi
  if anonymous_ok "$image"; then
    echo "${image}: public"
  else
    ui_hint "$image" >&2
    fail=1
  fi
done

if [ "$fail" != "0" ]; then
  echo "One or more GHCR packages are missing a tag or are not anonymously pullable." >&2
  exit 1
fi
echo "All GratisGIS images are anonymously pullable."
