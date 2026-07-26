#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Single-command GratisGIS installer (#147).
#
#   curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
#
# Clones the repo, checks out the newest release tag, runs the guided
# setup, deploys the stack, and prints where to sign in. Prompts still
# work when piped because setup.sh reads from /dev/tty. Override the
# defaults with env vars:
#   GRATIS_DIR=/opt/gratis-gis   install location
#   GRATIS_REPO=<git url>        repository to clone
#   GG_REF=v0.9.0                tag, branch, or sha to install
#                                (default: newest release tag)
#
# Everything runs inside main() so a partially downloaded script
# cannot execute half an installer.
set -euo pipefail

# Resolve which ref to install. GG_REF (a tag, branch, or commit sha)
# wins when set; otherwise the newest release tag (vX.Y.Z only, so a
# pre-release like v1.0.0-rc.1 is never auto-picked); when the remote
# has no release tags yet, fall back to main with a warning so
# pre-release checkouts keep deploying. Failing to LIST tags is fatal
# rather than a silent fallback: a transient network error must not
# flip a release-pinned deploy back onto main.
#
# Keep this function in sync with the copy in infra/deploy.sh.
gg_resolve_ref() {
  local remote="$1"
  if [[ -n "${GG_REF:-}" ]]; then
    printf '%s\n' "$GG_REF"
    return 0
  fi
  local tags latest
  if ! tags="$(git ls-remote --tags --refs "$remote" 'v[0-9]*')"; then
    echo "FATAL: could not list release tags on ${remote}." >&2
    return 1
  fi
  latest="$(printf '%s\n' "$tags" \
    | awk '{print $2}' \
    | sed 's|^refs/tags/||' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -n 1)" || true
  if [[ -n "$latest" ]]; then
    printf '%s\n' "$latest"
  else
    echo "WARN: no release tags found on ${remote}; falling back to main." >&2
    printf '%s\n' "main"
  fi
}

main() {
  local repo="${GRATIS_REPO:-https://github.com/palavido-dev/gratis-gis}"
  local dir="${GRATIS_DIR:-/opt/gratis-gis}"

  echo ""
  echo "GratisGIS installer"
  echo "==================="

  local missing=""
  for bin in git docker curl openssl; do
    command -v "$bin" >/dev/null 2>&1 || missing="${missing} ${bin}"
  done
  if [ -n "$missing" ]; then
    echo "ERROR missing required tools:${missing}" >&2
    echo "Install them (Docker with the compose plugin, git, curl, openssl) and re-run." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR docker compose v2 plugin not found (docker compose version failed)." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "ERROR the docker daemon is not reachable by this user." >&2
    echo "Run as root, or add this user to the docker group and re-login." >&2
    exit 1
  fi

  local fresh_clone=0
  if [ -d "${dir}/.git" ]; then
    echo "Using the existing checkout at ${dir}."
  else
    echo "Cloning ${repo} to ${dir}..."
    mkdir -p "$(dirname "$dir")"
    git clone --depth 1 "$repo" "$dir"
    fresh_clone=1
  fi
  cd "$dir"

  # A fresh clone sits at the tip of the default branch; move it to
  # the release ref so the FIRST deploy already runs the released
  # deploy script. Existing checkouts are left alone here: deploy.sh
  # re-resolves the ref and hard-resets to it on every run, and may
  # be guarding local state we should not clobber from the installer.
  if [ "$fresh_clone" = "1" ]; then
    local ref
    ref="$(gg_resolve_ref "$repo")"
    echo "Checking out ${ref}..."
    git fetch --quiet --depth 1 origin "$ref"
    git checkout --quiet --detach FETCH_HEAD
  fi

  if [ -f infra/.env.prod ]; then
    echo "infra/.env.prod already exists; keeping it. (Run ./infra/setup.sh --force to regenerate.)"
  else
    bash infra/setup.sh
  fi

  echo ""
  echo "Deploying (first build takes a while; subsequent deploys are faster)..."
  ./infra/deploy.sh

  local domain
  domain="$(grep '^PORTAL_DOMAIN=' infra/.env.prod | cut -d= -f2-)"
  echo ""
  echo "Done. Sign in at https://${domain} with the credentials setup"
  echo "printed (username admin). Certificates can take a minute or two"
  echo "on first boot while Caddy talks to Let's Encrypt."
  echo ""
  echo "Health check any time: ${dir}/infra/doctor.sh"
}

main "$@"
