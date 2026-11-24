#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Restore the whole database cluster (portal and Keycloak) from the
# pgBackRest repository. This REPLACES the database on this server.
#
#   infra/pitr-restore.sh --confirm-project gratis-gis-prod --latest
#   infra/pitr-restore.sh --confirm-project gratis-gis-prod \
#       --time '2026-11-24 14:05:00+00'
#
# Options:
#   --latest          replay every archived WAL file (after losing the
#                     server or the data volume)
#   --time T          stop at time T; T needs a zone, e.g. +00.
#                     By default the database then PAUSES at T in
#                     read-only mode for inspection. Open it for writes
#                     with: SELECT pg_wal_replay_resume();
#   --promote         with --time: open for writes at T without pausing
#                     (owner decision 2026-11-23: pause is the default)
#   --new-server      this server has no running database to protect
#   --drill           throwaway server: do not archive the restored
#                     database into the real repository, no typed
#                     confirmation
#   --set LABEL       start from this backup set (pgbackrest info)
#   --accept-unarchived  go on even if WAL from the running database
#                     could not be sent first
#
# Step by step, with checks after: docs/cloud/restore-runbook.md.
set -euo pipefail

# shellcheck source=infra/pitr/common.sh
. "$(cd "$(dirname "$0")" && pwd)/pitr/common.sh"

CONFIRM="" MODE="" TARGET="" PROMOTE=0 NEW_SERVER=0 DRILL=0 SET="" ACCEPT_UNARCHIVED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="${2:-}"; shift 2 ;;
    --latest) MODE="latest"; shift ;;
    --time) MODE="time"; TARGET="${2:-}"; shift 2 ;;
    --promote) PROMOTE=1; shift ;;
    --pause) echo "pitr-restore: pausing is the default now; --pause is not needed." >&2; shift ;;
    --new-server) NEW_SERVER=1; shift ;;
    --drill) DRILL=1; NEW_SERVER=1; shift ;;
    --set) SET="${2:-}"; shift 2 ;;
    --accept-unarchived) ACCEPT_UNARCHIVED=1; shift ;;
    -h|--help) sed -n '4,30p' "$0"; exit 0 ;;
    *) echo "pitr-restore: unknown argument $1" >&2; exit 1 ;;
  esac
done
pitr_require_project "$CONFIRM"
cd "$PITR_ROOT"

if [[ -z "$MODE" ]]; then
  echo "pitr-restore: choose --latest or --time 'YYYY-MM-DD HH:MM:SS+00'." >&2
  exit 1
fi
if [[ "$MODE" == time ]]; then
  if ! problem="$(pitr_target_problem "$TARGET" "$(date -u +%s)" 14)"; then
    echo "pitr-restore: $problem" >&2
    exit 1
  fi
elif [[ "$PROMOTE" -eq 1 ]]; then
  echo "pitr-restore: --promote only applies to --time. --latest always opens at the end of the WAL." >&2
  exit 1
fi
if ! problems="$(pitr_env_problems "$PITR_ENV_FILE")"; then
  echo "pitr-restore: fix infra/.env.pitr first:" >&2
  printf '  %s\n' "$problems" >&2
  exit 1
fi

label="LATEST"
[[ "$MODE" == time ]] && label="$TARGET"

cat <<EOF

######################################################################
#  DATABASE RESTORE: $label
#
#  This stops the whole GratisGIS stack on this server and REPLACES
#  the database (portal and Keycloak) with the copy from the backup
#  repository$( [[ "$MODE" == time ]] && printf '\n#  as it was at %s.' "$TARGET")
#
#  - Everything written after that moment is not in the restored
#    database. It stays in the repository on the old timeline for
#    14 days, so this can be undone by restoring again with --latest
#    and --set/--target-timeline (see the runbook).
#  - A restore to a time PAUSES at the target, read-only, so you can
#    check it before anything writes (--promote skips this).
#  - Files in object storage are NOT rolled back. Follow the
#    missing-objects step in docs/cloud/restore-runbook.md after.
#  - If another server still runs this database, stop it first, or
#    both will write WAL into the same repository.
######################################################################

EOF

if [[ "$DRILL" -eq 0 ]]; then
  read -r -p "Type exactly 'RESTORE $label' to go on: " ans
  if [[ "$ans" != "RESTORE $label" ]]; then
    echo "pitr-restore: not confirmed. Nothing changed."
    exit 1
  fi
fi

# Send the running database's last WAL to the repository first, so
# that what happened after the target can still be recovered later.
if [[ "$NEW_SERVER" -eq 0 ]] && docker exec "$PITR_CONTAINER" true >/dev/null 2>&1; then
  echo "=== Sending the last WAL to the repository ==="
  flushed=0
  if pitr_psql -c 'SELECT pg_switch_wal()' >/dev/null 2>&1; then
    for _ in $(seq 1 60); do
      n="$(docker exec -u postgres "$PITR_CONTAINER" \
        find /var/lib/postgresql/data/pg_wal/archive_status -name '*.ready' 2>/dev/null | wc -l)"
      if [[ "$n" -eq 0 ]]; then flushed=1; break; fi
      sleep 2
    done
  fi
  if [[ "$flushed" -eq 0 && "$ACCEPT_UNARCHIVED" -eq 0 ]]; then
    echo "pitr-restore: WAL from the running database did not reach the repository in 2 minutes." >&2
    echo "  Restoring now would lose it for good. Check infra/pitr-status.sh, or pass" >&2
    echo "  --accept-unarchived if the running database is already lost or wrong." >&2
    exit 1
  fi
