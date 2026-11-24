#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# restore-from-offsite.sh without a real stack: the pure helpers, and
# the order of the steps against a fake docker that records each call.
#
#   bash infra/restore-from-offsite.test.sh
#
# The checks are strings run by eval, so single quotes are the point.
# shellcheck disable=SC2016,SC2034
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/infra/restore-from-offsite.sh"
fails=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() { echo "ok   $1"; }
bad() {
  echo "FAIL $1"
  fails=$((fails + 1))
}
expect_true() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
expect_false() { if eval "$2"; then bad "$1"; else ok "$1"; fi; }
expect_in() {
  if grep -qF -- "$3" <<<"$2"; then ok "$1"; else
    bad "$1: wanted [$3] in:"
    while IFS= read -r l; do echo "     $l"; done <<<"$2"
  fi
}
expect_not_in() { if grep -qF -- "$3" <<<"$2"; then bad "$1"; else ok "$1"; fi; }

# --- pure helpers -------------------------------------------------
# shellcheck source=infra/restore-from-offsite.sh disable=SC1091
GG_RESTORE_LIB_ONLY=1 source "$script"

cat >"$tmp/env" <<'EOF'
# comment
POSTGRES_USER=gis_user
POSTGRES_DB="portal_db"
QUOTED='single quoted'
WINDOWS=crlf
EOF
printf 'WINDOWS=crlf\r\n' >>"$tmp/env"
expect_true "env value plain" '[[ "$(ggo_env_value "$tmp/env" POSTGRES_USER)" == gis_user ]]'
expect_true "env value double quotes" '[[ "$(ggo_env_value "$tmp/env" POSTGRES_DB)" == portal_db ]]'
expect_true "env value single quotes" '[[ "$(ggo_env_value "$tmp/env" QUOTED)" == "single quoted" ]]'
expect_true "env value strips CR" '[[ "$(ggo_env_value "$tmp/env" WINDOWS)" == crlf ]]'
expect_true "env value missing is empty" '[[ -z "$(ggo_env_value "$tmp/env" NOPE)" ]]'

expect_true "archive name ok" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12.tar.gz'
expect_false "archive name traversal" 'ggo_valid_archive ../backup-x.tar.gz'
expect_false "archive name other file" 'ggo_valid_archive notes.txt'
expect_true "mirror run ok" 'ggo_valid_mirror_run 2026-11-24T02-00-00-000-abcdef12'
expect_false "mirror run bad" 'ggo_valid_mirror_run "2026-11-24; rm -rf /"'
expect_true "identifier ok" 'ggo_valid_identifier gratisgis'
expect_false "identifier quote" 'ggo_valid_identifier "a\"b"'
expect_true "kv reads a key" '[[ "$(printf "a=1\nb=2\n" | ggo_kv b)" == 2 ]]'
expect_true "stamp of archive" '[[ "$(ggo_stamp backup-2026-11-24T02-00-00-000-abcdef12.tar.gz)" == 2026-11-24T02-00-00-000 ]]'
expect_true "stamp of mirror run" '[[ "$(ggo_stamp 2026-11-25T02-00-00-000-abcdef12)" == 2026-11-25T02-00-00-000 ]]'

# --- the flow, against a fake docker ------------------------------
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
# Record the call (arguments only) and answer like compose would.
log="$FAKE_DOCKER_LOG"
printf '%s\n' "$*" >>"$log"
args=" $* "
stdin_if_any() { if [ ! -t 0 ]; then cat >>"$FAKE_DOCKER_STDIN"; printf '\n' >>"$FAKE_DOCKER_STDIN"; fi; }
case "$args" in
  *" ps --status running --services "*) printf 'postgres\nminio\ncaddy\n' ;;
  *" config --services "*) printf 'postgres\nminio\nportal-api\nportal-web\nportal-migrate\ncaddy\n' ;;
  *"offsite-cli.js list "*) printf 'latest=%s\n' "$FAKE_LATEST"; [ -n "${FAKE_LATEST_MIRROR:-}" ] && printf 'latestMirror=%s\n' "$FAKE_LATEST_MIRROR"; true ;;
  *"offsite-cli.js fetch-mirror "*) stdin_if_any; printf 'run=%s\ndump=/app/backups/offsite-restore/%s/database.dump\ndatabase=gratisgis\nobjects=7\n' "$FAKE_LATEST_MIRROR" "$FAKE_LATEST_MIRROR" ;;
  *"offsite-cli.js fetch "*) stdin_if_any; printf 'archive=/app/backups/offsite-restore/%s\ndatabase=gratisgis\nobjects=5\n' "$FAKE_LATEST" ;;
  *"offsite-cli.js put-mirror-objects "*) stdin_if_any; printf 'objects=7\n' ;;
  *"offsite-cli.js put-objects "*) printf 'objects=5\n' ;;
  *"offsite-cli.js count-objects "*) printf 'objects=5\n' ;;
  *" pg_restore "*) cat >/dev/null ;;
  *"SELECT count(*)"*) printf '3\n' ;;
  *) [ -t 0 ] || cat >/dev/null ;;
esac
EOF
chmod +x "$tmp/bin/docker"
printf 'my offsite passphrase value 42\n' >"$tmp/pass"
chmod 600 "$tmp/pass"
touch "$tmp/compose.yml"

