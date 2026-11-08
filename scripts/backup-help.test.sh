#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The in-app backup help must describe the archive the API actually writes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELP="$ROOT/apps/portal-web/content/help/admin/backups.md"
PANEL="$ROOT/apps/portal-web/src/app/admin/backup/backup-view.tsx"

fail() { echo "FAIL: $*" >&2; exit 1; }

flat="$(tr '\n' ' ' <"$HELP")"
for banned in "mc mirror" "docs/operations/restore.md" "SFTP" "fan-out"; do
  if printf '%s' "$flat" | grep -q "$banned"; then
    fail "help still mentions '$banned'"
  fi
done

printf '%s' "$flat" | grep -q "pg_dump" || fail "help does not mention pg_dump"
printf '%s' "$flat" | grep -q "Keycloak" || fail "help does not mention Keycloak"
printf '%s' "$flat" | grep -q "CREDENTIAL_ENCRYPTION_KEY" || fail "help does not mention the encryption key"
printf '%s' "$flat" | grep -q "not an off-site copy" || fail "help does not distinguish a download from an off-site copy"
printf '%s' "$flat" | grep -q "restore-maintenance.sh" || fail "help does not point at the failed-restore checker"
printf '%s' "$flat" | grep -q "does not send mail" || fail "help still implies a failure notification"

# The panel must not tell an admin that recreating users on a fresh
# install is sufficient.
if grep -q "fresh deployment works" "$PANEL"; then
  fail "backup panel still claims a fresh deployment restore works"
fi
grep -q "Not a new install" "$PANEL" || fail "backup panel missing the new-install warning"

if [[ -e "$ROOT/docs/operations/restore.md" ]]; then
  fail "docs/operations/restore.md exists; the help used to point at a page that was not the product"
fi

echo "backup help tests passed"
