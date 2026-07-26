#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# One-shot deploy of the gratisgis.org production stack. Idempotent:
# safe to re-run after every git pull. Run from the repo root on the
# deploy host.
#
#   ./infra/deploy.sh
#
# What it does:
#   1. Sanity-checks that infra/.env.prod exists.
#   2. Builds the portal-api + portal-web images from source.
#   3. Rolls the stack with `docker compose up -d`. Containers whose
#      image / config didn't change keep running.
#   4. Tails recent logs so you can see whether the boot was clean.
#
# Migrations: the portal-api container's entrypoint runs `prisma
# migrate deploy` on every start, so a normal `up -d` is enough to
# apply pending schema changes. There's no separate migrate step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Single-runner mutex (#72).  Two concurrent invocations of this
# script race over docker buildx + `docker compose up`, and the
# second one can kill the first's containers mid-bootup.  Hold an
# flock on a file in /var/lock; if another deploy is already
# running, exit cleanly rather than racing.  Adjust the flock path
# only if /var/lock is missing (some minimal images).
#
# This is the SHARED stack-mutation lock: snapshot-golden.sh and
# restore-golden.sh take the same flock, and the gg-reset-demo
# systemd unit checks it via ExecCondition, so a deploy, a snapshot,
# a restore, and the nightly reset can never run over each other.
# Override with GRATISGIS_LOCK_FILE in every script together or not
# at all; a per-script override would re-split the mutex.
LOCK_FILE="${GRATISGIS_LOCK_FILE:-/var/lock/gratisgis-deploy.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another deploy is in progress (lock=$LOCK_FILE)." >&2
  echo "Tail /tmp/deploy.log if you started one in the background, or wait for it to finish before re-running." >&2
  exit 1
fi
# The lock auto-releases when fd 9 closes (process exit).

if [[ ! -f infra/.env.prod ]]; then
  echo "FATAL: infra/.env.prod is missing." >&2
  echo "Copy infra/.env.prod.example to infra/.env.prod and fill in real values." >&2
  exit 1
fi

# Fast-forward to origin/main before building. Without this, deploy.sh
# happily rebuilds whatever stale checkout already lives at REPO_ROOT,
# which is exactly what bit us on 2026-05-09: ada310c was on origin
# but prod was still at eddcaf2, so the new admin-users overflow fix
# never landed in the rebuilt portal-web image and the user reported
# "I logged out, hard refresh, still no changes." Resetting hard to
# origin/main is safe here because the deploy host has no real local
# work; .env.prod and any state are outside the worktree.
echo "=== Syncing repo to origin/main ==="
git fetch --quiet origin
git reset --hard origin/main
git log --oneline -1

# All the GENERATE placeholders have to be replaced before deploy or
# Keycloak / Postgres / NextAuth will refuse to start.
if grep -q '^[A-Z_]*=GENERATE$' infra/.env.prod; then
  echo "FATAL: infra/.env.prod still contains GENERATE placeholders:" >&2
  grep '^[A-Z_]*=GENERATE$' infra/.env.prod >&2
  echo "Run: openssl rand -base64 36   to generate strong values for each." >&2
  exit 1
fi

# Materialize the Keycloak realm import file from the template by
# substituting env vars. envsubst only replaces $VAR / ${VAR} forms,
# leaving JSON braces alone. Run it before bringing keycloak up so
# the import directory is ready when the container starts.
echo "=== Materializing Keycloak realm import ==="
mkdir -p infra/keycloak/import
# shellcheck disable=SC1091
set -a
. infra/.env.prod
# Derived AUTH_URL the realm template uses for the realm-level
# frontendUrl. Keep this separate from PUBLIC_URL: the realm has to
# advertise itself as the AUTH subdomain (otherwise discovery
# returns the wrong issuer and OAuth breaks).
export AUTH_URL="https://${AUTH_DOMAIN:-auth.gratisgis.org}"
set +a
envsubst < infra/keycloak/realm-gratis-gis.prod.json.tmpl \
  > infra/keycloak/import/realm-gratis-gis.json
# The materialized file carries real secrets (client secrets, the
# bootstrap admin password), so strip world read. Not 600: the
# keycloak container runs as uid 1000 with gid 0 and reads this
# through the bind mount, so the group-read bit for root's gid 0 is
# what keeps --import-realm working on a fresh install while other
# host users still get nothing.
chmod 640 infra/keycloak/import/realm-gratis-gis.json
# Sanity-check: the JSON should still parse after substitution.
python3 -c "import json,sys; json.load(open('infra/keycloak/import/realm-gratis-gis.json'))" \
  || { echo "FATAL: realm import JSON is malformed after envsubst" >&2; exit 1; }
