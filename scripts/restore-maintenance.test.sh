#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The maintenance helper must refuse to clear a database that is missing tables.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/infra/restore-maintenance.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

if grep -E -q 'volume[[:space:]]+rm|docker[[:space:]]+volume' "$SCRIPT"; then
  fail "maintenance script mentions docker volume deletion"
fi

mkdir -p "$TMP/bin"
# GG_FAKE_TABLES=t|f controls the precheck answer.
cat >"$TMP/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
if [ "$1" = "ps" ]; then
  echo "gratis-gis-postgres-1"
  exit 0
fi
# psql query is the last argument of exec
if printf '%s' "$*" | grep -q 'to_regclass'; then
  printf '%s\n' "${GG_FAKE_TABLES:?}"
  exit 0
fi
if printf '%s' "$*" | grep -q 'INSERT INTO system_setting'; then
  echo "cleared" >> "${DOCKER_LOG:?}"
  exit 0
fi
if printf '%s' "$*" | grep -q "key = 'maintenance'"; then
  echo '{"active":true}'
  exit 0
fi
exit 0
EOF
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH"
export DOCKER_LOG="$TMP/docker.log"
export GG_POSTGRES_CONTAINER="gratis-gis-postgres-1"

export GG_FAKE_TABLES=f
set +e
status_out="$("$SCRIPT" status 2>&1)"
status_code=$?
set -e
[[ "$status_code" -eq 2 ]] || fail "missing tables should exit 2, got $status_code ($status_out)"
printf '%s\n' "$status_out" | grep -q "MISSING" || fail "status did not say tables are missing"

: >"$DOCKER_LOG"
set +e
clear_out="$("$SCRIPT" clear --i-verified-the-database 2>&1)"
clear_code=$?
set -e
[[ "$clear_code" -ne 0 ]] || fail "clear succeeded while tables were missing"
if grep -q "cleared" "$DOCKER_LOG"; then
  fail "clear wrote the flag while tables were missing"
fi
printf '%s\n' "$clear_out" | grep -q "Maintenance stays on" || fail "clear refusal missing"

export GG_FAKE_TABLES=t
: >"$DOCKER_LOG"
set +e
noflag="$("$SCRIPT" clear 2>&1)"
noflag_code=$?
set -e
[[ "$noflag_code" -ne 0 ]] || fail "clear without the verification flag was accepted"
if grep -q "cleared" "$DOCKER_LOG"; then
  fail "clear wrote the flag without the verification flag"
fi

"$SCRIPT" clear --i-verified-the-database >"$TMP/ok.txt"
grep -q "cleared" "$DOCKER_LOG" || fail "verified clear did not write the flag"
grep -q "Maintenance flag cleared" "$TMP/ok.txt" || fail "success message missing"
if grep -q "volume" "$DOCKER_LOG"; then
  fail "docker volume was invoked"
fi

echo "restore-maintenance tests passed"
