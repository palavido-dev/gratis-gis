#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# script-net-firewall.sh reads SCRIPT_EGRESS from infra/.env.prod when
# the caller's environment has none. deploy.sh runs it through
# `sudo -n`, which clears the environment, and a portal-only install
# used to reopen egress on every deploy. Needs no root and no Docker:
# every case stops before the iptables calls.
#
#   bash infra/script-net-firewall.test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/infra/script-net-firewall.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

run() {
  env -u SCRIPT_EGRESS GG_ENV_FILE="$work/env" GG_SCRIPT_NETWORK=gg-test-no-such-network \
    "$@" bash "$script" 2>&1 || true
}

printf 'POSTGRES_PASSWORD=x\nSCRIPT_EGRESS=not-a-mode\n' > "$work/env"
run | grep -q "got 'not-a-mode'" || { echo "FAIL: env file value was not read" >&2; exit 1; }

printf "SCRIPT_EGRESS='also-bad'  # comment\n" > "$work/env"
run | grep -q "got 'also-bad'" || { echo "FAIL: quoted env file value was not read" >&2; exit 1; }

printf 'SCRIPT_EGRESS=not-a-mode\n' > "$work/env"
if run SCRIPT_EGRESS=open | grep -q "got '"; then
  echo "FAIL: the caller's SCRIPT_EGRESS should win over the file" >&2
  exit 1
fi

rm -f "$work/env"
if run | grep -q "got '"; then
  echo "FAIL: a missing env file should mean the default" >&2
  exit 1
fi

echo "script-net-firewall: ok"