echo "Wrote infra/keycloak/import/realm-gratis-gis.json"

COMPOSE=(docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod)

echo "=== Building images ==="
"${COMPOSE[@]}" build

echo "=== Bringing up stack ==="
"${COMPOSE[@]}" up -d

echo "=== Status ==="
"${COMPOSE[@]}" ps

# -----------------------------------------------------------
# Idempotent post-deploy Keycloak reconciliation.
#
# The realm JSON's --import-realm pass is a no-op once the realm
# exists, which means anything added to the realm template AFTER the
# first deploy (e.g. a new OIDC client, a new default-role grant)
# never lands on the live realm. Re-importing would require deleting
# the realm and losing all users + sessions, so we use kcadm.sh
# instead to reconcile a small, fixed set of expectations.
#
# Today this block ensures:
#   1. The qgis-plugin OIDC client exists with its PKCE + redirect
#      settings + org / org_role protocol mappers.
#   2. Every existing realm user holds the `offline_access` role,
#      so the QGIS plugin's refresh-token flow doesn't 400 on its
#      first sign-in.
#   3. The portal-api-admin service account can authenticate against
#      portal-api as an org admin (org / org_role protocol mappers on
#      the client, org + org_role attributes on the service-account
#      user). infra/cleanup-non-admin.mjs depends on this.
#
# All steps are idempotent: re-running deploy.sh is a no-op when
# everything is already in the desired state. Any failure here is a
# warning, not a hard exit, so a transient kcadm hiccup doesn't
# undo a successful container deploy.
# -----------------------------------------------------------

KEYCLOAK_CONTAINER="${KEYCLOAK_CONTAINER:-gratis-gis-prod-keycloak}"

echo
echo "=== Reconciling Keycloak realm (qgis-plugin client + offline_access) ==="

