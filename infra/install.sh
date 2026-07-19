#!/usr/bin/env bash
# Single-command GratisGIS installer (#147).
#
#   curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
#
# Clones the repo, runs the guided setup, deploys the stack, and
# prints where to sign in. Prompts still work when piped because
# setup.sh reads from /dev/tty. Override the defaults with env vars:
#   GRATIS_DIR=/opt/gratis-gis   install location
#   GRATIS_REPO=<git url>        repository to clone
#
# Everything runs inside main() so a partially downloaded script
# cannot execute half an installer.
set -euo pipefail

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

  if [ -d "${dir}/.git" ]; then
    echo "Using the existing checkout at ${dir}."
  else
    echo "Cloning ${repo} to ${dir}..."
    mkdir -p "$(dirname "$dir")"
    git clone --depth 1 "$repo" "$dir"
  fi
  cd "$dir"

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
