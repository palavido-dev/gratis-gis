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
expect_false "archive name loose" 'ggo_valid_archive backup-x.tar.gz'
expect_false "archive name with a folder" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12.tar.gz/x'
expect_false "mirror run loose" 'ggo_valid_mirror_run 2026-11-24T0-abcdef12'
expect_true "prefix ok" 'ggo_valid_prefix gratisgis-0f1e2d3c/'
expect_true "nested prefix ok" 'ggo_valid_prefix backups/site-a/portal/'
expect_false "prefix with a quote" "ggo_valid_prefix \"a'b/\""
expect_false "prefix with dot dot" 'ggo_valid_prefix a/../b/'
expect_false "empty prefix" 'ggo_valid_prefix ""'
expect_true "size in GB" '[[ "$(ggo_size 3221225472)" == "3.0 GB" ]]'
expect_true "size in MB" '[[ "$(ggo_size 1048577)" == "2 MB" ]]'

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
  *"offsite-cli.js check-key "*) stdin_if_any; [ -n "${FAKE_BAD_KEY:-}" ] && exit 1; printf 'fingerprint=8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184\n' ;;
  *"offsite-cli.js list "*) printf 'prefix=gratisgis-0f1e2d3c/\nlatest=%s\n' "$FAKE_LATEST"; [ -n "${FAKE_LATEST_MIRROR:-}" ] && printf 'latestMirror=%s\n' "$FAKE_LATEST_MIRROR"; true ;;
  *"offsite-cli.js describe "*)
    kind=archive; name="$FAKE_LATEST"
    case "$args" in
      *" --name "*) name="${args#* --name }"; name="${name%% *}" ;;
      *" --run "*) kind=mirror; name="${args#* --run }"; name="${name%% *}" ;;
      *) [ -n "${FAKE_LATEST_MIRROR:-}" ] && { kind=mirror; name="$FAKE_LATEST_MIRROR"; } ;;
    esac
    printf 'prefix=gratisgis-0f1e2d3c/\nkind=%s\nname=%s\ncreated=2026-11-24T02:00:00.000Z\nuploaded=2026-11-24T02:05:00.000Z\nbytes=3221225472\nfingerprint=%s\n' \
      "$kind" "$name" "${FAKE_COPY_FP:-8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184}"
    [ -n "${FAKE_SUSPECT:-}" ] && printf 'suspect=%s\n' "$FAKE_SUSPECT"
    true ;;
  *"offsite-cli.js fetch-mirror "*) stdin_if_any; printf 'run=%s\ndump=/app/backups/offsite-restore/%s/database.dump\ndatabase=gratisgis\nobjects=7\n' "$FAKE_LATEST_MIRROR" "$FAKE_LATEST_MIRROR" ;;
  *"offsite-cli.js fetch "*) stdin_if_any; printf 'archive=/app/backups/offsite-restore/%s\ndatabase=gratisgis\nobjects=5\n' "$FAKE_LATEST" ;;
  *"offsite-cli.js put-mirror-objects "*) stdin_if_any; printf 'objects=7\n' ;;
  *"offsite-cli.js put-objects "*) printf 'objects=5\n' ;;
  *"offsite-cli.js count-objects "*) printf 'objects=5\n' ;;
  *"FROM pg_database WHERE datname"*) printf '%s\n' "${FAKE_DB_EXISTS:-1}" ;;
  *"information_schema.tables"*) printf '3\n' ;;
  *"AS counts"*) printf '%s\n' "${FAKE_COUNTS:-1 0 25}" ;;
  *" pg_dump "*) [ -n "${FAKE_DUMP_FAILS:-}" ] && exit 1; printf 'PGDMPFAKE' ;;
  *"pg_restore -l"*) cat >/dev/null; [ -n "${FAKE_SAFETY_UNREADABLE:-}" ] && exit 1; true ;;
  *" pg_restore "*) cat >/dev/null ;;
  *"SELECT count(*)"*) printf '3\n' ;;
  *) [ -t 0 ] || cat >/dev/null ;;
esac
EOF
chmod +x "$tmp/bin/docker"
printf 'my key file passphrase value 42\r\n' >"$tmp/pass"
printf 'GRCV2 sealed key bytes' >"$tmp/portal.ggkey"
chmod 600 "$tmp/pass" "$tmp/portal.ggkey"
touch "$tmp/compose.yml"

run_flow() {
  : >"$tmp/log"
  : >"$tmp/stdin"
  env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" FAKE_DOCKER_STDIN="$tmp/stdin" "$@" \
    bash "$script" --env-file "$tmp/env" --key-file "$tmp/portal.ggkey" --passphrase-file "$tmp/pass" \
    --compose-file "$tmp/compose.yml" --project gg-test "${FLOW_ARGS[@]}" </dev/null 2>&1 || true
}
A=backup-2026-11-24T02-00-00-000-aaaaaaaa.tar.gz

