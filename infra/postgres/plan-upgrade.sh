#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Plan a Postgres major move for the portal database and the Keycloak
# database. This script does not run pg_upgrade, does not connect, and
# does not change the runtime image. The default image stays 17.
set -eu

mode="print"
fixture=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      mode="check"
      fixture="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument" >&2
      exit 2
      ;;
  esac
done

cat <<'EOF'
Planned Postgres major upgrade. The running image stays postgis/postgis:17-3.5.

1. Stop writers. Keep the current credential key, Keycloak secrets, and object store. They are not inside the SQL dump.
2. Dump the portal database and the Keycloak database with the same major that wrote them.
3. Record lc_collate, lc_ctype, and the extension list (postgis, pg_partman, and anything else the dump's CREATE EXTENSION names).
4. Restore into an empty cluster of the target major with the same collation. A different collation is a failed plan, not a silent accept.
5. Run ANALYZE. Confirm postgis and pg_partman versions. Do not start the old data directory on the new image.
EOF

if [ "$mode" = "print" ]; then
  exit 0
fi

if [ -z "$fixture" ] || [ ! -d "$fixture" ]; then
  echo "check mode needs a fixture directory" >&2
  exit 2
fi

portal="$fixture/portal.sql"
keycloak="$fixture/keycloak.sql"
collation="$fixture/collation.txt"
extensions="$fixture/extensions.txt"

for f in "$portal" "$keycloak" "$collation" "$extensions"; do
  if [ ! -f "$f" ]; then
    echo "missing $f" >&2
    exit 1
  fi
done

for dump in "$portal" "$keycloak"; do
  if ! grep -q '^-- PostgreSQL database dump' "$dump"; then
    echo "not a dump: $dump" >&2
    exit 1
  fi
done

if ! grep -q '^lc_collate=' "$collation" || ! grep -q '^lc_ctype=' "$collation"; then
  echo "collation file must name lc_collate and lc_ctype" >&2
  exit 1
fi

if ! grep -q '^postgis$' "$extensions"; then
  echo "extension list must include postgis" >&2
  exit 1
fi

echo "upgrade plan check passed for portal and keycloak dumps"