# Wait up to 60s for Keycloak's admin endpoint to be responsive.
# Fresh containers take a few seconds; an already-running container
# returns immediately.
kc_wait() {
  local i
  for i in $(seq 1 30); do
    if docker exec "$KEYCLOAK_CONTAINER" \
        /opt/keycloak/bin/kcadm.sh config credentials \
          --server http://localhost:8080 \
          --realm master \
          --user "$KEYCLOAK_ADMIN" \
          --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! kc_wait; then
  echo "WARN: Keycloak admin endpoint never came up; skipping reconciliation." >&2
  echo "      Re-run deploy.sh once Keycloak is healthy to apply." >&2
else
  KC() { docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

  # --- qgis-plugin client ---
  if KC get clients -r gratis-gis -q clientId=qgis-plugin --fields id \
      2>/dev/null | grep -q '"id"'; then
    echo "qgis-plugin client already present; skipping create."
  else
    echo "Creating qgis-plugin client from realm import JSON..."
    # Pull the qgis-plugin block out of the rendered realm JSON and
    # feed it directly to kcadm. The block already has all the right
    # fields (publicClient, PKCE S256, redirect URIs, org / org_role
    # protocol mappers) so create-from-file matches the template.
    python3 -c '
import json, sys
realm = json.load(open("infra/keycloak/import/realm-gratis-gis.json"))
client = next(
    (c for c in realm.get("clients", []) if c.get("clientId") == "qgis-plugin"),
    None,
)
if client is None:
    sys.exit("realm template is missing the qgis-plugin client")
json.dump(client, sys.stdout)
' > /tmp/gg-qgis-plugin.json
    docker cp /tmp/gg-qgis-plugin.json \
      "$KEYCLOAK_CONTAINER:/tmp/gg-qgis-plugin.json"
    if KC create clients -r gratis-gis -f /tmp/gg-qgis-plugin.json; then
      echo "  qgis-plugin client created."
    else
      echo "WARN: qgis-plugin client create failed; check kcadm output above." >&2
    fi
    rm -f /tmp/gg-qgis-plugin.json
  fi

  # --- offline_access for every realm user ---
  # The QGIS plugin asks for the offline_access scope so its
  # refresh-token survives QGIS restarts. Keycloak gates that on
  # the user holding the offline_access realm role; without it the
  # PKCE code exchange returns "Offline tokens not allowed for the
  # user or client". Grant to everyone; add-roles is idempotent.
  echo "Granting offline_access to every realm user..."
  KC get users -r gratis-gis --fields username --offset 0 --limit 200 \
      2>/dev/null \
    | python3 -c "import sys,json; [print(u['username']) for u in json.load(sys.stdin)]" \
    | while read -r username; do
        if [[ -z "$username" ]]; then continue; fi
        # add-roles errors when the user already has the role; the
        # `|| true` swallows that so the loop stays idempotent.
        KC add-roles -r gratis-gis --uusername "$username" \
            --rolename offline_access >/dev/null 2>&1 \
          && echo "  + $username" \
          || echo "  = $username (already had role)"
      done
  echo "Offline-access reconciliation done."

  # --- portal-api-admin: portal-admin identity for snapshot tooling ---
  # infra/cleanup-non-admin.mjs (the pre-snapshot purge that
  # snapshot-golden.sh runs) authenticates with a client_credentials
  # token from the portal-api-admin service account, because every
  # interactive client ships with directAccessGrantsEnabled=false and
  # a password grant is therefore impossible on a fresh install.
  # portal-api only accepts tokens that carry the org and org_role
  # claims (auth-sync rejects anything else with a 401), and the realm
  # template maps those claims only on the interactive clients. So:
  # ensure org / org_role protocol mappers exist on portal-api-admin,
  # and give the service-account user the org, org_role=admin
  # attributes plus a first / last name (portal-api requires a
  # non-empty name claim to create the local user row).
  #
  # This is not a privilege widening: KEYCLOAK_ADMIN_CLIENT_SECRET
  # already grants manage-users on the realm, which includes
  # password-resetting any user, a superset of portal admin.
  echo "Ensuring portal-api-admin can act as a portal admin (snapshot tooling)..."
  KCI() { docker exec -i "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }
  GG_ADMIN_CID="$(KC get clients -r gratis-gis -q clientId=portal-api-admin --fields id 2>/dev/null \
    | python3 -c 'import sys,json; arr=json.load(sys.stdin); print(arr[0]["id"] if arr else "")' 2>/dev/null || true)"
  if [[ -z "$GG_ADMIN_CID" ]]; then
    echo "WARN: portal-api-admin client not found in realm; skipping mapper reconcile." >&2
  else
    GG_EXISTING_MAPPERS="$(KC get "clients/$GG_ADMIN_CID/protocol-mappers/models" \
      -r gratis-gis --fields name 2>/dev/null || true)"
    for GG_CLAIM in org org_role; do
      if printf '%s' "$GG_EXISTING_MAPPERS" | grep -q "\"name\" *: *\"$GG_CLAIM\""; then
        echo "  mapper $GG_CLAIM already present."
      else
        if printf '{
  "name": "%s",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "consentRequired": false,
  "config": {
    "userinfo.token.claim": "true",
    "user.attribute": "%s",
    "id.token.claim": "true",
    "access.token.claim": "true",
    "claim.name": "%s",
    "jsonType.label": "String"
  }
}' "$GG_CLAIM" "$GG_CLAIM" "$GG_CLAIM" \
            | KCI create "clients/$GG_ADMIN_CID/protocol-mappers/models" \
                -r gratis-gis -f - >/dev/null 2>&1; then
          echo "  + mapper $GG_CLAIM created."
        else
          echo "WARN: could not create $GG_CLAIM mapper on portal-api-admin." >&2
        fi
      fi
    done
    GG_SA_UID="$(KC get "clients/$GG_ADMIN_CID/service-account-user" -r gratis-gis 2>/dev/null \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
    if [[ -z "$GG_SA_UID" ]]; then
      echo "WARN: could not resolve portal-api-admin service-account user; skipping attribute reconcile." >&2
    else
      # One update call on purpose: Keycloak replaces the whole
      # attributes map when the field is present, so setting org and
      # org_role in separate calls would wipe whichever went first.
      if KC update "users/$GG_SA_UID" -r gratis-gis \
          -s 'firstName=Portal' -s 'lastName=Service Account' \
          -s "attributes.org=[\"${DEFAULT_ORG_SLUG:-gratis-gis}\"]" \
          -s 'attributes.org_role=["admin"]' >/dev/null 2>&1; then
        echo "  service-account user attributes reconciled."
      else
        echo "WARN: could not update portal-api-admin service-account attributes." >&2
      fi
    fi
  fi
fi

echo
echo "=== Tail of recent logs (last 30 lines per service) ==="
"${COMPOSE[@]}" logs --tail=30