FLOW_ARGS=()
out="$(run_flow FAKE_LATEST=$A)"
expect_in "refuses without typed confirmation" "$out" "pass --confirm-database portal_db"
expect_not_in "nothing dropped without confirmation" "$(cat "$tmp/log")" "DROP DATABASE"
expect_not_in "nothing stopped without confirmation" "$(cat "$tmp/log")" " stop "
expect_in "prints the target" "$out" "Database:  portal_db (user gis_user)"
expect_in "prints the counts" "$out" "It holds 1 organization(s), 0 user(s) and 25 item(s)."

expect_in "shows the copy before asking" "$out" "Copy:      $A (archive)"
expect_in "shows the copy date" "$out" "Made:      2026-11-24T02:00:00.000Z"
expect_in "shows the copy size" "$out" "Size:      3.0 GB encrypted"
expect_in "shows the copy key" "$out" "Key:       8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184"
expect_in "advises a copy from before an incident" "$out" "Restore a copy made before any suspected"
expect_not_in "nothing downloaded before confirmation" "$(cat "$tmp/log")" "offsite-cli.js fetch"

FLOW_ARGS=(--confirm-database other_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A)"
expect_in "refuses a confirmation for another database" "$out" "does not match the database portal_db"

FLOW_ARGS=(--confirm-database portal_db)
out="$(run_flow FAKE_LATEST=$A)"
expect_in "without a terminal the copy must be named" "$out" "name the copy with --archive or --mirror-run"
expect_not_in "nothing fetched when the copy is not named" "$(cat "$tmp/log")" "offsite-cli.js fetch"

FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_COPY_FP=aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa)"
expect_in "a copy for another key stops before anything changes" "$out" "encrypted to the key aaaa-aaaa"
expect_not_in "nothing stopped for a copy for another key" "$(cat "$tmp/log")" " stop "

out="$(run_flow FAKE_LATEST=$A FAKE_SUSPECT=future FAKE_DB_EXISTS=0)"
expect_in "a named copy dated in the future is flagged" "$out" "WARNING: this copy is dated in the future."

out="$(run_flow FAKE_LATEST=$A FAKE_COUNTS='2 14 300')"
expect_in "refuses a database in use" "$out" "this database is in use (it has users). Pass --replace-existing"
expect_not_in "nothing dropped for a database in use" "$(cat "$tmp/log")" "DROP DATABASE"

out="$(run_flow FAKE_LATEST=$A FAKE_BAD_KEY=1)"
expect_in "a key file that does not open stops everything" "$out" "the key file did not open"
expect_not_in "nothing stopped for a bad key" "$(cat "$tmp/log")" " stop "

out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" FAKE_DOCKER_STDIN="$tmp/stdin" FAKE_LATEST=$A \
  bash "$script" --env-file "$tmp/env" --compose-file "$tmp/compose.yml" --project gg-test --list </dev/null 2>&1)"
expect_in "list needs no key and prints the newest copy" "$out" "latest=$A"

