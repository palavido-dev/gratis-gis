#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One scheduled backup into the pgBackRest repository.
#
#   infra/pitr-backup.sh full    # weekly (gg-pitr-full.timer)
#   infra/pitr-backup.sh diff    # daily  (gg-pitr-diff.timer)
#   infra/pitr-backup.sh full --textfile-dir /var/lib/gratis-gis/pitr
#
# With --textfile-dir it writes backup-<type>.prom there on exit:
# whether this run worked, and when. A monitor alerts on a 0.
#
# pgBackRest removes backups and WAL older than the 14-day window
# after each successful backup (repo1-retention-full in
# infra/pitr/pgbackrest.conf). With a bucket key that cannot delete,
# that removal only hides files; the bucket's lifecycle rule removes
# them later. See docs/cloud/backup-design.md.
set -euo pipefail

# shellcheck source=infra/pitr/common.sh
. "$(cd "$(dirname "$0")" && pwd)/pitr/common.sh"

type="${1:-}"
case "$type" in
  full|diff|incr) ;;
  *) echo "usage: infra/pitr-backup.sh full|diff|incr [--textfile-dir DIR]" >&2; exit 1 ;;
esac
shift
TEXTFILE_DIR=""
if [[ "${1:-}" == "--textfile-dir" ]]; then
  TEXTFILE_DIR="${2:-}"
fi

write_result() {
  local rc=$?
  if [[ -n "$TEXTFILE_DIR" ]]; then
    mkdir -p "$TEXTFILE_DIR"
    {
      pitr_metric gg_pitr_backup_last_ok "$([[ "$rc" -eq 0 ]] && echo 1 || echo 0)" "type=\"$type\""
      pitr_metric gg_pitr_backup_last_run_timestamp_seconds "$(date -u +%s)" "type=\"$type\""
    } >"$TEXTFILE_DIR/backup-$type.prom.tmp"
    mv "$TEXTFILE_DIR/backup-$type.prom.tmp" "$TEXTFILE_DIR/backup-$type.prom"
  fi
}
trap write_result EXIT

if [[ ! -f "$PITR_ENV_FILE" ]]; then
  echo "pitr-backup: continuous backups are not set up here ($PITR_ENV_FILE is missing)." >&2
  exit 1
fi

start="$(date -u +%s)"
echo "pitr-backup: $type backup started $(date -u -Iseconds)"
pitr_pgbackrest --type="$type" backup
echo "pitr-backup: $type backup finished in $(( $(date -u +%s) - start )) seconds"
