#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Provision the three documented test users on the public test
# instance (#139). Pairs with PORTAL_LOCK_ADMIN_TIER + the master-
# admin protection flag: testers can sign in as tester-admin and
# poke at every admin surface, but they cannot mint new admins and
# they cannot touch the protected master `admin` account.
#
# The three users:
#
#   tester-admin       / Admin123!         org_role=admin
#   tester-contributor / Contributor123!   org_role=contributor
#   tester-viewer      / Viewer123!        org_role=viewer
#
# These passwords are intentionally simple and documented openly on
# the public-landing banner. Anyone who can read the banner can sign
# in; that's the point.
#
# IMPORTANT: this script provisions the users into the LIVE prod
# realm. After running it once, capture the snapshot with
# `snapshot-golden.sh` so the daily reset restores these accounts
# every day. Re-running this script is idempotent: existing users
# are updated, not duplicated.
#
# Transport: everything goes through kcadm.sh via docker exec into
# the keycloak container against localhost:8080, the same way
# deploy.sh's realm reconciliation works. The public edge is not an
# option: Caddy blocks both /admin/* and the entire master realm
# (including its token endpoint) at the auth vhost, so this script
# must run on the box that hosts the containers.
#
# Usage:
#   sudo ./infra/seed-test-users.sh
set -euo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.prod"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

REALM="${KEYCLOAK_REALM:-gratis-gis}"
KEYCLOAK_CONTAINER="${KEYCLOAK_CONTAINER:-gratis-gis-prod-keycloak}"
# KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD are the .env.prod names
# (the same ones deploy.sh uses); the BOOTSTRAP_* forms are kept as
# fallbacks for operators who exported them for the old REST flow.
ADMIN_USER="${KEYCLOAK_BOOTSTRAP_ADMIN:-${KEYCLOAK_ADMIN:-admin}}"
ADMIN_PASS="${KEYCLOAK_BOOTSTRAP_PASSWORD:-${KEYCLOAK_ADMIN_PASSWORD:-}}"

if [[ -z "${ADMIN_PASS:-}" ]]; then
  echo "FATAL: need KEYCLOAK_ADMIN_PASSWORD (or KEYCLOAK_BOOTSTRAP_PASSWORD) in $ENV_FILE." >&2
  echo "       This is the master-realm admin password kcadm authenticates with." >&2
  exit 1
fi

# kcadm wrappers matching deploy.sh: KC for plain calls, KCI when a
# JSON body is piped through stdin (kcadm's `-f -` reads standard
# input, and docker exec needs -i for the pipe to reach it).
KC() { docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }
KCI() { docker exec -i "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

echo "=== Authenticating kcadm against the master realm (in-container) ==="
if ! KC config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user "$ADMIN_USER" \
    --password "$ADMIN_PASS" >/dev/null 2>&1; then
  echo "FATAL: kcadm could not authenticate. Is the keycloak container ($KEYCLOAK_CONTAINER)" >&2
  echo "       running, and is KEYCLOAK_ADMIN_PASSWORD current in $ENV_FILE?" >&2
  exit 1
fi

# Lock down the realm's user-profile config so end users cannot
# edit the email field through the Account Console.  Without this,
# a tester could sign in as tester-admin, add their own email, then
# trigger Forgot Password to take ownership of the account until
# the 04:00 UTC reset wipes it.  Idempotent: re-runs leave the
# config in the same state.
lock_email_profile() {
  echo "=== Locking realm user-profile: email is admin-edit only ==="
  KC get users/profile -r "$REALM" > /tmp/gg-profile.json
  python3 << 'PY' > /tmp/gg-profile-new.json
import json
p = json.load(open('/tmp/gg-profile.json'))
for a in p.get('attributes', []):
    if a.get('name') == 'email':
        a['permissions'] = {'view': ['admin','user'], 'edit': ['admin']}
        a.pop('required', None)
print(json.dumps(p))
PY
  KCI update users/profile -r "$REALM" -f - < /tmp/gg-profile-new.json
  rm -f /tmp/gg-profile.json /tmp/gg-profile-new.json
  echo "  done"
}

lock_email_profile

# Resolve a username to its Keycloak user id, or "" if absent.
user_id() {
  local username="$1"
  KC get users -r "$REALM" -q username="$username" -q exact=true --fields id \
    | python3 -c 'import json,sys; arr=json.load(sys.stdin); print(arr[0]["id"] if arr else "")'
}

upsert_user() {
  local username="$1"
  local first="$2"
  local last="$3"
  local password="$4"
  local org_role="$5"

  echo "--- Upserting $username (role=$org_role) ---"
  local existing
  existing="$(user_id "$username")"

  # No email on the demo accounts on purpose: Keycloak's Forgot
  # Password flow needs an email address to send a reset link, so
  # leaving it empty means a curious tester clicking "Forgot
  # password" on tester-admin gets a no-op instead of triggering
  # a reset email that bounces back to our SMTP and could in
  # principle be intercepted.  Paired with the realm user-profile
  # config (email is admin-edit only), this also blocks a tester
  # from adding their own email through the Account Console and
  # then triggering a reset to themselves.
  local body
  body="$(python3 -c "
import json
print(json.dumps({
  'username': '$username',
  'firstName': '$first',
  'lastName': '$last',
  'emailVerified': False,
  'enabled': True,
  'attributes': {
    'org': ['${PORTAL_ORG_SLUG:-${DEFAULT_ORG_SLUG:-gratis-gis}}'],
    'org_role': ['$org_role'],
  },
}))
")"

  if [[ -n "$existing" ]]; then
    echo "  user already exists ($existing); updating profile + role"
    printf '%s' "$body" | KCI update "users/$existing" -r "$REALM" -f -
  else
    echo "  creating new user"
    printf '%s' "$body" | KCI create users -r "$REALM" -f -
    existing="$(user_id "$username")"
    if [[ -z "$existing" ]]; then
      echo "FATAL: created $username but cannot resolve its id afterwards; check kcadm output." >&2
      exit 1
    fi
  fi

  # Reset password to the documented value. kcadm set-password hits
  # the same reset-password endpoint Keycloak's admin UI uses;
  # without --temporary the user is NOT forced to change it on next
  # login.
  echo "  setting password"
  KC set-password -r "$REALM" --userid "$existing" --new-password "$password"

  echo "  done: $username"
}

upsert_user "tester-admin"       "Tester" "Admin"       "Admin123!"       "admin"
upsert_user "tester-contributor" "Tester" "Contributor" "Contributor123!" "contributor"
upsert_user "tester-viewer"      "Tester" "Viewer"      "Viewer123!"      "viewer"

echo ""
echo "=== Done. Three test users provisioned in realm '$REALM'. ==="
echo ""
echo "Next steps:"
echo "  1. Sign in once as each (so auth-sync creates local user rows)."
echo "  2. Recapture the golden state: sudo bash infra/snapshot-golden.sh"
echo "  3. Verify tester-admin is NOT is_protected:"
echo "     docker exec gratis-gis-prod-postgres psql -U gratisgis -d gratisgis \\"
echo "       -c \"SELECT username, org_role, is_protected FROM \\\"user\\\";\""
