#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Synthetic point-in-time recovery. The only project this script
# touches is gg-wal-drill, and only when that name is passed twice.
# It does not change the runtime of an ordinary install.
set -euo pipefail

CONFIRM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    *) echo "wal: unknown argument" >&2; exit 1 ;;
  esac
done
if [[ "$CONFIRM" != "gg-wal-drill" ]]; then
  echo 'wal: refusing every project except gg-wal-drill' >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="$HERE/compose.wal.yml"
STARTED=0
cleanup() {
  if [[ "$STARTED" -eq 1 ]]; then
    docker compose -p gg-wal-drill -f "$COMPOSE" --profile restore down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 - <<'PY'
import socket
s = socket.socket(); s.settimeout(0.3)
try:
    s.connect(("127.0.0.1", 55436))
except OSError:
    pass
else:
    raise SystemExit("port 55436 is in use")
finally:
    s.close()
PY

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gg-wal-drill.XXXXXX")"
mkdir -p "$WORK/wal" "$WORK/base"
chmod 777 "$WORK/wal" "$WORK/base"
export WAL_ARCHIVE_DIR="$WORK/wal"
export WAL_BASE_DIR="$WORK/base"
compose() { docker compose -p gg-wal-drill -f "$COMPOSE" "$@"; }

echo 'wal-drill: starting gg-wal-drill'
compose up -d postgres
STARTED=1
for _ in $(seq 1 40); do
  if compose exec -T postgres pg_isready -U waldrill -d waldrill >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
compose exec -T postgres pg_isready -U waldrill -d waldrill >/dev/null

psql() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U waldrill -d waldrill "$@"; }

# The image's entrypoint accepts connections on a temporary server
# while it loads extensions, then restarts. Wait until a write sticks.
for _ in $(seq 1 30); do
  if psql -c "CREATE TABLE IF NOT EXISTS mark (id int primary key, note text not null);" >/dev/null 2>&1; then
    if psql -At -c "SELECT to_regclass('mark');" | grep -qx mark; then
      break
    fi
  fi
  sleep 1
done
psql -At -c "SELECT to_regclass('mark');" | grep -qx mark
# The base backup has to predate the rows. Recovery can only replay
# forward from that backup to the chosen timestamp.
compose exec -T postgres pg_basebackup -D /backup -U waldrill -X stream -c fast >/dev/null
psql -c "INSERT INTO mark (id, note) VALUES (1, 'before');" >/dev/null
sleep 2
TARGET="$(psql -At -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')")"
sleep 2
psql -c "INSERT INTO mark (id, note) VALUES (2, 'after');" >/dev/null
psql -c "SELECT pg_switch_wal();" >/dev/null
sleep 3
# The target time is written into the backup before this server stops.
# It is a timestamp, not a secret.
compose exec -T postgres bash -c "printf '%s\n' \"recovery_target_time = '${TARGET} UTC'\" >> /backup/postgresql.auto.conf && touch /backup/recovery.signal"

compose stop postgres >/dev/null
compose --profile restore up -d restore
for _ in $(seq 1 40); do
  if compose exec -T restore pg_isready -U waldrill -d waldrill >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! compose exec -T restore pg_isready -U waldrill -d waldrill >/dev/null 2>&1; then
  docker logs gg-wal-drill-restore-1 2>&1 | tail -n 50 >&2 || true
  echo 'wal: restore server did not stay up' >&2
  exit 1
fi

NOTES="$(compose exec -T restore psql -At -U waldrill -d waldrill -c "SELECT note FROM mark ORDER BY id;")"
printf 'wal-drill notes: %s\n' "$NOTES"
printf '%s\n' "$NOTES" | grep -qx 'before' || {
  echo 'wal: recovered database does not contain only the earlier row' >&2
  exit 1
}
if printf '%s\n' "$NOTES" | grep -qx 'after'; then
  echo 'wal: the later row was visible at the chosen timestamp' >&2
  exit 1
fi
echo 'wal-drill: chosen timestamp recovered the earlier row only'
