#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The installer's server checks: plain messages and the right verdict.
#
#   bash infra/install.test.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fails=0
out_file="$(mktemp)"
trap 'rm -f "$out_file"' EXIT

# Run one check in a fresh shell with test values; print its output
# and the problem count on the last line.
run() {
  local fn="$1"
  shift
  env GG_INSTALL_LIB_ONLY=1 GG_OUT="$out_file" "$@" bash -c ". '$root/infra/install.sh'; $fn >\"\$GG_OUT\" 2>&1 || true; cat \"\$GG_OUT\"; echo \"problems=\$GG_PROBLEMS\""
}

expect() {
  local name="$1" out="$2" want="$3"
  if grep -qF -- "$want" <<<"$out"; then
    echo "ok   $name"
  else
    echo "FAIL $name: wanted [$want] in:"
    echo "$out" | sed 's/^/     /'
    fails=$((fails + 1))
  fi
}

out="$(run gg_check_memory GG_TEST_MEM_GB=2.0)"
expect "low memory stops" "$out" "This server has 2.0 GB of memory. GratisGIS needs at least 4 GB."
expect "low memory counted" "$out" "problems=1"
out="$(run gg_check_memory GG_TEST_MEM_GB=3.8)"
expect "4 GB is a note" "$out" "problems=0"
expect "4 GB note text" "$out" "Enough to run"
out="$(run gg_check_memory GG_TEST_MEM_GB=16.0)"
expect "plenty of memory" "$out" "16.0 GB of memory"

out="$(run gg_check_disk GG_TEST_DISK_GB=12)"
expect "low disk stops" "$out" "Only 12 GB of free disk space"
expect "low disk counted" "$out" "problems=1"
out="$(run gg_check_disk GG_TEST_DISK_GB=200)"
expect "plenty of disk" "$out" "problems=0"

out="$(run gg_check_ports GG_TEST_PORT_HOLDER=nginx)"
expect "port held stops" "$out" "Web port 80 is already used by nginx"
expect "both ports counted" "$out" "problems=2"
expect "port fix named" "$out" "systemctl disable --now nginx"
out="$(run gg_check_ports GG_TEST_PORT_HOLDER=docker-proxy)"
expect "earlier install is fine" "$out" "problems=0"

out="$(run gg_check_system GG_TEST_KERNEL=Darwin)"
expect "not linux stops" "$out" "This computer runs Darwin"
out="$(run gg_check_system GG_TEST_KERNEL=Linux GG_TEST_ARCH=x86_64 GG_TEST_OS='Ubuntu 24.04.1 LTS')"
expect "ubuntu ok" "$out" "problems=0"
out="$(run gg_check_system GG_TEST_KERNEL=Linux GG_TEST_ARCH=x86_64 GG_TEST_OS='Fedora Linux 41')"
expect "other distro is a note" "$out" "not one of the tested systems"
expect "other distro not a stop" "$out" "problems=0"

out="$(run gg_check_internet GG_TEST_OFFLINE=1)"
expect "offline stops" "$out" "Cannot reach GitHub"
expect "offline counted" "$out" "problems=4"

out="$(env GG_INSTALL_LIB_ONLY=1 bash -c ". '$root/infra/install.sh'; gg_ge 3.5 3.5 && echo ge; gg_ge 3.4 3.5 || echo lt")"
expect "decimal compare" "$out" "ge"
expect "decimal compare less" "$out" "lt"

[[ "$fails" -eq 0 ]] && echo "install: ok" || { echo "install: $fails failure(s)"; exit 1; }
