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

# Node 20 or newer for seal.mjs: GRATIS_RECOVERY_NODE, else node on PATH.
recovery_node() {
  local node="" major
  if [[ -n "${GRATIS_RECOVERY_NODE:-}" ]]; then
    [[ -x "$GRATIS_RECOVERY_NODE" ]] || return 1
    node="$GRATIS_RECOVERY_NODE"
  else
    node="$(command -v node)" || return 1
  fi
  major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 20 ]] || return 1
  printf '%s\n' "$node"
}

# Services that can write to Postgres or MinIO. capture.sh and
# restore.sh stop the running ones from this one list. Postgres itself
# stays up so it can be dumped and restored.
# shellcheck disable=SC2034
RECOVERY_WRITERS=(portal-api portal-web portal-worker pointcloud-worker script-runner script-executor keycloak minio silo)
# Services that may be running and do not write portal, Keycloak, or
# object data. A running service in neither list stops the scripts.
RECOVERY_NON_WRITERS=(postgres caddy bootstrap boot init portal-migrate pg_tileserv nominatim browserless chromium)

recovery_is_writer() {
  local s
  for s in "${RECOVERY_WRITERS[@]}"; do [[ "$1" == "$s" ]] && return 0; done
  return 1
}
recovery_is_non_writer() {
  local s
  for s in "${RECOVERY_NON_WRITERS[@]}"; do [[ "$1" == "$s" ]] && return 0; done
  # chromium-1, chromium-2, browserless-1 in the prod file.
  [[ "$1" =~ ^(chromium|browserless)-[0-9]+$ ]]
}

# The callers set PROJECT and COMPOSE_FILE, and may set the array
# ENV_FILES from --env-file. With no --env-file, compose reads
# COMPOSE_ENV_FILES itself when it is set.
ENV_FILES=()
recovery_compose() {
  # shellcheck disable=SC2153
  local args=(-p "$PROJECT" -f "$COMPOSE_FILE") f
  for f in "${ENV_FILES[@]}"; do
    args+=(--env-file "$f")
  done
  docker compose "${args[@]}" "$@"
}

# Every container of PROJECT, found by its compose label, whatever the
# compose file says: "id|service|state" per line.
recovery_project_containers() {
  docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.ID}}|{{.Label "com.docker.compose.service"}}|{{.State}}'
}

# Check that PROJECT is a running GratisGIS stack. The compose file
# must define postgres, keycloak, and minio (and portal-api unless
# GRATIS_RECOVERY_EXTERNAL_API=stopped), and the project must already
# have those containers, with postgres running. A wrong -p name finds
# no containers and stops here. Every running container of the project
# must be a known writer or a known non-writer. Sets RECOVERY_SERVICES.
recovery_require_stack() {
  local svc cid state line
  RECOVERY_SERVICES=()
  mapfile -t RECOVERY_SERVICES < <(recovery_compose config --services 2>/dev/null || true)
  [[ ${#RECOVERY_SERVICES[@]} -gt 0 ]] || recovery_die 'compose file could not be read for this project (pass --env-file if it needs one)'
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
  while IFS='|' read -r cid svc state; do
    [[ -n "$cid" ]] || continue
    case "$state" in
      exited|created|dead) continue ;;
    esac
    if ! recovery_is_writer "$svc" && ! recovery_is_non_writer "$svc"; then
      recovery_die "project ${PROJECT} runs ${svc:-an unlabeled container}, which is not a known service; stop it or add it to the writer list"
    fi
  done < <(recovery_project_containers)
}

# One line per project container: "service|image id", sorted. The id is
# what the container runs, not what its tag points at now. capture.sh
# records these lines and restore.sh compares them.
recovery_images() {
  local cid svc state line
  while IFS='|' read -r cid svc state; do
    [[ -n "$cid" ]] || continue
    line="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}' "$cid")" || return 1
    printf '%s\n' "$line"
  done < <(recovery_project_containers) | sort -u
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

# Stop every running container of the project whose service is in
# RECOVERY_WRITERS, found by label so a stale compose file cannot hide
# one. A stopped service stays stopped. The containers this call
# stopped are appended to RECOVERY_STOPPED_IDS and
# RECOVERY_STOPPED_NAMES so recovery_start_stopped can start exactly
# those. The caller defines fail().
RECOVERY_STOPPED_IDS=()
RECOVERY_STOPPED_NAMES=()
recovery_stop_writers() {
  local cid svc state row
  local -a rows=()
  mapfile -t rows < <(recovery_project_containers)
  for svc in "${RECOVERY_WRITERS[@]}"; do
    for row in "${rows[@]}"; do
      IFS='|' read -r cid _ state <<<"$row"
      [[ "${row#*|}" == "${svc}|"* ]] || continue
      case "$state" in
        running|restarting|paused)
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
