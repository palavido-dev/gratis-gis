#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Open the sealed secret archive written beside a recovery bundle.
# The secrets key is a different file from the recovery passphrase.
# This script does not print file contents or the key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
recovery_umask

KEY=""
SEALED=""
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --secrets-key-file) KEY="$2"; shift 2 ;;
    --sealed) SEALED="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done

[[ -n "$KEY" && -f "$KEY" ]] || recovery_die 'secrets key file is required'
[[ -n "$SEALED" && -f "$SEALED" ]] || recovery_die 'sealed secrets archive is required'
[[ -n "$OUT" ]] || recovery_die 'output directory is required'
mkdir -p "$OUT"
chmod 700 "$OUT"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-secrets.XXXXXX")"
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

NODE="$(recovery_node)" || recovery_die 'node 20 or newer was not found for seal.mjs'
"$NODE" "$HERE/seal.mjs" dec "$KEY" "$SEALED" "$STAGE/secrets.tar"
python3 "$HERE/safe_untar.py" "$STAGE/secrets.tar" "$OUT"
printf 'recovery: secrets unsealed\n'