FLOW_ARGS=(--confirm-database portal_db --replace-existing --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_COUNTS='2 14 300')"
log="$(cat "$tmp/log")"
expect_in "opens the key first, key and passphrase on stdin" "$log" "portal-api dist/backup/offsite-cli.js check-key --key-stdin"
expect_in "the key file arrived on stdin in base64" "$(cat "$tmp/stdin")" "$(base64 -w0 <"$tmp/portal.ggkey")"
expect_not_in "the key file is not mounted" "$log" "portal.ggkey"
expect_in "prints the key fingerprint" "$out" "Key fingerprint: 8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184"
expect_in "describes the copy without the key" "$log" "offsite-cli.js describe --name $A"
expect_in "archive: fetches the confirmed copy by name" "$log" "offsite-cli.js fetch --key-stdin --out /app/backups/offsite-restore --name $A --confirm-copy $A"
expect_in "archive: passphrase arrived on stdin" "$(cat "$tmp/stdin")" "my key file passphrase value 42"
expect_not_in "passphrase never an argument" "$log" "my key file passphrase"
expect_not_in "passphrase never printed" "$out" "my key file passphrase"
expect_in "stops writers" "$log" "stop portal-api portal-web"
expect_not_in "keeps the database running" "$(grep ' stop ' <<<"$log")" "postgres"
expect_in "saves the current database first" "$log" "exec -T postgres pg_dump -Fc -U gis_user -d portal_db"
expect_in "checks the saved copy reads back" "$log" 'test -s "$1" && pg_restore -l "$1"'
expect_in "says where the saved copy is" "$out" "The database as it was is saved in the backups volume: /app/backups/offsite-restore/pre-restore-portal_db-"
expect_in "drops and recreates the database from the env file" "$log" 'DROP DATABASE IF EXISTS "portal_db" WITH (FORCE)'
expect_in "creates it owned by the env user" "$log" 'CREATE DATABASE "portal_db" OWNER "gis_user"'
expect_in "streams the dump out of the archive" "$log" "--entrypoint tar portal-api -xzOf /app/backups/offsite-restore/$A postgres/gratisgis.dump"
expect_in "restores in one transaction" "$log" "pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U gis_user -d portal_db"
expect_in "runs migrations" "$log" "run --rm portal-migrate"
expect_in "empties the local index of mirrored files" "$log" "TRUNCATE backup_offsite_object"
expect_in "turns off-site copies off on the new server" "$log" "UPDATE backup_config SET offsite_enabled = false"
expect_in "gives the new server a new install id" "$log" "offsite_install_id = NULL"
expect_in "keeps the folder it restored from" "$log" "offsite_prefix = COALESCE(offsite_prefix, 'gratisgis-0f1e2d3c/')"
expect_in "says how to take over the folder" "$out" "Take over this folder"
expect_in "puts files back" "$log" "offsite-cli.js put-objects --archive /app/backups/offsite-restore/$A"
expect_in "starts everything" "$log" "up -d"
expect_in "prints counts" "$out" "stored files         5 (the backup recorded 5)"
order="$(grep -n -E 'check-key|describe| stop |pg_dump -Fc|pg_restore -l|DROP DATABASE|pg_restore --no-owner|portal-migrate|TRUNCATE|put-objects|up -d$' "$tmp/log" | cut -d: -f1 | tr '\n' ' ')"
sorted="$(tr ' ' '\n' <<<"$order" | grep . | sort -n | tr '\n' ' ')"
expect_true "steps run in order" '[[ "$order" == "$sorted" ]]'
expect_true "every step ran" '[[ "$(wc -w <<<"$order")" -eq 11 ]]'

FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_DUMP_FAILS=1)"
expect_in "a failed safety dump stops before the drop" "$out" "could not save the current database, or the saved copy does not read back; nothing was dropped"
expect_not_in "nothing dropped when the safety dump fails" "$(cat "$tmp/log")" "DROP DATABASE"

out="$(run_flow FAKE_LATEST=$A FAKE_SAFETY_UNREADABLE=1)"
expect_in "a safety dump that does not read back stops before the drop" "$out" "nothing was dropped"
expect_not_in "nothing dropped when the safety dump does not read back" "$(cat "$tmp/log")" "DROP DATABASE"

out="$(run_flow FAKE_LATEST=$A FAKE_DB_EXISTS=0)"
expect_in "a new database is said to be new" "$out" "It does not exist yet."
expect_not_in "no safety dump of a database that does not exist" "$(cat "$tmp/log")" "pg_dump -Fc"

FLOW_ARGS=(--confirm-database portal_db --mirror-run 2026-11-21T02-00-00-000-bbbbbbbb)
out="$(run_flow FAKE_LATEST=backup-2026-11-20T02-00-00-000-aaaaaaaa.tar.gz FAKE_LATEST_MIRROR=2026-11-21T02-00-00-000-bbbbbbbb)"
log="$(cat "$tmp/log")"
expect_in "mirror: the named run is described" "$log" "offsite-cli.js describe --run 2026-11-21T02-00-00-000-bbbbbbbb"
expect_in "mirror run is fetched once confirmed" "$log" "offsite-cli.js fetch-mirror --key-stdin --out /app/backups/offsite-restore --run 2026-11-21T02-00-00-000-bbbbbbbb --confirm-copy 2026-11-21T02-00-00-000-bbbbbbbb"
expect_in "mirror: dump read from the fetched file" "$log" "--entrypoint cat portal-api /app/backups/offsite-restore/2026-11-21T02-00-00-000-bbbbbbbb/database.dump"
expect_in "mirror: files streamed from the bucket" "$log" "offsite-cli.js put-mirror-objects --key-stdin --run 2026-11-21T02-00-00-000-bbbbbbbb"

out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" bash "$script" --env-file "$tmp/env" \
  --compose-file "$tmp/compose.yml" --archive '../../etc/passwd' --list 2>&1 || true)"
expect_in "refuses a bad archive name" "$out" "--archive must be a name"

out="$(env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" bash "$script" --env-file "$tmp/env" \
  --compose-file "$tmp/compose.yml" --passphrase-file "$tmp/pass" 2>&1 || true)"
expect_in "a restore needs the key file" "$out" "--key-file must name your private key file"

if [[ "$fails" -eq 0 ]]; then
  echo "restore-from-offsite: ok"
else
  echo "restore-from-offsite: $fails failure(s)"
  exit 1
fi
