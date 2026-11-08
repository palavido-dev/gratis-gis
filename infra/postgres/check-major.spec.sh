#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '17\n' > "$tmp/PG_VERSION"
"$root/check-major.sh" --data-version-file "$tmp/PG_VERSION" --image-major 17 >/dev/null

printf '16\n' > "$tmp/PG_VERSION"
if "$root/check-major.sh" --data-version-file "$tmp/PG_VERSION" --image-major 17 >/dev/null 2>&1; then
  echo "16 data directory was accepted by an 17 image" >&2
  exit 1
fi

printf '18\n' > "$tmp/PG_VERSION"
if "$root/check-major.sh" --data-version-file "$tmp/PG_VERSION" --image-major 17 >/dev/null 2>&1; then
  echo "18 data directory was accepted by an 17 image" >&2
  exit 1
fi

mkdir -p "$tmp/plan"
printf '%s\n' '-- PostgreSQL database dump' 'SET statement_timeout = 0;' > "$tmp/plan/portal.sql"
printf '%s\n' '-- PostgreSQL database dump' 'SET statement_timeout = 0;' > "$tmp/plan/keycloak.sql"
printf '%s\n' 'lc_collate=en_US.utf8' 'lc_ctype=en_US.utf8' > "$tmp/plan/collation.txt"
printf '%s\n' 'postgis' 'pg_partman' > "$tmp/plan/extensions.txt"
"$root/plan-upgrade.sh" --check "$tmp/plan" >/dev/null

echo "postgres major guard ok"
