# shellcheck shell=bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared guards for the opt-in host recovery scripts.
# A script must be given its compose project twice (env and flag).
# It never lists other projects. Before it changes anything it checks
# that the named project really has the services this stack runs.

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
  # gratis-gis (docker-compose.nas.yml) and gratis-gis-prod
  # (docker-compose.prod.yml) are the real names and are accepted.
  # Compose fallback names say nothing about which stack is meant.
  case "$project" in
    default|compose|docker)
      recovery_die 'refusing a generic compose project name'
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

# Services that can write to Postgres or MinIO. capture.sh and
# restore.sh stop the running ones from this one list. Postgres itself
# stays up so it can be dumped and restored.
# shellcheck disable=SC2034
RECOVERY_WRITERS=(portal-api portal-web portal-worker pointcloud-worker script-runner script-executor keycloak minio)

# The callers set PROJECT and COMPOSE_FILE before they use these.
recovery_compose() {
  # shellcheck disable=SC2153
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# Check that PROJECT is a running GratisGIS stack. The compose file
# must define postgres, keycloak, and minio (and portal-api unless
# GRATIS_RECOVERY_EXTERNAL_API=stopped), and the project must already
# have those containers, with postgres running. A wrong -p name finds
# no containers and stops here. Sets RECOVERY_SERVICES.
recovery_require_stack() {
  local svc cid state
  RECOVERY_SERVICES=()
  mapfile -t RECOVERY_SERVICES < <(recovery_compose config --services 2>/dev/null || true)
  [[ ${#RECOVERY_SERVICES[@]} -gt 0 ]] || recovery_die 'compose file could not be read for this project'
  for svc in postgres keycloak minio; do
    if ! printf '%s\n' "${RECOVERY_SERVICES[@]}" | grep -qx "$svc"; then
      if [[ "$svc" == minio ]]; then
        recovery_die 'unsupported-concurrent-write: this compose file has no minio service to isolate'
      fi
      recovery_die "compose file has no ${svc} service"
    fi
  done
  if ! printf '%s\n' "${RECOVERY_SERVICES[@]}" | grep -qx portal-api; then
    [[ "${GRATIS_RECOVERY_EXTERNAL_API:-}" == "stopped" ]] \
      || recovery_die 'unsupported-concurrent-write: portal-api is not in this compose file and GRATIS_RECOVERY_EXTERNAL_API is not stopped'
  fi
  for svc in postgres keycloak minio; do
    cid="$(recovery_compose ps -aq "$svc" 2>/dev/null | head -n 1 || true)"
    [[ -n "$cid" ]] || recovery_die "project ${PROJECT} has no ${svc} container; check the project name"
  done
  cid="$(recovery_compose ps -aq postgres 2>/dev/null | head -n 1 || true)"
  state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)"
  [[ "$state" == running ]] || recovery_die "postgres in project ${PROJECT} is not running"
}

# One line per image the compose file resolves to: "ref|image id".
# The id is empty when the image is not on this host. capture.sh
# records these lines and restore.sh compares them.
recovery_images() {
  local ref id
  while IFS= read -r ref; do
    [[ -n "$ref" ]] || continue
    id="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)"
    printf '%s|%s\n' "$ref" "$id"
  done < <(recovery_compose config --images | sort -u)
}

# Latest applied Prisma migration in the portal database, or an empty
# line when the table does not exist (a fixture or an unmigrated
# database). Fails when Postgres cannot be queried.
recovery_latest_migration() {
  local db="$1" has
  has="$(recovery_compose exec -T postgres psql -U "${POSTGRES_USER:-gratisgis}" -d "$db" -v ON_ERROR_STOP=1 -Atc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")" || return 1
  if [[ "$has" == t ]]; then
    recovery_compose exec -T postgres psql -U "${POSTGRES_USER:-gratisgis}" -d "$db" -v ON_ERROR_STOP=1 -Atc \
      "SELECT coalesce(max(migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" \
      || return 1
  else
    printf '\n'
  fi
}

# Stop each running writer in RECOVERY_WRITERS that the compose file
# defines. A stopped service stays stopped. The containers this call
# stopped are appended to RECOVERY_STOPPED_IDS and
# RECOVERY_STOPPED_NAMES so recovery_start_stopped can start exactly
# those. The caller defines fail().
RECOVERY_STOPPED_IDS=()
RECOVERY_STOPPED_NAMES=()
recovery_stop_writers() {
  local svc cid state
  for svc in "${RECOVERY_WRITERS[@]}"; do
    printf '%s\n' "${RECOVERY_SERVICES[@]}" | grep -qx "$svc" || continue
    cid="$(recovery_compose ps -aq "$svc" 2>/dev/null | head -n 1 || true)"
    [[ -n "$cid" ]] || continue
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)"
    case "$state" in
      running|restarting)
        docker stop "$cid" >/dev/null 2>&1 || fail "could not stop ${svc}"
        RECOVERY_STOPPED_IDS+=("$cid")
        RECOVERY_STOPPED_NAMES+=("$svc")
        ;;
      exited|created|dead)
        ;;
      *)
        fail "writer ${svc} is ${state:-unknown}; refusing to continue while it can write"
        ;;
    esac
  done
}

# Start, in reverse order, only the containers recovery_stop_writers
# stopped. MinIO and Keycloak come back before the API and workers.
recovery_start_stopped() {
  local i
  for ((i=${#RECOVERY_STOPPED_IDS[@]}-1; i>=0; i--)); do
    docker start "${RECOVERY_STOPPED_IDS[$i]}" >/dev/null 2>&1 || true
  done
  RECOVERY_STOPPED_IDS=()
  RECOVERY_STOPPED_NAMES=()
}
