#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fail when schema.prisma and the migration history disagree in a way
# that is not already listed in apps/portal-api/prisma/drift-baseline.sql.
#
# Migrations here are hand-lifted from `prisma migrate diff`. When the
# schema drifts from what the migrations built, the next diff proposes
# "fixes" (renamed foreign keys, dropped defaults, dropped foreign
# keys) that someone may copy into a migration. This check catches the
# drift when it is introduced.
#
# Needs DATABASE_URL and SHADOW_DATABASE_URL (an empty database the
# check may reset). PRISMA_DIFF_FILE replaces the prisma call with a
# saved diff, for tests.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/apps/portal-api"
BASELINE="${PRISMA_DRIFT_BASELINE:-$API/prisma/drift-baseline.sql}"

diff_file="$(mktemp)"
trap 'rm -f "$diff_file"' EXIT

if [[ -n "${PRISMA_DIFF_FILE:-}" ]]; then
  cp "$PRISMA_DIFF_FILE" "$diff_file"
else
  : "${DATABASE_URL:?DATABASE_URL must be set}"
  : "${SHADOW_DATABASE_URL:?SHADOW_DATABASE_URL must be set}"
  (cd "$API" && npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-schema prisma/schema.prisma \
    --script) >"$diff_file"
fi

python3 - "$diff_file" "$BASELINE" <<'PY'
import re
import sys


def statements(path):
    text = open(path, encoding="utf-8").read()
    out = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l for l in block.splitlines() if l.strip() and not l.lstrip().startswith("--")]
        if lines:
            out.append(" ".join(" ".join(lines).split()))
    return out


found = statements(sys.argv[1])
known = set(statements(sys.argv[2]))
new = [s for s in found if s not in known]
gone = sorted(known - set(found))
if gone:
    print("These baseline entries no longer appear; remove them from the baseline:")
    for s in gone:
        print("  " + s)
if new:
    print("schema.prisma and the migrations disagree. prisma migrate diff wants:")
    for s in new:
        print("  " + s)
    print("Fix schema.prisma (map:, @db types, defaults, relations) or add a migration.")
    sys.exit(1)
print("Prisma schema drift check passed (%d known difference(s))." % len(found))
PY
