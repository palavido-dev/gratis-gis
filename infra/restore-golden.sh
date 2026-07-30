#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Restore the GratisGIS prod stack to the captured golden state.
# Used by the daily public-testing-mode reset cron (#138). Run
# manually for testing; otherwise the systemd timer
# `gg-reset-demo.timer` invokes it at 04:00 UTC daily.
#
# What gets restored:
#   - `gratisgis` Postgres database  (drop + restore from
#     /var/lib/gratis-gis-golden/postgres-app.dump).
#   - `keycloak` Postgres database  (same, from
#     /var/lib/gratis-gis-golden/postgres-keycloak.dump).
#   - `miniodata` Docker volume contents  (wipe + untar from
#     /var/lib/gratis-gis-golden/minio.tar; uncompressed on purpose,
#     see snapshot-golden.sh for why).
#
# What does NOT get restored:
#   - TLS / ACME state (caddy-data, caddy-config). Reset never
#     touches certs; reissuing them takes minutes and rate-limits
#     hit fast.
#   - The /var/lib/gratis-gis-golden/ snapshot itself. It is read-
#     only as far as this script is concerned.
#
# Safety gate: this script REFUSES to run unless
# `PORTAL_PUBLIC_TESTING` is truthy. Without that gate, a stray cron
# trigger on a normal-use deploy would silently destroy real data.
#
# Brief downtime: ~30 - 60 seconds. The script stops app services,
# wipes the live DBs and the live MinIO volume, restores from the
# snapshot, and restarts services. Caddy stays up the entire time,
# so users see a brief 502 (which Caddy returns as its own polite
# error page) rather than a connection error.
set -euo pipefail

GOLDEN_DIR="/var/lib/gratis-gis-golden"
COMPOSE_PROJECT="gratis-gis-prod"
COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.prod.yml"
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.prod"
LOG_FILE="/var/log/gg-reset-demo.log"

# Mirror stdout + stderr into a rolling log; systemd-journal also
# captures the unit's output, but the file is the durable record
# the operator can `tail -F` when triaging a failed reset.
exec > >(tee -a "$LOG_FILE") 2>&1
echo ""
echo "=== Reset run at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

if [[ $EUID -ne 0 ]]; then
  echo "FATAL: restore-golden.sh must run as root (docker + volume access)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing." >&2
  exit 1
fi

# Mutex with snapshot-golden.sh AND deploy.sh. When the 04:00 UTC
# systemd timer fires while an operator is part-way through a manual
# snapshot, the restore reads the half-written postgres-app.dump,
# errors after the DROP DATABASE, and leaves the live stack with an
# empty `gratisgis` schema; when it fires mid-deploy, the two fight
# over stopping and starting the same containers. Better to skip
# this run (the next tick is 24h out; nobody dies) than to race.
# Same lock file deploy.sh holds for its whole run and the
# gg-reset-demo systemd unit checks via ExecCondition; override
# GRATISGIS_LOCK_FILE in every script together or not at all.
LOCK_FILE="${GRATISGIS_LOCK_FILE:-/var/lock/gratisgis-deploy.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "WARN: another golden-state operation is in progress (lock=$LOCK_FILE)." >&2
  echo "      Skipping this reset run. Will retry on the next tick." >&2
  exit 0
fi
# Lock auto-releases on fd 9 close (process exit).

# Parsed, not sourced: bash expands values on the way in, which is
# how a bcrypt STATS_HASH once became a PID and took Caddy down.
# shellcheck source=infra/lib-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-env.sh"
gg_load_env_file "$ENV_FILE"

# Safety gate. The check is intentionally permissive (any truthy
# string) so an operator can pass it ad hoc on the command line
# during testing. The systemd unit sets it explicitly via
# Environment= so the timer doesn't need the env file to carry it.
TESTING_FLAG="${PORTAL_PUBLIC_TESTING:-}"
case "${TESTING_FLAG,,}" in
  1|true|yes|on)
    ;;
  *)
    echo "FATAL: PORTAL_PUBLIC_TESTING is not set in the env." >&2
    echo "       Refusing to wipe the live stack on a non-testing deploy." >&2
    exit 1
    ;;
