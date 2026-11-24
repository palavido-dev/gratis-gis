#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# After a database restore: list object keys the restored database
# refers to that the bucket no longer has. Those are files deleted
# after the restore target. With bucket versioning they can be brought
# back (docs/cloud/restore-runbook.md, "Missing objects").
#
#   infra/pitr-missing-objects.sh --bucket-list keys.txt [--out missing.txt]
#
# keys.txt is every key in the portal's file bucket, one per line. The
# runbook shows how to make it with the aws CLI or rclone. This script
# reads the database only; it never writes to it or to the bucket.
#
# Covered: the prefixes the housekeeping orphan sweep manages
# (feature-attachment, item-file, item-tile-layer, item-point-cloud,
# map-icon, offline-package), found the same way that sweep finds them
# (apps/portal-api/src/admin/housekeeping.service.ts). Thumbnails,
# avatars and hero images are referenced as loose URLs and are not
# covered.
set -euo pipefail

# shellcheck source=infra/pitr/common.sh
. "$(cd "$(dirname "$0")" && pwd)/pitr/common.sh"

BUCKET_LIST="" OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket-list) BUCKET_LIST="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '4,20p' "$0"; exit 0 ;;
    *) echo "pitr-missing-objects: unknown argument $1" >&2; exit 1 ;;
  esac
done
if [[ ! -r "$BUCKET_LIST" ]]; then
  echo "pitr-missing-objects: pass --bucket-list FILE (every key in the bucket, one per line)." >&2
  exit 1
fi

referenced="$(mktemp)"
trap 'rm -f "$referenced"' EXIT

# Same sources and pattern as HousekeepingService.referencedStorageKeys.
# Every analysis_job is included here, not only unfinished ones: after
# a restore, being thorough costs nothing.
sql="$(cat <<'SQL'
SELECT storage_key FROM feature_attachment
UNION SELECT storage_key FROM map_icon_upload
UNION SELECT storage_ref FROM item WHERE storage_ref IS NOT NULL
UNION SELECT storage_key FROM offline_package WHERE storage_key IS NOT NULL
UNION SELECT k FROM (
  SELECT (regexp_matches(i.data_json::text, p, 'g'))[1] AS k FROM item i, pat
  UNION ALL
  SELECT (regexp_matches(s.data::text, p, 'g'))[1] FROM item_data_snapshot s, pat
  UNION ALL
  SELECT (regexp_matches(a.params::text, p, 'g'))[1] FROM analysis_job a, pat
  UNION ALL
  SELECT (regexp_matches(f.response::text, p, 'g'))[1] FROM form_submission f, pat
) u
SQL
)"
pattern='((?:feature-attachment|item-file|item-tile-layer|item-point-cloud)/[0-9a-fA-F-]{36}|map-icon/[0-9a-fA-F-]{36}(?:\.png)?)'

docker exec -i -u postgres "$PITR_CONTAINER" sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  <<<"WITH pat AS (SELECT '$pattern'::text AS p) $sql;" >"$referenced"

if [[ -n "$OUT" ]]; then
  pitr_missing_keys "$referenced" "$BUCKET_LIST" >"$OUT"
  missing="$(wc -l <"$OUT")"
else
  missing_list="$(pitr_missing_keys "$referenced" "$BUCKET_LIST")"
  printf '%s\n' "$missing_list" | sed '/^$/d'
  missing="$(printf '%s\n' "$missing_list" | sed '/^$/d' | wc -l)"
fi
echo "pitr-missing-objects: $(wc -l <"$referenced") referenced keys, $missing missing from the bucket." >&2
