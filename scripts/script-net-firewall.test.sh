#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The script-network fence must sweep only its own INPUT rules. It once
# matched any rule containing "172." and deleted operators' own rules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/infra/script-net-firewall.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state"

cat >"$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "network ls -q") echo "net-script"; echo "net-main" ;;
  *".IPAM.Config"*"Subnet}} {{end}}"*) echo "172.19.0.0/16 172.18.0.0/16 " ;;
  *".IPAM.Config"*) echo "172.19.0.0/16" ;;
  *".Containers"*) echo "gratis-gis-prod-script-executor-1 172.19.0.10/16" ;
                   echo "gratis-gis-prod-portal-api-1 172.19.0.3/16" ;;
  "network inspect "*) exit 0 ;;
  *) exit 0 ;;
esac
FAKE

cat >"$TMP/bin/iptables" <<'FAKE'
#!/usr/bin/env bash
state="${FENCE_STATE:?}"
op="$1"; chain="${2:-}"
file="$state/$chain"
touch "$file"
case "$op" in
  -N|-F) exit 0 ;;
  -S) cat "$file" ;;
  -A) shift 2; echo "-A $chain $*" >>"$file" ;;
  -I) shift 3; { echo "-A $chain $*"; cat "$file"; } >"$file.new"; mv "$file.new" "$file" ;;
  -D)
    shift 2
    want="-A $chain $*"
    if grep -qxF -- "$want" "$file"; then
      awk -v w="$want" 'done || $0 != w { print; next } { done = 1 }' "$file" >"$file.new"
      mv "$file.new" "$file"
    else
      exit 1
    fi
    ;;
esac
FAKE
chmod +x "$TMP/bin/docker" "$TMP/bin/iptables"

cat >"$TMP/state/INPUT" <<'RULES'
-A INPUT -s 172.16.0.0/12 -j DROP
-A INPUT -s 10.0.172.5/32 -j DROP
-A INPUT -s 172.20.0.9/32 -j DROP
-A INPUT -s 172.19.0.7/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -s 172.19.0.7/32 -j DROP
RULES

run() {
  PATH="$TMP/bin:$PATH" FENCE_STATE="$TMP/state" GG_FENCE_TEST_ALLOW_NONROOT=1 \
    bash "$SCRIPT" >/dev/null
}

run
run

input="$(cat "$TMP/state/INPUT")"
for keep in \
  "-A INPUT -s 172.16.0.0/12 -j DROP" \
  "-A INPUT -s 10.0.172.5/32 -j DROP" \
  "-A INPUT -s 172.20.0.9/32 -j DROP"; do
  grep -qxF -- "$keep" <<<"$input" || fail "operator rule was removed: $keep"
done
grep -qF -- "172.19.0.7" <<<"$input" && fail "legacy fence rule for an old executor address survived"
[[ "$(grep -cF -- '--comment gg-script-fence' <<<"$input")" == "2" ]] \
  || fail "expected exactly two tagged fence rules after two runs, got: $input"
grep -qF -- "-s 172.19.0.10 -m comment --comment gg-script-fence -j DROP" <<<"$input" \
  || fail "executor DROP rule missing"
grep -qF -- "172.19.0.3" <<<"$input" && fail "portal-api was fenced"

echo "script-net-firewall: ok"
