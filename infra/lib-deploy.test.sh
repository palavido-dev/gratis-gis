#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Exercise infra/lib-deploy.sh with a fake `docker` on PATH. Nothing
# here talks to a real Docker daemon.
#
#   bash infra/lib-deploy.test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
# The fake reads its answers from files in $FAKE and logs every call
# to $FAKE/calls.
#   services        what `compose ... config --services` prints
#   services_fail   when present, that call fails
#   ps              what `docker ps -a ...` prints (tab separated)
#   running         what `docker inspect` prints for .State.Running
#   inside          the Caddyfile digest the container sees; a
#                   `compose restart caddy` copies inside_after over it
cat > "$work/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls"
case "$1" in
  compose)
    if [[ " $* " == *" config --services "* ]]; then
      [[ -f "$FAKE/services_fail" ]] && exit 1
      cat "$FAKE/services"
    elif [[ " $* " == *" restart caddy"* ]]; then
      cp "$FAKE/inside_after" "$FAKE/inside"
    fi
    ;;
  ps) cat "$FAKE/ps" ;;
  rm) ;;
  inspect) cat "$FAKE/running" ;;
  exec) echo "$(cat "$FAKE/inside")  /etc/caddy/Caddyfile" ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
DOCKER
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"

# shellcheck source=infra/lib-deploy.sh
. "$root/infra/lib-deploy.sh"

pass=0
fail=0
check() {
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1"
    echo "  want: $3"
    echo "  got:  $2"
  fi
}
fresh() {
  export FAKE="$work/case$((pass + fail))"
  rm -rf "$FAKE"
  mkdir -p "$FAKE"
  : > "$FAKE/calls"
}
removed() { grep '^rm ' "$FAKE/calls" | sed 's/^rm -f //' | sort | tr '\n' ' ' | sed 's/ $//'; }
COMPOSE=(docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod)
T=$'\t'

# --- gg_sweep_orphans ---------------------------------------------

fresh
printf 'caddy\nportal-api\nscript-executor\n' > "$FAKE/services"
printf '%s\n' \
  "gratis-gis-prod-caddy${T}caddy${T}False" \
  "gratis-gis-prod-portal-api-1${T}portal-api${T}False" \
  "gratis-gis-prod-pg_tileserv${T}pg_tileserv${T}False" > "$FAKE/ps"
out="$(gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}")"
check "a retired service's container is removed" "$(removed)" "gratis-gis-prod-pg_tileserv"
check "the removal is reported" "$(grep -c 'Removing retired container gratis-gis-prod-pg_tileserv' <<<"$out")" "1"

fresh
printf 'caddy\nscript-executor\n' > "$FAKE/services"
printf '%s\n' "gratis-gis-prod-script-executor${T}script-executor${T}False" > "$FAKE/ps"
gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}" >/dev/null
check "a profile service is kept" "$(removed)" ""
check "the service list asks for every profile" \
  "$(grep -c -- "--profile \* config --services" "$FAKE/calls")" "1"

fresh
printf 'caddy\n' > "$FAKE/services"
printf '%s\n' "gratis-gis-prod-run-abc${T}portal-migrate-old${T}True" > "$FAKE/ps"
gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}" >/dev/null
check "a one-off run container is skipped" "$(removed)" ""

fresh
touch "$FAKE/services_fail"
printf '%s\n' "gratis-gis-prod-caddy${T}caddy${T}False" > "$FAKE/ps"
gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}" >/dev/null 2>&1
check "nothing is removed when compose config fails" "$(removed)" ""

fresh
: > "$FAKE/services"
printf '%s\n' "gratis-gis-prod-caddy${T}caddy${T}False" > "$FAKE/ps"
gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}" >/dev/null 2>&1
check "nothing is removed when the service list is empty" "$(removed)" ""

fresh
printf 'portal-api-v2\n' > "$FAKE/services"
printf '%s\n' "gratis-gis-prod-portal-api-1${T}portal-api${T}False" > "$FAKE/ps"
gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}" >/dev/null
check "service names match whole lines only" "$(removed)" "gratis-gis-prod-portal-api-1"

fresh
printf 'caddy\n' > "$FAKE/services"
: > "$FAKE/ps"
gg_sweep_orphans gratis-gis-prod "${COMPOSE[@]}" >/dev/null
check "the project label scopes the listing" \
  "$(grep -c 'label=com.docker.compose.project=gratis-gis-prod' "$FAKE/calls")" "1"

# --- gg_sync_caddyfile ----------------------------------------------

caddyfile="$work/Caddyfile"
echo 'max_size 51GiB' > "$caddyfile"
want="$(sha256sum "$caddyfile" | cut -d' ' -f1)"

fresh
echo true > "$FAKE/running"
echo "$want" > "$FAKE/inside"
gg_sync_caddyfile gratis-gis-prod-caddy "$caddyfile" "${COMPOSE[@]}" >/dev/null
check "a current Caddyfile needs no restart" "$(grep -c 'restart caddy' "$FAKE/calls")" "0"

fresh
echo true > "$FAKE/running"
echo stale > "$FAKE/inside"
echo "$want" > "$FAKE/inside_after"
rc=0
gg_sync_caddyfile gratis-gis-prod-caddy "$caddyfile" "${COMPOSE[@]}" >/dev/null || rc=$?
check "a stale Caddyfile restarts Caddy" "$(grep -c 'restart caddy' "$FAKE/calls")" "1"
check "the restart goes through compose" \
  "$(grep -c '^compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod restart caddy$' "$FAKE/calls")" "1"
check "a restart that fixes it succeeds" "$rc" "0"

fresh
echo true > "$FAKE/running"
echo stale > "$FAKE/inside"
echo stale > "$FAKE/inside_after"
rc=0
gg_sync_caddyfile gratis-gis-prod-caddy "$caddyfile" "${COMPOSE[@]}" >/dev/null 2>&1 || rc=$?
check "a restart that does not fix it fails" "$rc" "1"

fresh
echo false > "$FAKE/running"
gg_sync_caddyfile gratis-gis-prod-caddy "$caddyfile" "${COMPOSE[@]}" >/dev/null
check "a stopped Caddy is left alone" "$(grep -c -e 'exec' -e 'restart' "$FAKE/calls")" "0"

echo "lib-deploy: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
