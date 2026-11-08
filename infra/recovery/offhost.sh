#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copy a sealed recovery bundle to an operator directory and check
# the bytes. The destination file is created once and then made
# read-only. A second copy to the same name fails. This is not
# object-lock storage; that remains a follow-on.
#
#   --dest file:/absolute/path
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
recovery_umask

CONFIRM=""
BUNDLE=""
DEST=""
STATUS_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done

recovery_confirm_project "$CONFIRM"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || recovery_die 'bundle is required'
# latest.tar.enc is a symlink; copy the timestamped file it names.
BUNDLE="$(readlink -f "$BUNDLE")"
[[ "$DEST" == file:/* ]] || recovery_die 'dest must be file:/absolute/path'
DEST_DIR="${DEST#file:}"
[[ -d "$DEST_DIR" ]] || recovery_die 'destination directory does not exist'

base="$(basename "$BUNDLE")"
target="$DEST_DIR/$base"
if [[ -e "$target" ]]; then
  recovery_die 'destination already has this bundle; refusing to overwrite'
fi

write_status() {
  [[ -n "$STATUS_FILE" ]] || return 0
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"outcome":"$1","phase":"$2","kind":"secondary-file","portalDownload":false,"secondaryFileVerified":$3,"sameDisk":$4,"offsiteVerified":false,"immutable":false,"detail":"$5"}
EOF
  chmod 644 "$STATUS_FILE"
}

if ! cp --update=none "$BUNDLE" "$target"; then
  write_status failed copy false false 'copy failed'
  recovery_die 'copy failed'
fi
src_sum="$(recovery_sha256 "$BUNDLE")"
dst_sum="$(recovery_sha256 "$target")"
if [[ "$src_sum" != "$dst_sum" ]]; then
  rm -f "$target"
  write_status failed verify false false 'copied bytes do not match'
  recovery_die 'copied bytes do not match'
fi
chmod a-w "$target"
if [[ -w "$target" ]]; then
  write_status failed permissions false false 'destination is still writable'
  recovery_die 'destination is still writable'
fi
src_dev="$(stat -c '%d' "$BUNDLE")"
dst_dev="$(stat -c '%d' "$target")"
same=false
if [[ "$src_dev" == "$dst_dev" ]]; then
  same=true
fi
write_status succeeded secondary-file true "$same" 'verified secondary file copy; not an off-site or immutable copy'
printf 'recovery: secondary file copy verified\n'
