#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Real Postgres checks for the maintenance helper. Three tables are
# not enough. An unfinished migration is not enough. A passing gate
# still does not claim the data is safe to serve.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${PG_DOCKER:?set PG_DOCKER to a Postgres container}"
export GG_POSTGRES_CONTAINER="$CONTAINER"
export GG_POSTGRES_DB="${PGDATABASE:-gratisgis}"
export GG_POSTGRES_USER="${PGUSER:-gratisgis}"

fail() { echo "FAIL: $*" >&2; exit 1; }

psql_exec() {
  docker exec -i "$CONTAINER" psql -U "$GG_POSTGRES_USER" -d "$GG_POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"
}

reset() {
  psql_exec -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
}

reset
psql_exec <<'SQL'
CREATE TABLE "user" (id uuid PRIMARY KEY);
CREATE TABLE item (id uuid PRIMARY KEY);
CREATE TABLE system_setting (key text PRIMARY KEY, value jsonb, updated_at timestamptz);
SQL
set +e
out="$("$ROOT/infra/restore-maintenance.sh" clear --i-verified-the-database 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail "three tables were accepted"
printf '%s\n' "$out" | grep -q "missing-relation" || fail "missing-relation not reported: $out"

reset
psql_exec <<'SQL'
CREATE TABLE "user" (id uuid PRIMARY KEY);
CREATE TABLE item (id uuid PRIMARY KEY);
CREATE TABLE organization (id uuid PRIMARY KEY);
CREATE TABLE system_setting (key text PRIMARY KEY, value jsonb, updated_at timestamptz);
CREATE TABLE observation (id uuid PRIMARY KEY);
CREATE TABLE _prisma_migrations (
  id text PRIMARY KEY,
  migration_name text,
  finished_at timestamptz,
  rolled_back_at timestamptz
);
INSERT INTO _prisma_migrations (id, migration_name, finished_at, rolled_back_at)
VALUES ('m1', 'half', NULL, NULL);
INSERT INTO system_setting (key, value) VALUES
  ('maintenance', '{"active":true}'::jsonb);
SQL
set +e
out="$("$ROOT/infra/restore-maintenance.sh" clear --i-verified-the-database 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail "unfinished migration was accepted"
printf '%s\n' "$out" | grep -q "unfinished-migration" || fail "unfinished-migration not reported: $out"
active="$(psql_exec -Atc "SELECT value->>'active' FROM system_setting WHERE key='maintenance'")"
[[ "$active" == "true" ]] || fail "flag was cleared during an unfinished migration"

psql_exec -c "UPDATE _prisma_migrations SET finished_at = now() WHERE id = 'm1';"
out="$("$ROOT/infra/restore-maintenance.sh" clear --i-verified-the-database 2>&1)"
printf '%s\n' "$out" | grep -q "does not prove" || fail "clear claimed the database was proven safe: $out"
printf '%s\n' "$out" | grep -q "Maintenance flag cleared" || fail "flag was not cleared: $out"
active="$(psql_exec -Atc "SELECT value->>'active' FROM system_setting WHERE key='maintenance'")"
[[ "$active" == "false" ]] || fail "flag did not clear after the gate, active=$active"

echo "restore-maintenance postgres test: passed"
