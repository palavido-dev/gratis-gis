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

# Returns 0 when user, item, and system_setting all exist.
tables_present() {
  local container="$1"
  local out
  out="$(psql_c "$container" "SELECT to_regclass('public.\"user\"') IS NOT NULL AND to_regclass('public.item') IS NOT NULL AND to_regclass('public.system_setting') IS NOT NULL;")"
  [[ "$out" == "t" ]]
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

cmd="${1:-}"
case "$cmd" in
  status)
    container="$(pick_container)"
    echo "container: $container"
    if tables_present "$container"; then
      echo "portal tables: present"
    else
      echo "portal tables: MISSING"
      echo "Do not clear maintenance. Restore the Postgres volume snapshot, or pg_restore a known-good portal dump, before serving traffic."
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
    if ! tables_present "$container"; then
      die "portal tables user, item, or system_setting are missing. Maintenance stays on. Restore a volume snapshot or a known-good dump. This script will not clear the flag and will not delete data."
    fi
    psql_c "$container" "INSERT INTO system_setting (key, value, updated_at) VALUES ('maintenance', '{\"active\":false,\"reason\":null,\"startedAt\":null}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
    echo "Maintenance flag cleared. API replicas re-read it within a few seconds."
    echo "If sign-in still fails, the database is not healthy. Restore the snapshot. Do not delete volumes to recover a password."
    ;;
  --help|-h|"")
    usage
    ;;
  *)
    die "unknown command '$cmd'. Use status or clear."
    ;;
esac
