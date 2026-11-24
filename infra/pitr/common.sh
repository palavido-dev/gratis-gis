#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Docker helpers shared by infra/pitr-*.sh. Sourced, not run.
# Pure helpers live in lib-pitr.sh.

PITR_ROOT="${PITR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PITR_PROJECT="gratis-gis-prod"
PITR_CONTAINER="${PITR_CONTAINER:-gratis-gis-prod-postgres}"
PITR_ENV_FILE="${PITR_ENV_FILE:-$PITR_ROOT/infra/.env.pitr}"
PITR_PROD_ENV="${PITR_PROD_ENV:-$PITR_ROOT/infra/.env.prod}"

# shellcheck source=infra/pitr/lib-pitr.sh
. "$PITR_ROOT/infra/pitr/lib-pitr.sh"

pitr_compose() {
  docker compose \
    -f "$PITR_ROOT/infra/docker-compose.prod.yml" \
    -f "$PITR_ROOT/infra/docker-compose.pitr.yml" \
    --env-file "$PITR_PROD_ENV" "$@"
}

# Run pgBackRest in the running postgres container as the postgres
# user. pgBackRest 2.59 and later refuse to run as root.
pitr_pgbackrest() {
  docker exec -u postgres "$PITR_CONTAINER" pgbackrest --stanza="$PITR_STANZA" "$@"
}

# psql as the image's superuser over the local socket.
pitr_psql() {
  docker exec -u postgres "$PITR_CONTAINER" sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d postgres "$@"' psql "$@"
}

pitr_require_project() {
  if [[ "${1:-}" != "$PITR_PROJECT" ]]; then
    echo "pitr: pass --confirm-project $PITR_PROJECT. This only works on the VPS stack." >&2
    exit 1
  fi
}

pitr_wait_ready() {
  local i
  for i in $(seq 1 90); do
    if docker exec -u postgres "$PITR_CONTAINER" pg_isready -q -h /var/run/postgresql >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "pitr: postgres did not become ready in 3 minutes. See: docker logs $PITR_CONTAINER" >&2
  return 1
}
