#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Tests the comparison in check-prisma-drift.sh without a database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/check-prisma-drift.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

cat >"$tmp/baseline.sql" <<'SQL'
-- header comment

-- DropTable
DROP TABLE "observation";
SQL

# Only known drift: passes.
printf -- '-- DropTable\nDROP TABLE "observation";\n' >"$tmp/known.sql"
PRISMA_DRIFT_BASELINE="$tmp/baseline.sql" PRISMA_DIFF_FILE="$tmp/known.sql" \
  bash "$SCRIPT" >/dev/null || fail "known drift was rejected"

# No drift at all: passes and names the stale baseline entry.
: >"$tmp/empty.sql"
out="$(PRISMA_DRIFT_BASELINE="$tmp/baseline.sql" PRISMA_DIFF_FILE="$tmp/empty.sql" bash "$SCRIPT")" \
  || fail "an empty diff was rejected"
grep -q 'no longer appear' <<<"$out" || fail "stale baseline entry not reported"

# New drift (the FK rename from API-OPS-18): fails.
cat >"$tmp/new.sql" <<'SQL'
-- DropTable
DROP TABLE "observation";

-- RenameForeignKey
ALTER TABLE "admin_audit_event" RENAME CONSTRAINT "admin_audit_event_org_fkey" TO "admin_audit_event_org_id_fkey";
SQL
if PRISMA_DRIFT_BASELINE="$tmp/baseline.sql" PRISMA_DIFF_FILE="$tmp/new.sql" bash "$SCRIPT" >"$tmp/out" 2>&1; then
  fail "new drift passed"
fi
grep -q 'admin_audit_event_org_id_fkey' "$tmp/out" || fail "new drift not printed"

echo "check-prisma-drift tests passed"
