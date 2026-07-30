#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fetch or refresh the MaxMind GeoLite2 databases collect.py uses:
# City, to turn visitor IPs into places, and ASN, to tell a home
# connection from a rented server. Both are optional; each one that is
# missing simply switches off what it feeds.
#
# GeoLite2 is free but account-gated: sign up at
# https://www.maxmind.com/en/geolite2/signup, then create a licence
# key under Account > Manage License Keys. Put both values in
# /etc/gg-analytics.env (root-only, 0600):
#
#     MAXMIND_ACCOUNT_ID=1234567
#     MAXMIND_LICENSE_KEY=xxxxxxxxxxxxxxxx
#
# MaxMind updates the databases twice a week and asks that clients not
# poll more often than that. There is no timer for this yet: run it by
# hand after adding the key, then wire a weekly cron or systemd timer
# if you want it to stay current.
#
# Usage:
#     ./geoip-update.sh              both databases
#     ./geoip-update.sh City         one of them
#
# The lookups themselves are local: no visitor address ever leaves the
# host.
set -euo pipefail

ENV_FILE="${GG_ANALYTICS_ENV:-/etc/gg-analytics.env}"
ANALYTICS_DIR="${GG_ANALYTICS_DIR:-/var/lib/gg-analytics}"
DEST_DIR="$ANALYTICS_DIR/geoip"

[ -f "$ENV_FILE" ] && . "$ENV_FILE"

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  echo "MAXMIND_LICENSE_KEY is not set (looked in $ENV_FILE)." >&2
  echo "Locations stay unresolved until it is; everything else keeps working." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

fetch_edition() {
  edition="GeoLite2-$1"
  dest="$DEST_DIR/$edition.mmdb"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  # Two download paths. The account-authenticated endpoint is the
  # current one; the query-parameter form still works for older keys
  # and is the fallback so an existing key does not have to be
  # reissued.
  if [ -n "${MAXMIND_ACCOUNT_ID:-}" ]; then
    url="https://download.maxmind.com/geoip/databases/$edition/download?suffix=tar.gz"
    curl -fsSL --retry 3 -u "${MAXMIND_ACCOUNT_ID}:${MAXMIND_LICENSE_KEY}" \
      -o "$tmp/db.tar.gz" "$url"
  else
    url="https://download.maxmind.com/app/geoip_download?edition_id=$edition&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz"
    curl -fsSL --retry 3 -o "$tmp/db.tar.gz" "$url"
  fi

  tar -xzf "$tmp/db.tar.gz" -C "$tmp"
  found="$(find "$tmp" -name "$edition.mmdb" -print -quit)"
  if [ -z "$found" ]; then
    echo "download did not contain $edition.mmdb" >&2
    return 1
  fi

  # Atomic swap: collect.py may have the current file open.
  mv "$found" "$dest.new"
  mv "$dest.new" "$dest"
  chmod 0644 "$dest"
  echo "installed $dest ($(du -h "$dest" | cut -f1))"
}

editions=("$@")
[ ${#editions[@]} -eq 0 ] && editions=(City ASN)
for edition in "${editions[@]}"; do
  fetch_edition "$edition"
done

# Existing rows were resolved against the previous database, or not at
# all. Clearing the unresolved ones lets the next collector run try
# again with the fresh data; successful lookups are left alone so the
# recorded history stays stable.
if [ -f "$ANALYTICS_DIR/analytics.db" ]; then
  sqlite3 "$ANALYTICS_DIR/analytics.db" \
    "DELETE FROM ip_geo WHERE country IS NULL;
     DELETE FROM ip_asn WHERE asn IS NULL;" 2>/dev/null \
    && echo "cleared unresolved lookups for retry"
fi

cat <<'NOTE'

Re-run the collector with --reclassify to apply the fresh data to
visits already recorded:

    python3 infra/analytics/collect.py --reclassify
NOTE
