#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Continuous backup health, for a person or a monitor.
#
#   infra/pitr-status.sh                    # print, exit 1 on any ALERT
#   infra/pitr-status.sh --check            # also run `pgbackrest check`
#   infra/pitr-status.sh --textfile /var/lib/gratis-gis/pitr/status.prom
#   infra/pitr-status.sh --check-only --textfile /var/lib/gratis-gis/pitr/check.prom
#
# Exit codes: 0 all good, 1 at least one ALERT, 2 could not collect.
# gg-pitr-status.timer runs it every 5 minutes with --textfile, and
# gg-pitr-check.timer hourly with --check-only (check forces a WAL
# switch, so not more often). They write separate files so the metric
# names never appear twice.
#
# Signals (docs/cloud/backup-design.md, "Monitoring"):
#   - WAL files waiting to be archived, and how long the oldest waited
#     (alert after 10 minutes). Measured from pg_wal/archive_status, so
#     a quiet database with nothing to send does not alert.
#   - the last archive attempt failed with no success since
#   - archive_mode is not on (stack started without the overlay)
#   - age of the last full and the last backup of any kind
#   - errors recorded by the last backup, and a jump in full size
#   - free space on the database disk
#   - `pgbackrest check` result (with --check)
set -euo pipefail

# shellcheck source=infra/pitr/common.sh
. "$(cd "$(dirname "$0")" && pwd)/pitr/common.sh"

RUN_CHECK=0
CHECK_ONLY=0
TEXTFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) RUN_CHECK=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --textfile) TEXTFILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '4,26p' "$0"; exit 0 ;;
    *) echo "pitr-status: unknown argument $1" >&2; exit 2 ;;
  esac
done

now="$(date -u +%s)"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  if out="$(pitr_pgbackrest check 2>&1)"; then ok=1; else ok=0; fi
  if [[ -n "$TEXTFILE" ]]; then
    { pitr_metric gg_pitr_check_ok "$ok"; pitr_metric gg_pitr_check_timestamp_seconds "$now"; } >"$TEXTFILE.tmp"
    mv "$TEXTFILE.tmp" "$TEXTFILE"
  fi
  if [[ "$ok" -eq 1 ]]; then echo "pgbackrest check: ok"; exit 0; fi
  printf '%s\nALERT pgbackrest check failed.\n' "$out"
  exit 1
fi

fail_collect() {
  echo "pitr-status: could not read $1" >&2
  if [[ -n "$TEXTFILE" ]]; then
    { pitr_metric gg_pitr_collect_ok 0; pitr_metric gg_pitr_status_timestamp_seconds "$now"; } >"$TEXTFILE.tmp" \
      && mv "$TEXTFILE.tmp" "$TEXTFILE"
  fi
  exit 2
}

mode="$(pitr_psql -c 'SHOW archive_mode' 2>/dev/null)" || fail_collect "archive_mode (is $PITR_CONTAINER running?)"

archiver="$(pitr_psql -F '|' -c "SELECT coalesce(extract(epoch FROM last_archived_time)::bigint, 0),
  coalesce(extract(epoch FROM last_failed_time)::bigint, 0),
  coalesce(last_archived_wal, '-') FROM pg_stat_archiver" 2>/dev/null)" || fail_collect pg_stat_archiver
IFS='|' read -r last_archived last_failed last_wal <<<"$archiver"

# One line per WAL file still waiting for archive_command: its mtime.
ready_times="$(docker exec -u postgres "$PITR_CONTAINER" \
  find /var/lib/postgresql/data/pg_wal/archive_status -name '*.ready' -printf '%T@\n' 2>/dev/null)" \
  || fail_collect pg_wal/archive_status
ready_count=0
ready_oldest="$now"
while IFS= read -r t; do
  [[ -z "$t" ]] && continue
  t="${t%%.*}"
  ready_count=$((ready_count + 1))
  if ((t < ready_oldest)); then ready_oldest="$t"; fi
done <<<"$ready_times"

free_bytes="$(docker exec "$PITR_CONTAINER" df -P -B1 /var/lib/postgresql/data | awk 'NR==2 {print $4}')" \
  || fail_collect "database disk space"

