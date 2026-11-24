#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# First-time setup of continuous backups on the VPS stack.
#
#   infra/pitr-setup.sh --confirm-project gratis-gis-prod [--new-key]
#                       [--skip-backup]
#
# 1. Checks infra/.env.pitr. With --new-key, writes a random encryption
#    passphrase into it when the placeholder is still there.
# 2. Restarts postgres with infra/docker-compose.pitr.yml (a short
#    database outage; the portal reconnects).
# 3. Creates the pgBackRest stanza, runs `check` (which proves a WAL
#    file reaches the bucket), takes the first full backup and prints
#    `info`.
#
# Safe to run again: stanza-create and check do nothing harmful on a
# repository that is already set up. It never deletes anything.
# Design: docs/cloud/backup-design.md.
set -euo pipefail

# shellcheck source=infra/pitr/common.sh
. "$(cd "$(dirname "$0")" && pwd)/pitr/common.sh"

CONFIRM=""
NEW_KEY=0
SKIP_BACKUP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="${2:-}"; shift 2 ;;
    --new-key) NEW_KEY=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) sed -n '4,20p' "$0"; exit 0 ;;
    *) echo "pitr-setup: unknown argument $1" >&2; exit 1 ;;
  esac
done
pitr_require_project "$CONFIRM"
cd "$PITR_ROOT"

if [[ ! -f "$PITR_ENV_FILE" ]]; then
  echo "pitr-setup: $PITR_ENV_FILE is missing." >&2
  echo "  cp infra/pitr/pitr.env.example infra/.env.pitr && chmod 600 infra/.env.pitr" >&2
  exit 1
fi
chmod 600 "$PITR_ENV_FILE"

if [[ "$NEW_KEY" -eq 1 ]] && grep -qE '^PGBACKREST_REPO1_CIPHER_PASS=CHANGE_ME$' "$PITR_ENV_FILE"; then
  # Letters and digits only, so compose and the shell never read a
  # character in it as syntax. 64 of them is about 380 bits.
  # Read a fixed amount first: `tr </dev/urandom | head` ends in
  # SIGPIPE, which pipefail turns into a failed setup.
  key="$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  key="${key:0:64}"
  if [[ "${#key}" -ne 64 ]]; then
    echo "pitr-setup: could not read enough random data." >&2
    exit 1
  fi
  tmp="$(mktemp "$PITR_ENV_FILE.XXXXXX")"
  chmod 600 "$tmp"
  awk -v k="$key" '/^PGBACKREST_REPO1_CIPHER_PASS=CHANGE_ME$/ { print "PGBACKREST_REPO1_CIPHER_PASS=" k; next } { print }' \
    "$PITR_ENV_FILE" >"$tmp"
  mv "$tmp" "$PITR_ENV_FILE"
  cat <<EOF

=== NEW BACKUP ENCRYPTION PASSPHRASE ===
$key

Save it now in the owner's password manager, under
"GratisGIS backup passphrase". Without it no backup can be read.
It is in infra/.env.pitr on this server and nowhere else.
========================================

EOF
  read -r -p "Type SAVED once it is in the password manager: " ans
  if [[ "$ans" != "SAVED" ]]; then
    echo "pitr-setup: stopped. The passphrase is in infra/.env.pitr; run again when it is saved." >&2
    exit 1
  fi
fi

if ! problems="$(pitr_env_problems "$PITR_ENV_FILE")"; then
  echo "pitr-setup: fix infra/.env.pitr first:" >&2
  printf '  %s\n' "$problems" >&2
  exit 1
fi

echo "=== Restarting postgres with continuous archiving on ==="
echo "The database is down for a few seconds. The portal reconnects."
pitr_compose up -d --no-deps postgres
pitr_wait_ready

have="$(docker exec -u postgres "$PITR_CONTAINER" pgbackrest version | awk '{print $2}')"
if ! pitr_version_ge "$have" "$PITR_MIN_PGBACKREST"; then
  echo "pitr-setup: the postgres image has pgBackRest $have; $PITR_MIN_PGBACKREST or newer is needed." >&2
  echo "  Rebuild it first: infra/deploy.sh (or docker compose ... build postgres)." >&2
  exit 1
fi

mode="$(pitr_psql -c 'SHOW archive_mode')"
if [[ "$mode" != "on" ]]; then
  echo "pitr-setup: archive_mode is '$mode' after the restart. Is docker-compose.pitr.yml being read?" >&2
  exit 1
fi

echo "=== Creating the stanza ==="
pitr_pgbackrest stanza-create

echo "=== Checking that WAL reaches the bucket ==="
pitr_pgbackrest check

if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  echo "=== First full backup (this can take a while) ==="
  pitr_pgbackrest --type=full backup
fi

echo "=== Repository ==="
pitr_pgbackrest info

cat <<'EOF'

Continuous backups are on. Next:
  1. Install the timers (weekly full, daily differential, status every
     5 minutes): see "Schedule" in docs/cloud/backup-design.md.
  2. Run infra/pitr-status.sh and see it print OK.
  3. Do a test restore on a throwaway server: docs/cloud/pitr-test-plan.md.
EOF
