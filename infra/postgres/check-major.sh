#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Compare a data directory's PG_VERSION with the major the image
# expects. This does not start Postgres and does not change the image.
set -eu

data_version=""
image_major=""

while [ $# -gt 0 ]; do
  case "$1" in
    --data-version-file)
      data_version="${2:-}"
      shift 2
      ;;
    --image-major)
      image_major="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument" >&2
      exit 2
      ;;
  esac
done

if [ -z "$data_version" ] || [ -z "$image_major" ]; then
  echo "usage: check-major.sh --data-version-file PG_VERSION --image-major 17" >&2
  exit 2
fi

if [ ! -f "$data_version" ]; then
  echo "PG_VERSION file is missing. Refusing to start a major that cannot read this directory." >&2
  exit 1
fi

found="$(tr -d '[:space:]' < "$data_version")"
case "$found" in
  ''|*[!0-9]*)
    echo "PG_VERSION is not a major number." >&2
    exit 1
    ;;
esac
case "$image_major" in
  ''|*[!0-9]*)
    echo "image major is not a number." >&2
    exit 2
    ;;
esac

if [ "$found" != "$image_major" ]; then
  echo "Postgres data directory is major $found and the image is major $image_major. Refusing to start. Dump and restore with the planned upgrade tool. Do not change the default image to skip this check." >&2
  exit 1
fi

echo "Postgres major $found matches the image."
