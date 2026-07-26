#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs once, on first postgres container boot in PRODUCTION. Creates a
# `keycloak` role + database for the Keycloak service, with the
# password sourced from KEYCLOAK_DB_PASSWORD in the container env (set
# by docker-compose). The official postgres image executes every
# *.sh in /docker-entrypoint-initdb.d after the *.sql files have
# already run, so the GratisGIS extensions from init-prod-db.sql are
# already in place by the time we get here.
#
# Idempotent: skips role/db creation if either already exists. That
# matters if the container is re-initialized against an existing
# volume (rare, but the volume key changes if compose names change).
set -euo pipefail

if [[ -z "${KEYCLOAK_DB_PASSWORD:-}" ]]; then
  echo "FATAL: KEYCLOAK_DB_PASSWORD must be set in the postgres container env" >&2
  exit 1
fi

# psql variable substitution (`:'kc_pw'`) only works in top-level SQL,
# not inside DO blocks, so we keep the role + database creation as
# bare statements. -v ON_ERROR_STOP=0 lets us no-op on re-runs (rare,
# since initdb only fires on first boot, but harmless for retries).
psql -v ON_ERROR_STOP=0 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v kc_pw="${KEYCLOAK_DB_PASSWORD}" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw';
CREATE DATABASE keycloak OWNER keycloak;
SQL

echo "[init-prod-db.sh] keycloak role + database ready"