esac

# Confirm snapshot artifacts exist before doing anything destructive.
# Bailing here is the operator-friendly mode: the live stack stays
# up, and the operator gets a clear error pointing at the missing
# file. If we deleted the live DB first and THEN noticed the snapshot
# was incomplete, we'd be in a much worse spot.
for f in postgres-app.dump postgres-keycloak.dump minio.tar; do
  if [[ ! -s "$GOLDEN_DIR/$f" ]]; then
    echo "FATAL: snapshot artifact missing or empty: $GOLDEN_DIR/$f" >&2
    echo "       Run infra/snapshot-golden.sh first to seed the golden state." >&2
    exit 1
  fi
done

POSTGRES_USER="${POSTGRES_USER:-gratisgis}"
POSTGRES_DB_APP="${POSTGRES_DB:-gratisgis}"
KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

dc() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Postgres + DB role for the keycloak DB owner. Init-prod-db.sh
# (run on first postgres-container boot) creates a separate
# `keycloak` role; that role survives the DB drop because it's a
# server-level role, not a per-DB object. Same for the `gratisgis`
# role.
KEYCLOAK_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"

# Deep-verify every artifact BEFORE the first destructive statement.
# The -s existence loop above catches a missing file; these catch a
# truncated or corrupt one. pg_restore --list parses the custom-
# format archive's table of contents end to end, and tar -tf walks
# the whole tar. snapshot-golden.sh verifies the same way before it
# publishes an artifact, so a failure here means on-disk corruption
# after the fact, and wiping the live stack on top of that would be
# unrecoverable. The stack is still fully up while this runs.
echo "=== Verifying snapshot artifacts before touching the live stack ==="
PG_CONTAINER="$(dc ps -q postgres | head -n 1)"
if [[ -z "$PG_CONTAINER" ]]; then
  echo "FATAL: postgres container not running; cannot verify or restore." >&2
  exit 1
fi
# Plain docker exec with stdin from the file on purpose; compose's
# exec wrapper hangs on stdio (see the pg_restore notes below).
docker exec -i "$PG_CONTAINER" pg_restore --list \
    < "$GOLDEN_DIR/postgres-app.dump" > /dev/null \
  || { echo "FATAL: postgres-app.dump failed pg_restore --list verification; refusing to restore." >&2; exit 1; }
docker exec -i "$PG_CONTAINER" pg_restore --list \
    < "$GOLDEN_DIR/postgres-keycloak.dump" > /dev/null \
  || { echo "FATAL: postgres-keycloak.dump failed pg_restore --list verification; refusing to restore." >&2; exit 1; }
tar -tf "$GOLDEN_DIR/minio.tar" > /dev/null \
  || { echo "FATAL: minio.tar failed tar -tf verification; refusing to restore." >&2; exit 1; }
echo "All artifacts verified."

drop_and_restore() {
  local db="$1"
  local owner="$2"
  local dump="$3"

  echo "--- Restoring database: $db (owner=$owner) ---"

  # Disconnect any active sessions so DROP DATABASE doesn't block.
  # ALTER DATABASE ... CONNECTION LIMIT 0 prevents new connections
  # from forming during this; pg_terminate_backend kills any
  # already-open ones.
  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U gratisgis -d postgres -c "ALTER DATABASE \"$db\" CONNECTION LIMIT 0;" \
    || true
  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U gratisgis -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" \
    || true

  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U gratisgis -d postgres -c "DROP DATABASE IF EXISTS \"$db\";"
  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U gratisgis -d postgres -c "CREATE DATABASE \"$db\" OWNER \"$owner\";"

  # Restore the dump.  Two non-obvious choices:
  #
  #   1. Copy the dump into the postgres container first, then run
  #      pg_restore against the local file inside the container.
  #      The naive `cat "$dump" | dc exec -T postgres pg_restore`
  #      pipeline hangs after pg_restore exits because compose
  #      wraps stdio in a way that waits indefinitely for both
  #      sides to close cleanly.  `docker cp` + in-container path
  #      sidesteps that entirely and is faster on a fat dump
  #      (no pipe, no docker-stdio overhead).
  #
  #   2. `docker exec` straight against the container name, not
  #      `docker compose exec`.  Same hang reason as (1); compose's
  #      exec wrapper is the slow path.
  #
  # --no-owner + --role lets the restore re-grant objects to the
  # correct owner regardless of who they were owned by at dump
  # time.  --jobs=4 parallelizes index + constraint rebuild after
  # the data load; harmless on a single-CPU box (jobs serialize).
  local pg_container
  pg_container="$(dc ps -q postgres)"
  local in_container="/tmp/restore-$db.dump"
  docker cp "$dump" "${pg_container}:${in_container}"
  # `< /dev/null` on the docker exec call is load-bearing.  Without
  # it the wrapper hangs after pg_restore exits, blocking the rest
  # of the script for several minutes per DB.  Observed:
  # pg_restore completes inside the container, the inner workers
  # all exit, but docker exec stays alive waiting on a stdin pipe
  # that the script never wrote to.  Explicitly null'ing stdin
  # gives the wrapper a clean EOF to return on.
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$pg_container" \
    pg_restore -U gratisgis -d "$db" --no-owner --role="$owner" \
    --clean --if-exists --jobs=4 "$in_container" < /dev/null
  docker exec "$pg_container" rm -f "$in_container" < /dev/null || true
}

