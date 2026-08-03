#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Capture a "golden state" snapshot of the running GratisGIS prod
# stack. Used to seed the daily reset for the public test instance
# (#138). Run this ONCE, after setting up the demo content the way
# testers should always land in: e.g. WV parcels imported, a couple
# of example maps and dashboards created, the three test users
# provisioned, no garbage.
#
# What gets captured:
#   - The `gratisgis` Postgres database  (items, users, observations,
#     shares, folders, etc).
#   - The `keycloak` Postgres database  (realm config, the three
#     test users, password hashes, client secrets).
#   - The `miniodata` Docker volume  (feature attachments, avatars,
#     basemap thumbnails, item thumbnails, exports).
#
# What does NOT get captured:
#   - `caddy-data`, `caddy-config` (TLS certs, ACME state). Reset is
#     not allowed to interrupt those.
#   - `gg-staging`, `portal-api-backups` (ephemeral; recreated on
#     next use).
#   - Container images, env files.
#
# Brief downtime: dependent services are stopped during capture to
# guarantee Postgres + MinIO are consistent with each other. Plan on
# 30 - 60 seconds.
#
# Usage:
#   sudo ./infra/snapshot-golden.sh
#
# Artifacts land in /var/lib/gratis-gis-golden/. The restore script
# reads from the same path.
set -euo pipefail

GOLDEN_DIR="/var/lib/gratis-gis-golden"
COMPOSE_PROJECT="gratis-gis-prod"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.prod.yml"
ENV_FILE="$INFRA_DIR/.env.prod"

if [[ $EUID -ne 0 ]]; then
  echo "FATAL: snapshot-golden.sh must run as root (needs docker volume access)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing. Snapshot needs the prod env to know DB credentials." >&2
  exit 1
fi

# Mutex with restore-golden.sh AND deploy.sh. All three mutate the
# running stack; running any two concurrently (e.g. a manual
# snapshot during the 04:00 UTC reset window, or a deploy rolling
# containers mid-dump) corrupts the dumps half-mid-write AND can
# leave the live postgres database in a dropped + empty state
# because restore-golden.sh's pg_restore reads the in-progress dump
# and errors out after the DROP. Fail fast rather than racing.
# The lock file is the same one deploy.sh holds for its whole run
# and the gg-reset-demo systemd unit checks via ExecCondition;
# override GRATISGIS_LOCK_FILE in every script together or not at
# all.
LOCK_FILE="${GRATISGIS_LOCK_FILE:-/var/lock/gratisgis-deploy.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "FATAL: another golden-state operation is in progress (lock=$LOCK_FILE)." >&2
  echo "       Check pgrep -af 'snapshot-golden|restore-golden' or" >&2
  echo "       tail /var/log/gg-reset-demo.log to find it." >&2
  exit 1
fi
# The lock auto-releases when fd 9 closes (process exit).

# Parsed, not sourced: bash expands values on the way in, which is
# how a bcrypt STATS_HASH once became a PID and took Caddy down.
# shellcheck source=infra/lib-env.sh
source "$INFRA_DIR/lib-env.sh"
gg_load_env_file "$ENV_FILE"

POSTGRES_USER="${POSTGRES_USER:-gratisgis}"
POSTGRES_DB_APP="${POSTGRES_DB:-gratisgis}"
KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

mkdir -p "$GOLDEN_DIR"
chmod 700 "$GOLDEN_DIR"

