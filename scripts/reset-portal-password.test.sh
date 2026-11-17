#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Safety checks for the password reset helper. No Keycloak and no volumes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/infra/reset-portal-password.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The script text itself must not delete volumes.
if grep -E -q 'volume[[:space:]]+rm|docker[[:space:]]+volume' "$SCRIPT"; then
  fail "reset script mentions docker volume deletion"
fi

out="$(GG_RESET_DRY_RUN=1 "$SCRIPT" admin)"
printf '%s\n' "$out" | grep -q "dry-run: would reset portal user 'admin'" || fail "dry-run did not name the user"
printf '%s\n' "$out" | grep -q "would not delete volumes" || fail "dry-run did not refuse deletion"

set +e
wipe="$("$SCRIPT" admin --delete 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail "wipe argument was accepted"
printf '%s\n' "$wipe" | grep -q "does not delete volumes" || fail "wipe refusal missing"

# Fake docker: record every invocation. A real reset must not call volume.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
if [ "$1" = "ps" ]; then
  echo "gratis-gis-keycloak-1"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  exit 0
fi
if [ "$1" = "exec" ]; then
  # First exec reads the admin password. Later exec is kcadm.
  if printf '%s' "$*" | grep -q KC_BOOTSTRAP_ADMIN_PASSWORD; then
    printf '%s' "bootstrap-secret"
    exit 0
  fi
  exit 0
fi
echo "unexpected docker $*" >&2
exit 9
EOF
chmod +x "$TMP/bin/docker"

export DOCKER_LOG="$TMP/docker.log"
export PATH="$TMP/bin:$PATH"
export GG_RESET_DRY_RUN=0
export RESET_PASSWORD="synthetic-new-password"
"$SCRIPT" field-tech >"$TMP/out.txt"
grep -q "gratis-gis-keycloak-1" "$DOCKER_LOG" || fail "did not target the keycloak container"
if grep -q "volume" "$DOCKER_LOG"; then
  fail "docker volume was invoked: $(cat "$DOCKER_LOG")"
fi
grep -q "synthetic-new-password" "$TMP/out.txt" || fail "new password was not printed once"
grep -q "No volumes were deleted" "$TMP/out.txt" || fail "success line missing"
# The bootstrap secret must not be printed.
if grep -q "bootstrap-secret" "$TMP/out.txt"; then
  fail "bootstrap admin password leaked to stdout"
fi

echo "reset-portal-password tests passed"