fi

echo "=== Stopping the stack ==="
pitr_compose stop

# A database that crashed leaves postmaster.pid behind and pgBackRest
# refuses to restore over it. Only remove it when sure nothing runs.
if pitr_compose run --rm --no-deps -T -u postgres --entrypoint sh postgres \
  -c 'test -f /var/lib/postgresql/data/postmaster.pid' >/dev/null 2>&1; then
  echo "pitr-restore: postmaster.pid is still in the data volume (the database did not stop cleanly)." >&2
  echo "  Make sure no postgres runs on this volume, then see 'Stale postmaster.pid' in the runbook." >&2
  exit 1
fi

args=(--stanza="$PITR_STANZA" --delta)
if [[ "$MODE" == time ]]; then
  args+=(--type=time "--target=$TARGET")
  if [[ "$PROMOTE" -eq 1 ]]; then args+=(--target-action=promote); else args+=(--target-action=pause); fi
fi
[[ -n "$SET" ]] && args+=("--set=$SET")
# A drill server must never write into the production repository.
# pgBackRest's own --archive-mode=off goes into postgresql.auto.conf,
# which the overlay's command-line flag would override, so the flag is
# turned off too. The drill's bucket key should also be read-only.
if [[ "$DRILL" -eq 1 ]]; then
  args+=(--archive-mode=off)
  export GG_PITR_ARCHIVE_MODE=off
fi

echo "=== Restoring: pgbackrest ${args[*]} restore ==="
started="$(date -u +%s)"
pitr_compose run --rm --no-deps -T -u postgres --entrypoint pgbackrest postgres "${args[@]}" restore

echo "=== Starting postgres and replaying WAL ==="
pitr_compose up -d --no-deps postgres
# Replay can take a long time after a busy week. Wait up to 4 hours.
state=""
for i in $(seq 1 1440); do
  state="$(pitr_psql -c "SELECT CASE WHEN NOT pg_is_in_recovery() THEN 'done'
    WHEN pg_get_wal_replay_pause_state() = 'paused' THEN 'paused'
    ELSE 'replaying ' || pg_last_wal_replay_lsn() END" 2>/dev/null || echo starting)"
  [[ "$state" == "done" || "$state" == "paused" ]] && break
  if ((i % 6 == 0)); then echo "  $state"; fi
  sleep 10
done
if [[ "$state" != "done" && "$state" != "paused" ]]; then
  echo "pitr-restore: recovery did not finish in 4 hours (last state: $state). See: docker logs $PITR_CONTAINER" >&2
  exit 1
fi
echo "Restore and replay took $(( ($(date -u +%s) - started) / 60 )) minutes. State: $state."

db="$(docker exec "$PITR_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo gratisgis)"
pg_user="$(docker exec "$PITR_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo gratisgis)"
q() { docker exec -u postgres "$PITR_CONTAINER" sh -c 'psql -X -At -U "$POSTGRES_USER" -d "$1" -c "$2"' q "$@" 2>&1 || true; }
echo "=== Quick checks ==="
echo "timeline:              $(q postgres "SELECT timeline_id FROM pg_control_checkpoint()")"
echo "migrations applied:    $(q "$db" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")"
echo "newest item change:    $(q "$db" "SELECT max(updated_at) FROM item")"
echo "PostGIS:               $(q "$db" "SELECT postgis_full_version()" | cut -c1-60)"
echo "Keycloak users:        $(q keycloak "SELECT count(*) FROM user_entity")"

if [[ "$state" == "paused" ]]; then
  cat <<EOF

Database restored and PAUSED at $TARGET. It is read-only and the rest
of the stack is still stopped. Nothing has been written yet.

1. Inspect first (docs/cloud/restore-runbook.md, "Inspect before
   opening"). Is the bad change gone? Is the good data just before it
   there?
     docker exec -it $PITR_CONTAINER psql -U $pg_user $db
2. If right, open the database for writes. This ends recovery and
   starts a new timeline; it cannot be paused again:
     docker exec -u postgres $PITR_CONTAINER psql -U $pg_user -d postgres -c 'SELECT pg_wal_replay_resume()'
   If wrong, run this script again with another --time. Nothing is lost.
3. Then: start the stack (infra/deploy.sh), tombstones (RB-21), the
   missing-objects check, and a new full backup: infra/pitr-backup.sh full
EOF
else
  cat <<EOF

Database restored and open for writes. The rest of the stack is still
stopped. Next, in order (docs/cloud/restore-runbook.md):
  1. Look at the checks above.
  2. Start the stack: infra/deploy.sh (or docker compose ... up -d).
  3. Re-apply deleted-organization tombstones (runbook step; RB-21).
  4. Run the missing-objects check.
  5. Take a new full backup: infra/pitr-backup.sh full
EOF
fi
