#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# First boot of the throwaway recovery drill. The local Postgres image
# loads PostGIS itself and does not create the Keycloak role.
set -euo pipefail

if [[ -z "${KEYCLOAK_DB_PASSWORD:-}" ]]; then
  echo "FATAL: KEYCLOAK_DB_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v kc_pw="${KEYCLOAK_DB_PASSWORD}" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw';
CREATE DATABASE keycloak OWNER keycloak;
SQL