echo "=== Stopping app services ==="
# pointcloud-worker writes postgres + minio mid-job and pg_tileserv
# holds read connections; both must be down while the databases are
# dropped and the volume is swapped (mirrors snapshot-golden.sh).
dc stop portal-api portal-worker pointcloud-worker portal-web keycloak pg_tileserv

echo "=== Restoring Postgres databases ==="
drop_and_restore "$POSTGRES_DB_APP" "$POSTGRES_USER" "$GOLDEN_DIR/postgres-app.dump"
drop_and_restore "$KEYCLOAK_DB_NAME" "$KEYCLOAK_DB_USER" "$GOLDEN_DIR/postgres-keycloak.dump"

echo "=== Restoring MinIO volume ==="
# Stop minio so nothing writes the volume while we swap its contents.
dc stop minio
docker run --rm \
  -v "${COMPOSE_PROJECT}_miniodata":/data \
  -v "$GOLDEN_DIR":/in:ro \
  alpine:3.20 \
  sh -c 'rm -rf /data/..?* /data/.[!.]* /data/* && tar xf /in/minio.tar -C /data'
dc start minio

echo "=== Restarting app services ==="
# Give minio + postgres a couple of seconds to settle before app
# services start hitting them.
sleep 3
dc start keycloak pg_tileserv
sleep 5  # Keycloak boot is slower than postgres / minio.
dc start portal-web portal-worker pointcloud-worker portal-api

# -----------------------------------------------------------
# Post-restore Keycloak reconciliation.
#
# The restored Keycloak DB is a point-in-time snapshot. Anything
# added to the realm AFTER the snapshot was taken (a new OIDC
# client, a role grant on the tester users) gets wiped on restore.
# Re-running the same idempotent kcadm reconciliation deploy.sh
# uses keeps the realm in the desired shape every night.
#
# Today this guarantees:
#   1. The qgis-plugin OIDC client exists (PKCE, redirect URIs,
#      org / org_role protocol mappers).
#   2. Every restored realm user holds offline_access, so the
#      QGIS plugin's PKCE flow doesn't 400 with "Offline tokens
#      not allowed for the user or client" on first sign-in.
#   3. The portal-api-admin service account keeps its portal-admin
#      identity (org / org_role mappers + attributes), which the
#      pre-snapshot cleanup in snapshot-golden.sh depends on.
#
# Fail open: a kcadm hiccup logs WARN but doesn't abort restore.
# -----------------------------------------------------------

KEYCLOAK_CONTAINER="${KEYCLOAK_CONTAINER:-gratis-gis-prod-keycloak}"

echo "=== Reconciling Keycloak realm (qgis-plugin client + offline_access) ==="

# Wait up to 60s for Keycloak's admin endpoint to be responsive
# after the restart above.
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
  echo "WARN: Keycloak admin endpoint never came up post-restore; skipping reconciliation." >&2