run_flow() {
  : >"$tmp/log"
  : >"$tmp/stdin"
  env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" FAKE_DOCKER_STDIN="$tmp/stdin" "$@" \
    bash "$script" --env-file "$tmp/env" --passphrase-file "$tmp/pass" --compose-file "$tmp/compose.yml" \
    --project gg-test </dev/null 2>&1 || true
}

out="$(run_flow FAKE_LATEST=backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz)"
expect_in "refuses without confirmation" "$out" "pass --confirm-project gg-test"
expect_true "nothing ran without confirmation" '[[ ! -s "$tmp/log" ]]'

out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" FAKE_DOCKER_STDIN="$tmp/stdin" \
  FAKE_LATEST=backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz \
  bash "$script" --env-file "$tmp/env" --passphrase-file "$tmp/pass" --compose-file "$tmp/compose.yml" \
  --project gg-test --list </dev/null 2>&1)"
expect_in "list prints the newest copy" "$out" "latest=backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz"

: >"$tmp/log"
: >"$tmp/stdin"
out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" FAKE_DOCKER_STDIN="$tmp/stdin" \
  FAKE_LATEST=backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz \
  bash "$script" --env-file "$tmp/env" --passphrase-file "$tmp/pass" --compose-file "$tmp/compose.yml" \
  --project gg-test --confirm-project gg-test </dev/null 2>&1)"
log="$(cat "$tmp/log")"
expect_in "archive: fetches the newest copy by name, passphrase on stdin" "$log" "offsite-cli.js fetch --out /app/backups/offsite-restore --name backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz --passphrase-stdin"
expect_in "archive: passphrase arrived on stdin" "$(cat "$tmp/stdin")" "my offsite passphrase value 42"
expect_not_in "passphrase never an argument" "$log" "my offsite passphrase"
expect_not_in "passphrase never printed" "$out" "my offsite passphrase"
expect_in "stops writers" "$log" "stop portal-api portal-web"
expect_not_in "keeps the database running" "$(grep ' stop ' <<<"$log")" "postgres"
expect_in "drops and recreates the database from the env file" "$log" 'DROP DATABASE IF EXISTS "portal_db" WITH (FORCE)'
expect_in "creates it owned by the env user" "$log" 'CREATE DATABASE "portal_db" OWNER "gis_user"'
expect_in "streams the dump out of the archive" "$log" "--entrypoint tar portal-api -xzOf /app/backups/offsite-restore/backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz postgres/gratisgis.dump"
expect_in "restores in one transaction" "$log" "pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U gis_user -d portal_db"
expect_in "runs migrations" "$log" "run --rm portal-migrate"
expect_in "puts files back" "$log" "offsite-cli.js put-objects --archive /app/backups/offsite-restore/backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz"
expect_in "starts everything" "$log" "up -d"
expect_in "prints counts" "$out" "stored files         5 (the backup recorded 5)"
order="$(grep -n -E ' stop |DROP DATABASE|pg_restore|portal-migrate|put-objects|up -d$' "$tmp/log" | cut -d: -f1 | tr '\n' ' ')"
sorted="$(tr ' ' '\n' <<<"$order" | grep . | sort -n | tr '\n' ' ')"
expect_true "steps run in order" '[[ "$order" == "$sorted" ]]'

: >"$tmp/log"
: >"$tmp/stdin"
out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" FAKE_DOCKER_STDIN="$tmp/stdin" \
  FAKE_LATEST=backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz FAKE_LATEST_MIRROR=2026-11-21T02-00-00-000-bbbbbbbb \
  bash "$script" --env-file "$tmp/env" --passphrase-file "$tmp/pass" --compose-file "$tmp/compose.yml" \
  --project gg-test --confirm-project gg-test </dev/null 2>&1)"
log="$(cat "$tmp/log")"
expect_in "newer mirror run is chosen" "$log" "offsite-cli.js fetch-mirror --out /app/backups/offsite-restore --run 2026-11-21T02-00-00-000-bbbbbbbb --passphrase-stdin"
expect_in "mirror: dump read from the fetched file" "$log" "--entrypoint cat portal-api /app/backups/offsite-restore/2026-11-21T02-00-00-000-bbbbbbbb/database.dump"
expect_in "mirror: files streamed from the bucket" "$log" "offsite-cli.js put-mirror-objects --run 2026-11-21T02-00-00-000-bbbbbbbb --passphrase-stdin"

out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" bash "$script" --env-file "$tmp/env" \
  --passphrase-file "$tmp/pass" --compose-file "$tmp/compose.yml" --archive '../../etc/passwd' --list 2>&1 || true)"
expect_in "refuses a bad archive name" "$out" "--archive must be a name"

printf 'short\n' >"$tmp/short"
out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" bash "$script" --env-file "$tmp/env" \
  --passphrase-file "$tmp/short" --compose-file "$tmp/compose.yml" --list 2>&1 || true)"
expect_in "refuses a short passphrase file" "$out" "fewer than 16 characters"

if [[ "$fails" -eq 0 ]]; then
  echo "restore-from-offsite: ok"
else
  echo "restore-from-offsite: $fails failure(s)"
  exit 1
fi
