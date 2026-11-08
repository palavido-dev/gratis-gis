# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared guards for the opt-in host recovery scripts.
# A script must be given its compose project twice (env and flag).
# It never lists other projects and never touches a stock name.

recovery_die() {
  printf 'recovery: %s\n' "$1" >&2
  exit 1
}

recovery_confirm_project() {
  local project="${GRATIS_RECOVERY_PROJECT:-}"
  local confirm="${1:-}"
  if [[ -z "$project" || -z "$confirm" ]]; then
    recovery_die 'set GRATIS_RECOVERY_PROJECT and pass --confirm-project with the same name'
  fi
  if [[ "$project" != "$confirm" ]]; then
    recovery_die 'project confirmation does not match GRATIS_RECOVERY_PROJECT'
  fi
  case "$project" in
    gratis-gis|gratis-gis-prod|default|compose)
      recovery_die 'refusing a stock compose project name'
      ;;
  esac
  if [[ ! "$project" =~ ^[a-z0-9][a-z0-9_-]{2,40}$ ]]; then
    recovery_die 'project name must be a short lowercase token'
  fi
}

recovery_umask() {
  umask 077
}

# sha256 of a file, hex only.
recovery_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

# Node that can run seal.mjs. Prefer the repo's tested 24.9.
recovery_node() {
  if [[ -n "${GRATIS_RECOVERY_NODE:-}" && -x "$GRATIS_RECOVERY_NODE" ]]; then
    printf '%s\n' "$GRATIS_RECOVERY_NODE"
    return
  fi
  if [[ -x /home/ubuntu/.nvm/versions/node/v24.9.0/bin/node ]]; then
    printf '%s\n' /home/ubuntu/.nvm/versions/node/v24.9.0/bin/node
    return
  fi
  command -v node
}
