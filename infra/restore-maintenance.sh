#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Inspect or clear the portal maintenance flag after a failed restore.
#
# Clearing is refused unless the portal tables needed to sign in and
# to serve items are present. A half-applied pg_restore leaves
# maintenance on on purpose. This script does not restore data and
# does not delete volumes.
#
#   ./infra/restore-maintenance.sh status
#   ./infra/restore-maintenance.sh clear --i-verified-the-database
#
# Set GG_POSTGRES_CONTAINER when more than one Postgres container is
# running. Set GG_POSTGRES_USER and GG_POSTGRES_DB if they are not
# the defaults (gratisgis / gratisgis).

set -euo pipefail

PGUSER="${GG_POSTGRES_USER:-gratisgis}"
PGDB="${GG_POSTGRES_DB:-gratisgis}"

die() {
  echo "FATAL: $*" >&2
  exit 1
}

pick_container() {
  if [[ -n "${GG_POSTGRES_CONTAINER:-}" ]]; then
    printf '%s\n' "$GG_POSTGRES_CONTAINER"
    return
  fi
  local names count
  names="$(docker ps --filter 'name=postgres' --format '{{.Names}}' | sort)"
  count="$(printf '%s\n' "$names" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" -eq 1 ]]; then
    printf '%s\n' "$names"
    return
  fi
  if [[ "$count" -eq 0 ]]; then
    die "no running container with 'postgres' in its name. Set GG_POSTGRES_CONTAINER."
  fi
  echo "$names" >&2
  die "more than one Postgres container. Set GG_POSTGRES_CONTAINER."
}

psql_c() {
  docker exec -e "PGPASSWORD=${GG_POSTGRES_PASSWORD:-}" "$1" \
    psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -Atc "$2"
}

# One word: present, missing-relation, unfinished-migration, or
# no-finished-migration. "present" is not a claim that the data is a
# consistent restore or safe to serve.
schema_gate() {
  local container="$1"
  local rels
  # Relations first. The migration queries must not run when the
  # table is absent: PostgreSQL does not skip those branches.
  rels="$(psql_c "$container" "
    SELECT (
      to_regclass('public.\"user\"') IS NOT NULL
      AND to_regclass('public.item') IS NOT NULL
      AND to_regclass('public.organization') IS NOT NULL
      AND to_regclass('public.system_setting') IS NOT NULL
      AND to_regclass('public.observation') IS NOT NULL
      AND to_regclass('public._prisma_migrations') IS NOT NULL
    )::text;
  ")"
  if [[ "$rels" != "true" ]]; then
    printf '%s\n' "missing-relation"
    return
  fi
  local unfinished finished
  unfinished="$(psql_c "$container" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;")"
  if [[ "$unfinished" != "0" ]]; then
    printf '%s\n' "unfinished-migration"
    return
  fi
  finished="$(psql_c "$container" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")"
  if [[ "$finished" == "0" ]]; then
    printf '%s\n' "no-finished-migration"
    return
  fi
  printf '%s\n' "present"
}

not_a_safety_proof() {
  echo "This does not prove the database is a consistent restore or safe to serve."
  echo "It only shows the checked relations exist and no migration is unfinished."
  echo "Compare the data with a backup or a volume snapshot before serving traffic."
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

cmd="${1:-}"
case "$cmd" in
  status)
    container="$(pick_container)"
    echo "container: $container"
    gate="$(schema_gate "$container")"
    echo "schema gate: $gate"
    not_a_safety_proof
    if [[ "$gate" != "present" ]]; then
      echo "Do not clear maintenance. Restore a volume snapshot or a known-good portal dump before serving traffic."
      exit 2
    fi
    echo "maintenance row:"
    psql_c "$container" "SELECT coalesce(value::text, '(no row)') FROM system_setting WHERE key = 'maintenance';" \
      || echo "(no maintenance row)"
    ;;
  clear)
    if [[ "${2:-}" != "--i-verified-the-database" ]]; then
      die "refusing to clear maintenance without --i-verified-the-database. Run '$0 status' first. This does not fix a broken database."
    fi
    container="$(pick_container)"
    gate="$(schema_gate "$container")"
    if [[ "$gate" != "present" ]]; then
      die "schema gate is '$gate', not present. Maintenance stays on. Three tables existing is not enough. This script will not clear the flag and will not delete data."
    fi
    psql_c "$container" "INSERT INTO system_setting (key, value, updated_at) VALUES ('maintenance', '{\"active\":false,\"reason\":null,\"startedAt\":null}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
    echo "Maintenance flag cleared. API replicas re-read it within a few seconds."
    echo "If an in-portal restore was interrupted, the API also stays in maintenance while"
    echo "/app/backups/.restore-in-progress exists in the portal-api container. Remove it once verified."
    not_a_safety_proof
    echo "If sign-in still fails, restore the snapshot. Do not delete volumes to recover a password."
    ;;
  --help|-h|"")
    usage
    ;;
  *)
    die "unknown command '$cmd'. Use status or clear."
    ;;
esac