dc() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Pre-snapshot cleanup. The public demo accounts (tester-admin /
# tester-contributor / tester-viewer) sit behind the gratisgis.org
# landing banner so anyone can sign in as them; whatever they
# create between snapshots would otherwise get baked into the
# golden state and survive every nightly reset forever. Purge any
# item not owned by the bootstrap admin before pg_dump captures
# the DB.
#
# Runs via the portal-api container so item teardown routes through
# the normal ItemsService.purge path (drops per-layer feature
# tables, removes MinIO blobs, cleans observation partitions).
# SQL-only deletion would leave those as orphans in the MinIO
# tarball and bloat every future snapshot by 50-100MB of dead
# bytes.
#
# Failure mode: if the service-account token can't be obtained
# (Keycloak down, KEYCLOAK_ADMIN_CLIENT_SECRET rotated) or the
# portal-api rejects it, the script fails closed and aborts the
# snapshot. Without an authenticated item list we can't tell what
# to purge, and silently snapshotting a polluted DB is worse than
# refusing to snapshot at all.
#
# Auth: the script authenticates with a client_credentials token
# from the portal-api-admin service account; the credentials are
# already in the portal-api container's environment
# (KEYCLOAK_ADMIN_CLIENT_ID / KEYCLOAK_ADMIN_CLIENT_SECRET), so
# docker exec inherits them and nothing secret crosses the host
# command line. deploy.sh's Keycloak reconciliation is what grants
# that service account a portal-admin identity; if this step fails
# with a claims error, run infra/deploy.sh once and retry.
# Hand the demo tester workspace back before the purge runs. The
# nightly reset gives the sample set to tester-admin and
# tester-contributor so a tester sees owned content on first sign-in
# (infra/seed-demo-workspace.sh); the purge below deletes every item
# not owned by the bootstrap admin. Snapshotting without this revert
# does not capture a tester-owned workspace, it captures no sample
# workspace at all, because the purge hard-deletes all seventeen
# items along with their feature tables and MinIO blobs. That has
# happened once; the revert is what stops it happening again.
#
# Ordering matters: revert (SQL, postgres is still up) -> purge ->
# stop services -> dump. restore-golden.sh re-applies the split at
# the end of every reset.
echo "=== Reverting demo tester workspace before purge ==="
GG_SNAP_PG="$(dc ps -q postgres 2>/dev/null | head -n 1)"
if [[ -z "$GG_SNAP_PG" ]]; then
  echo "FATAL: postgres container not running; cannot revert the tester workspace." >&2
  exit 1
fi
PG_CONTAINER="$GG_SNAP_PG" PG_USER="$POSTGRES_USER" PG_DB="$POSTGRES_DB_APP" \
  ADMIN_USERNAME="$ADMIN_USERNAME" \
  "$INFRA_DIR/seed-demo-workspace.sh" --revert

echo "=== Pre-snapshot purge of non-admin items ==="
PORTAL_API_CONTAINER="$(dc ps -q portal-api 2>/dev/null | head -n 1)"
if [[ -z "$PORTAL_API_CONTAINER" ]]; then
  echo "FATAL: portal-api container not running; cannot purge non-admin items before snapshot." >&2
  exit 1
fi
docker cp "$INFRA_DIR/cleanup-non-admin.mjs" \
  "${PORTAL_API_CONTAINER}:/tmp/cleanup-non-admin.mjs"
docker exec \
  -e ADMIN_USERNAME="$ADMIN_USERNAME" \
  "$PORTAL_API_CONTAINER" \
  node /tmp/cleanup-non-admin.mjs
# Cleanup the staged script. `docker cp` plants the file as root,
# but the container's default user is `app` (uid 999), so a plain
# `docker exec ... rm` fails with EPERM. Use -u 0 to remove as root.
# `|| true` belt-and-suspenders in case the container is somehow
# already gone -- a leftover /tmp file is harmless, an aborted
# snapshot isn't.
docker exec -u 0 "$PORTAL_API_CONTAINER" \
  rm -f /tmp/cleanup-non-admin.mjs || true

# Every artifact is written to a .tmp path first, verified, and only
# then moved over the previous generation. A crash or a truncated
# write therefore can never replace a good golden set with a corrupt
# one; the nightly restore keeps reading the last complete set. The
# EXIT trap below removes leftover .tmp files and, if the script
# dies after services were stopped, restarts them so a failed 2am
# snapshot doesn't leave the demo down until morning.
APP_DUMP_TMP="$GOLDEN_DIR/postgres-app.dump.tmp"
KC_DUMP_TMP="$GOLDEN_DIR/postgres-keycloak.dump.tmp"
MINIO_TAR_TMP="$GOLDEN_DIR/minio.tar.tmp"
GG_SERVICES_STOPPED=0
cleanup_on_exit() {
  local rc=$?
  rm -f "$APP_DUMP_TMP" "$KC_DUMP_TMP" "$MINIO_TAR_TMP"
  if [[ $rc -ne 0 && "$GG_SERVICES_STOPPED" == 1 ]]; then
    echo "WARN: snapshot failed (rc=$rc); restarting stopped services." >&2
    dc start minio || true
    sleep 3
    dc start keycloak pg_tileserv portal-web portal-worker pointcloud-worker portal-api || true
  fi
  exit "$rc"
}
trap cleanup_on_exit EXIT

echo "=== Stopping app services for consistent snapshot ==="
# Stop in dependency order; postgres stays up so we can pg_dump.
# pointcloud-worker writes both postgres and minio mid-job, and
# pg_tileserv holds read connections; stop both so the dumps and
# the volume tar are one consistent point in time.
GG_SERVICES_STOPPED=1
dc stop portal-api portal-worker pointcloud-worker portal-web keycloak pg_tileserv

PG_CONTAINER="$(dc ps -q postgres | head -n 1)"
if [[ -z "$PG_CONTAINER" ]]; then
  echo "FATAL: postgres container not running; cannot dump." >&2
  exit 1
fi

echo "=== Dumping Postgres: $POSTGRES_DB_APP ==="
dc exec -T postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB_APP" \
  -F c -Z 6 \
  > "$APP_DUMP_TMP"

echo "=== Dumping Postgres: $KEYCLOAK_DB_NAME ==="
dc exec -T postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$KEYCLOAK_DB_NAME" \
  -F c -Z 6 \
  > "$KC_DUMP_TMP"

echo "=== Snapshotting MinIO volume ==="
# Run a throwaway alpine container with both the minio volume and
# the golden dir mounted; tar the volume contents out. Faster +
# more reliable than docker cp for a directory tree of arbitrary
# size, and atomic from the file-system layer's point of view
# because nothing is writing the volume while minio is stopped.
# Actually MinIO is still up here (it's needed for /api/portal
# attachment serves to work even when api is stopped during a
# write, and stopping it briefly while the app services are also
# stopped is fine). Stop minio too:
dc stop minio
# Uncompressed tar on purpose. The MinIO volume is dominated by
# already-compressed point-cloud data (COPC / LAZ) and raster tiles;
# gzip buys ~0 size but costs ~40 min of single-core CPU on a ~30GB
# volume, and restore-golden pays that same cost on every nightly
# reset (a 40-min demo outage). Plain tar keeps both the snapshot and
# the nightly restore disk-bound (a few minutes). The golden lives on
# the 200GB volume so the larger uncompressed archive is not a space
# concern. restore-golden.sh's `tar xf` must stay in sync with this.
docker run --rm \
  -v "${COMPOSE_PROJECT}_miniodata":/data:ro \
  -v "$GOLDEN_DIR":/out \
  alpine:3.20 \
  tar cf /out/minio.tar.tmp -C /data .

echo "=== Verifying snapshot artifacts ==="
# pg_restore --list parses the archive's table of contents, which is
# the real integrity check for a custom-format dump (a truncated or
# garbage file fails it). It reads the archive from stdin; plain
# docker exec on purpose, compose's exec wrapper hangs on stdio (see
# restore-golden.sh for the war story).
docker exec -i "$PG_CONTAINER" pg_restore --list < "$APP_DUMP_TMP" > /dev/null \
  || { echo "FATAL: app dump failed pg_restore --list verification." >&2; exit 1; }
docker exec -i "$PG_CONTAINER" pg_restore --list < "$KC_DUMP_TMP" > /dev/null \
  || { echo "FATAL: keycloak dump failed pg_restore --list verification." >&2; exit 1; }
# tar -tf walks the whole archive; a truncated tar fails partway.
tar -tf "$MINIO_TAR_TMP" > /dev/null \
  || { echo "FATAL: minio tar failed tar -tf verification." >&2; exit 1; }

# All three verified: move them into place together so the golden
# set is always same-generation. mv within one directory is atomic
# on the filesystem level; the restore script can never observe a
# half-written file.
mv -f "$APP_DUMP_TMP" "$GOLDEN_DIR/postgres-app.dump"
mv -f "$KC_DUMP_TMP" "$GOLDEN_DIR/postgres-keycloak.dump"
mv -f "$MINIO_TAR_TMP" "$GOLDEN_DIR/minio.tar"

echo "=== Restarting app services ==="
dc start minio
# Wait a beat for minio to be ready before app services start hitting it.
sleep 3
dc start keycloak pg_tileserv portal-web portal-worker pointcloud-worker portal-api
GG_SERVICES_STOPPED=0

# Re-apply the demo tester workspace on the LIVE db now that the
# dump is done. Without this, a manual snapshot leaves the demo
# de-stratified (everything Site Admin, testers owning nothing)
# until the next nightly reset re-applies it, which reads as data
# loss to anyone who looks in that window. The golden artifacts on
# disk stay admin-owned either way; this only restores what
# visitors see between now and the next reset. Best effort: a
# failure here means "demo looks bare until 04:00", not a bad
# snapshot.
echo "=== Re-applying demo tester workspace (live db) ==="
PG_CONTAINER="$GG_SNAP_PG" PG_USER="$POSTGRES_USER" PG_DB="$POSTGRES_DB_APP" \
  ADMIN_USERNAME="$ADMIN_USERNAME" \
  "$INFRA_DIR/seed-demo-workspace.sh" \
  || echo "WARN: tester workspace re-apply failed; demo stays admin-owned until the nightly reset." >&2

echo "=== Snapshot complete ==="
ls -lh "$GOLDEN_DIR"
echo ""
echo "Restore reads from $GOLDEN_DIR. Test it once before relying"
echo "on the cron, with:"
echo "    sudo PORTAL_PUBLIC_TESTING=1 $(dirname "${BASH_SOURCE[0]}")/restore-golden.sh"