else
  KC() { docker exec "$KEYCLOAK_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

  # --- qgis-plugin client ---
  if KC get clients -r gratis-gis -q clientId=qgis-plugin --fields id \
      2>/dev/null | grep -q '"id"'; then
    echo "qgis-plugin client already present; skipping create."
  else
    echo "Creating qgis-plugin client from realm template..."
    # Pull the block from the rendered realm template the deploy
    # path materialized. If that file is missing (a restore on a
    # host that never ran deploy.sh) fall back to the in-repo JSON.
    SRC_REALM="/opt/gratis-gis/infra/keycloak/import/realm-gratis-gis.json"
    if [[ ! -f "$SRC_REALM" ]]; then
      SRC_REALM="/opt/gratis-gis/infra/keycloak/realm-gratis-gis.json"
    fi
    python3 -c "
import json, sys
realm = json.load(open('$SRC_REALM'))
client = next(
    (c for c in realm.get('clients', []) if c.get('clientId') == 'qgis-plugin'),
    None,
)
if client is None:
    sys.exit('realm template is missing the qgis-plugin client')
json.dump(client, sys.stdout)
" > /tmp/gg-qgis-plugin.json
    docker cp /tmp/gg-qgis-plugin.json \
      "$KEYCLOAK_CONTAINER:/tmp/gg-qgis-plugin.json"
    if KC create clients -r gratis-gis -f /tmp/gg-qgis-plugin.json; then
      echo "  qgis-plugin client created."
    else
      echo "WARN: qgis-plugin client create failed; check kcadm output above." >&2
    fi
    rm -f /tmp/gg-qgis-plugin.json
  fi

  # --- offline_access for every restored realm user ---
  echo "Granting offline_access to every realm user..."
  KC get users -r gratis-gis --fields username --offset 0 --limit 200 \
      2>/dev/null \
    | python3 -c "import sys,json; [print(u['username']) for u in json.load(sys.stdin)]" \
    | while read -r username; do
        if [[ -z "$username" ]]; then continue; fi
        KC add-roles -r gratis-gis --uusername "$username" \
            --rolename offline_access >/dev/null 2>&1 \
          && echo "  + $username" \
          || echo "  = $username (already had role)"
      done

  # --- portal-api-admin: portal-admin identity for snapshot tooling ---
  # Mirrors the same block in deploy.sh (see the rationale there).
  # The golden snapshot normally already contains this state, but a
  # restore from a pre-fix snapshot, or a realm re-import, would
  # silently drop it and the next snapshot's cleanup pass would fail
  # closed. Idempotent; converges in one pass.
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

# Hand the sample workspace to the tester accounts. This runs after
# the restore, not before the snapshot, and that asymmetry is
# deliberate: snapshot-golden.sh purges every item not owned by the
# bootstrap admin, so the golden dump is and must stay 100%
# admin-owned. Applying the split here means a tester still lands on
# owned and shared content, and the purge keeps working as the guard
# against visitor pollution.
#
# Non-fatal on purpose. A reset that restored cleanly but could not
# reassign ownership has left a working demo with buried content,
# which is worth a warning rather than a failed unit.
echo "=== Seeding demo tester workspace ==="
# Re-resolve the container id rather than reusing the one captured
# before the restore: the restore path stops and starts services, and
# a recreated postgres container would leave the old id stale.
GG_SEED_PG="$(dc ps -q postgres 2>/dev/null | head -n 1)"
if [[ -z "$GG_SEED_PG" ]]; then
  echo "WARN: postgres container not resolvable; skipping tester workspace seeding." >&2
elif [[ -x "$INFRA_DIR/seed-demo-workspace.sh" ]]; then
  PG_CONTAINER="$GG_SEED_PG" PG_USER="$POSTGRES_USER" PG_DB="$POSTGRES_DB_APP" \
    ADMIN_USERNAME="$ADMIN_USERNAME" \
    "$INFRA_DIR/seed-demo-workspace.sh" \
    || echo "WARN: tester workspace seeding failed; demo content stays admin-owned." >&2
else
  echo "WARN: $INFRA_DIR/seed-demo-workspace.sh not found or not executable; skipping." >&2
fi

echo "=== Reset complete at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""