last_full=0 last_any=0 last_error=false last_type=none full_prev=0 full_cur=0
if [[ "$mode" == "on" || "$mode" == "always" ]]; then
  info_json="$(pitr_pgbackrest --output=json info 2>/dev/null)" || fail_collect "pgbackrest info"
  read -r last_full last_any last_error last_type full_prev full_cur < <(python3 -c '
import json, sys
data = json.load(sys.stdin)
backups = data[0].get("backup", []) if data else []
fulls = [b for b in backups if b.get("type") == "full"]
last = backups[-1] if backups else None
def stop(b): return int(b["timestamp"]["stop"]) if b else 0
def size(b): return int(b.get("info", {}).get("repository", {}).get("size", 0)) if b else 0
print(stop(fulls[-1] if fulls else None), stop(last),
      "true" if last and last.get("error") else "false",
      last["type"] if last else "none",
      size(fulls[-2]) if len(fulls) > 1 else 0, size(fulls[-1] if fulls else None))
' <<<"$info_json") || fail_collect "pgbackrest info JSON"
fi

check_ok=-1
if [[ "$RUN_CHECK" -eq 1 ]]; then
  if pitr_pgbackrest check >/dev/null 2>&1; then check_ok=1; else check_ok=0; fi
fi

alerts=""
status=0
alerts="$(pitr_verdict "$now" "$mode" "$ready_count" "$ready_oldest" "$last_archived" \
  "$last_failed" "$last_full" "$last_any" "$last_error")" || status=1
if ! jump="$(pitr_size_jump "$full_prev" "$full_cur")"; then
  alerts+="${alerts:+$'\n'}$jump"
  status=1
fi
if [[ "$check_ok" -eq 0 ]]; then
  alerts+="${alerts:+$'\n'}ALERT pgbackrest check failed. Run: docker exec -u postgres $PITR_CONTAINER pgbackrest --stanza=$PITR_STANZA check"
  status=1
fi
# Under 10 GiB free on the database disk: WAL held back by a stuck
# archive, or plain growth, will stop the database soon.
if ((free_bytes < 10737418240)); then
  alerts+="${alerts:+$'\n'}ALERT only $((free_bytes / 1073741824)) GiB free on the database disk."
  status=1
fi

age() { if (("$1" == 0)); then echo never; else echo "$(((now - $1) / 60)) min ago"; fi; }
echo "archive_mode:        $mode"
echo "last archived WAL:   $last_wal ($(age "$last_archived"))"
echo "WAL waiting:         $ready_count file(s)$( ((ready_count > 0)) && echo ", oldest $(((now - ready_oldest) / 60)) min")"
echo "last backup:         $last_type ($(age "$last_any"))"
echo "last full backup:    $(age "$last_full")"
echo "database disk free:  $((free_bytes / 1073741824)) GiB"
[[ "$check_ok" -ge 0 ]] && echo "pgbackrest check:    $([[ "$check_ok" -eq 1 ]] && echo ok || echo FAILED)"
if [[ "$status" -eq 0 ]]; then
  echo "OK"
else
  printf '%s\n' "$alerts"
fi

if [[ -n "$TEXTFILE" ]]; then
  {
    pitr_metric gg_pitr_collect_ok 1
    pitr_metric gg_pitr_status_timestamp_seconds "$now"
    pitr_metric gg_pitr_archive_mode_on "$([[ "$mode" == on || "$mode" == always ]] && echo 1 || echo 0)"
    pitr_metric gg_pitr_wal_ready_files "$ready_count"
    pitr_metric gg_pitr_wal_ready_oldest_seconds "$((ready_count > 0 ? now - ready_oldest : 0))"
    pitr_metric gg_pitr_last_archived_timestamp_seconds "$last_archived"
    pitr_metric gg_pitr_last_archive_failed_timestamp_seconds "$last_failed"
    pitr_metric gg_pitr_last_backup_timestamp_seconds "$last_full" 'type="full"'
    pitr_metric gg_pitr_last_backup_timestamp_seconds "$last_any" 'type="any"'
    pitr_metric gg_pitr_last_backup_error "$([[ "$last_error" == true ]] && echo 1 || echo 0)"
    pitr_metric gg_pitr_full_backup_repo_bytes "$full_cur"
    pitr_metric gg_pitr_pgdata_free_bytes "$free_bytes"
    [[ "$check_ok" -ge 0 ]] && pitr_metric gg_pitr_check_ok "$check_ok"
    pitr_metric gg_pitr_alert "$status"
  } >"$TEXTFILE.tmp"
  mv "$TEXTFILE.tmp" "$TEXTFILE"
fi
exit "$status"
