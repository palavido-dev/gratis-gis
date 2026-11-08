#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Reset a user in an isolated Keycloak and prove the new password
# obtains a token. Secrets stay in the container and this process.
# Nothing is printed except pass/fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${KC_TEST_CONTAINER:-gg-kc-reset-test}"
PORT="${KC_TEST_PORT:-18080}"

fail() { echo "FAIL: $*" >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=bootstrap-test-secret \
  -p "127.0.0.1:${PORT}:8080" \
  quay.io/keycloak/keycloak:26.0 start-dev >/dev/null

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" /opt/keycloak/bin/kcadm.sh config credentials \
      --server http://127.0.0.1:8080 --realm master \
      --user admin --password bootstrap-test-secret >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" -eq 1 ]] || fail "keycloak did not become ready"

kcadm() {
  docker exec "$NAME" /opt/keycloak/bin/kcadm.sh "$@"
}

kcadm create realms -s realm=gratis-gis -s enabled=true >/dev/null
kcadm create users -r gratis-gis \
  -s username=field-tech \
  -s enabled=true \
  -s emailVerified=true \
  -s email=field-tech@example.test \
  -s firstName=Field \
  -s lastName=Tech >/dev/null
kcadm set-password -r gratis-gis --username field-tech --new-password old-secret >/dev/null
# Creating the user before the password can leave UPDATE_PASSWORD
# required. Direct grant then answers "Account is not fully set up".
user_id="$(kcadm get users -r gratis-gis -q username=field-tech --fields id --format csv --noquotes)"
kcadm update "users/${user_id}" -r gratis-gis -s 'requiredActions=[]' -s emailVerified=true >/dev/null
kcadm create clients -r gratis-gis \
  -s clientId=reset-check \
  -s publicClient=true \
  -s directAccessGrantsEnabled=true \
  -s standardFlowEnabled=false >/dev/null

token_for() {
  local secret="$1"
  curl -sS -X POST "http://127.0.0.1:${PORT}/realms/gratis-gis/protocol/openid-connect/token" \
    -d client_id=reset-check \
    -d grant_type=password \
    -d username=field-tech \
    -d "password=${secret}"
}

has_token() {
  python3 -c 'import json,sys
try:
    json.loads(sys.stdin.read())["access_token"]
except Exception:
    sys.exit(1)' >/dev/null
}

token_for old-secret | has_token || fail "old password did not authenticate"

# The helper prints the new password once. Keep it out of this script's
# success line. RESET_PASSWORD avoids a generated value we would have
# to scrape.
export GG_KEYCLOAK_CONTAINER="$NAME"
export RESET_PASSWORD="replacement-secret-value"
export GG_RESET_DRY_RUN=0
"$ROOT/infra/reset-portal-password.sh" field-tech >/tmp/gg-kc-reset-out.$$
if grep -q "bootstrap-test-secret" /tmp/gg-kc-reset-out.$$; then
  rm -f /tmp/gg-kc-reset-out.$$
  fail "bootstrap admin password was printed"
fi
rm -f /tmp/gg-kc-reset-out.$$

token_for replacement-secret-value | has_token || fail "new password did not authenticate"
if token_for old-secret | has_token; then
  fail "old password still works"
fi

echo "keycloak password reset: passed"
