#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Assert the observation log was partitioned by the real pg_partman
# migration. A spec that creates monthly partitions by hand is not
# this check. DATABASE_URL must point at a database migrated with
# the project Postgres image.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo 'assert-partition-invariant: DATABASE_URL is required' >&2
  exit 1
fi

# Prisma's DATABASE_URL includes ?schema=public. libpq rejects that
# query key. Drop a parameter only when its literal name is schema.
# The userinfo, path, fragment, and every other query byte stay as
# written, including percent-encoding. This function does not print
# the URL; callers must not either.
strip_prisma_schema_param() {
  local url=$1
  local frag='' base query rest part key
  case "$url" in
    *\#*)
      frag="#${url#*#}"
      url="${url%%#*}"
      ;;
  esac
  case "$url" in
    *\?*)
      base="${url%%\?*}"
      query="${url#*\?}"
      ;;
    *)
      printf '%s%s' "$url" "$frag"
      return 0
      ;;
  esac
  rest=''
  while [[ -n "$query" ]]; do
    case "$query" in
      *\&*)
        part="${query%%&*}"
        query="${query#*&}"
        ;;
      *)
        part="$query"
        query=''
        ;;
    esac
    key="${part%%=*}"
    if [[ "$key" == 'schema' ]]; then
      continue
    fi
    if [[ -n "$rest" ]]; then
      rest="${rest}&${part}"
    else
      rest="$part"
    fi
  done
  if [[ -n "$rest" ]]; then
    printf '%s?%s%s' "$base" "$rest" "$frag"
  else
    printf '%s%s' "$base" "$frag"
  fi
}

conn="$(strip_prisma_schema_param "$DATABASE_URL")"
psql "$conn" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_partman') THEN
    RAISE EXCEPTION 'pg_partman is not installed';
  END IF;
  IF (
    SELECT c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'observation'
  ) IS DISTINCT FROM 'p' THEN
    RAISE EXCEPTION 'observation is not a partitioned table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM partman.part_config
    WHERE parent_table = 'public.observation'
  ) THEN
    RAISE EXCEPTION 'partman.part_config has no public.observation parent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM partman.part_config
    WHERE parent_table = 'public.observation'
      AND partition_interval NOT IN ('1 mon', '1 month')
  ) THEN
    RAISE EXCEPTION 'observation is not partitioned monthly';
  END IF;
END $$;
SQL

echo 'partition invariant: observation is a monthly pg_partman parent'
