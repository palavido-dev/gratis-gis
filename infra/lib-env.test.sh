#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# gg_load_env_file reads quoted values the way Compose does.
#
#   bash infra/lib-env.test.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/env" <<'ENV'
SINGLE_COMMENT='s3cret$x' # rotated 2026-10
DOUBLE_COMMENT="abc" # note
DOUBLE_ESCAPES="a\"b\\c"
PLAIN=value # trailing comment
PLAIN_DOLLAR=a$$b
SINGLE='keep # this'
ENV
fails=0
check() {
  local name="$1" want="$2" got
  got="$(bash -c ". '$root/infra/lib-env.sh'; gg_load_env_file '$work/env' 2>/dev/null; printf '%s' \"\${$name}\"")"
  if [[ "$got" == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name: got [$got] want [$want]"; fails=$((fails + 1)); fi
}
check SINGLE_COMMENT 's3cret$x'
check DOUBLE_COMMENT 'abc'
check DOUBLE_ESCAPES 'a"b\c'
check PLAIN 'value'
check PLAIN_DOLLAR 'a$b'
check SINGLE 'keep # this'
[[ "$fails" -eq 0 ]] && echo "lib-env: ok" || { echo "lib-env: $fails failure(s)"; exit 1; }
