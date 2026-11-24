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
expect_true "copy uploaded again ok" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12-r2.tar.gz'
expect_true "copy attempt 999 ok" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12-r999.tar.gz'
expect_false "copy attempt 1 is the plain name" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12-r1.tar.gz'
expect_false "copy attempt 1000" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12-r1000.tar.gz'
expect_true "identifier ok" 'ggo_valid_identifier gratisgis'
expect_false "identifier quote" 'ggo_valid_identifier "a\"b"'
expect_true "kv reads a key" '[[ "$(printf "a=1\nb=2\n" | ggo_kv b)" == 2 ]]'
expect_false "archive name loose" 'ggo_valid_archive backup-x.tar.gz'
expect_false "archive name with a folder" 'ggo_valid_archive backup-2026-11-24T02-00-00-000-abcdef12.tar.gz/x'
VK_A=ggver1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
VK_B=ggver1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
VK_C=ggver1:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
FP_A=aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa
expect_true "verify key ok" 'ggo_valid_verify_key "$VK_A"'
expect_false "verify key with a quote" "ggo_valid_verify_key \"ggver1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'\""
expect_true "fingerprint ok" 'ggo_valid_fingerprint "$FP_A"'
expect_false "fingerprint loose" 'ggo_valid_fingerprint aaaa-aaaa'
kept_keys() { printf '%s\n' "${@:6}" | ggo_kept_verify_keys "$1" "$2" "$3" "$4" "$5" | tr '\n' ' '; }
expect_true "verified, signed by the backup's key: earlier keys and the backup's key kept" \
  '[[ "$(kept_keys verified "$FP_A" "$VK_A" "$VK_A" "$FP_A" "$VK_B")" == "$VK_B $VK_A " ]]'
expect_true "foreign, signed by the backup's key: kept too" \
  '[[ "$(kept_keys foreign "$FP_A" "$VK_A" "$VK_A" "$FP_A")" == "$VK_A " ]]'
expect_true "the backup's key kept once, in its newest place" \
  '[[ "$(kept_keys verified "$FP_A" "$VK_A" "$VK_A" "$FP_A" "$VK_A" "$VK_B")" == "$VK_B $VK_A " ]]'
expect_true "the checking key is added when it differs from the backup's" \
  '[[ "$(kept_keys verified "$FP_A" "$VK_C" "$VK_A" "$FP_A" "$VK_B")" == "$VK_B $VK_A $VK_C " ]]'
expect_true "another key signed the copy: only the checking key is kept" \
  '[[ "$(kept_keys verified bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb "$VK_B" "$VK_A" "$FP_A" "$VK_C")" == "$VK_B " ]]'
expect_true "foreign, another key signed the copy: the checking key is kept" \
  '[[ "$(kept_keys foreign bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb "$VK_B" "$VK_A" "$FP_A" "$VK_C")" == "$VK_B " ]]'
for state in untrusted unsigned bad; do
  expect_true "nothing kept for a $state copy" \
    "[[ -z \"\$(kept_keys $state \"\$FP_A\" \"\$VK_A\" \"\$VK_A\" \"\$FP_A\" \"\$VK_B\")\" ]]"
done
expect_true "without a backup verify key, only the checking key is kept" \
  '[[ "$(kept_keys verified "$FP_A" "$VK_A" "" "" "$VK_B")" == "$VK_A " ]]'
expect_true "nothing kept for a bad signer fingerprint" \
  '[[ -z "$(kept_keys verified "x" "$VK_A" "$VK_A" "$FP_A" "$VK_B")" ]]'
many=()
for i in $(seq 1 25); do many+=("ggver1:$(printf 'K%02d' "$i")$(printf 'k%.0s' $(seq 1 45))"); done
expect_true "at most 20 kept, the newest" \
  '[[ "$(kept_keys verified "$FP_A" "$VK_A" "$VK_A" "$FP_A" "${many[@]}" | wc -w)" -eq 20 ]] && [[ "$(kept_keys verified "$FP_A" "$VK_A" "$VK_A" "$FP_A" "${many[@]}" | cut -d" " -f1)" == "${many[6]}" ]]'
expect_true "damaged earlier keys are dropped" \
  '[[ "$(kept_keys verified "$FP_A" "$VK_A" "$VK_A" "$FP_A" "x'"'"'; DROP TABLE y" "$VK_B")" == "$VK_B $VK_A " ]]'
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
  *"offsite-cli.js check-key "*)
    stdin_if_any; [ -n "${FAKE_BAD_KEY:-}" ] && exit 1
    printf 'fingerprint=8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184\nverifyKeys=%s\n' "${FAKE_VERIFY_COUNT:-1}"
    [ "${FAKE_VERIFY_COUNT:-1}" != 0 ] && printf 'verifyKey=058d-7940-89ab-a15b-eb25-76ac-2168-1b43\n'
    true ;;
  *"offsite-cli.js list "*) printf 'prefix=gratisgis-0f1e2d3c/\nlatest=%s\n' "$FAKE_LATEST" ;;
  *"offsite-cli.js describe "*)
    stdin_if_any
    sig="${FAKE_SIG:-verified}"
    if [ "$sig" = bad ]; then echo "offsite: Refusing this copy: The signature does not verify." >&2; exit 1; fi
    case "$sig" in
      foreign) flag=--allow-foreign-install ;;
      untrusted) flag=--allow-untrusted-signer ;;
      unsigned) flag=--allow-unsigned-copy ;;
      *) flag="" ;;
    esac
    if [ -n "$flag" ]; then
      case "$args" in
        *" $flag "*) ;;
        *) echo "offsite: No verified copy was found. To restore it anyway, pass $flag." >&2; printf 'needs=%s\n' "$sig"; exit 3 ;;
      esac
    fi
    name="$FAKE_LATEST"
    case "$args" in
      *" --name "*) name="${args#* --name }"; name="${name%% *}" ;;
    esac
    printf 'prefix=gratisgis-0f1e2d3c/\nname=%s\ncreated=2026-11-24T02:00:00.000Z\nuploaded=2026-11-24T02:05:00.000Z\nbytes=3221225472\nfingerprint=%s\n' \
      "$name" "${FAKE_COPY_FP:-8ecb-27c4-5ca4-dba4-eef7-c151-2d36-d184}"
    printf 'signature=%s\n' "$sig"
    [ "$sig" = untrusted ] && [ -n "${FAKE_SIGNER:-}" ] && printf 'claimedSigner=%s\n' "$FAKE_SIGNER"
    signer_key="${FAKE_SIGNER_KEY:-ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX}"
    [ "$sig" = verified ] && printf 'signedBy=058d-7940-89ab-a15b-eb25-76ac-2168-1b43\nsignedByKey=%s\ninstall=0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f0\n' "$signer_key"
    [ "$sig" = foreign ] && printf 'signedBy=058d-7940-89ab-a15b-eb25-76ac-2168-1b43\nsignedByKey=%s\ninstall=99998888-4b5a-4978-8695-a4b3c2d1e0f0\n' "$signer_key"
    [ -n "${FAKE_SUSPECT:-}" ] && printf 'suspect=%s\n' "$FAKE_SUSPECT"
    true ;;
  *"offsite-cli.js fetch "*) stdin_if_any; printf 'archive=/app/backups/offsite-restore/%s\ndatabase=gratisgis\nobjects=5\n' "$FAKE_LATEST" ;;
  *"offsite-cli.js put-objects "*) printf 'objects=5\n' ;;
  *"offsite-cli.js count-objects "*) printf 'objects=5\n' ;;
  *"FROM pg_database WHERE datname"*) printf '%s\n' "${FAKE_DB_EXISTS:-1}" ;;
  *"information_schema.tables"*) printf '3\n' ;;
  *"AS counts"*) printf '%s\n' "${FAKE_COUNTS:-1 0 25}" ;;
  *" pg_dump "*) [ -n "${FAKE_DUMP_FAILS:-}" ] && exit 1; printf 'PGDMPFAKE' ;;
  *"pg_restore -l"*) cat >/dev/null; [ -n "${FAKE_SAFETY_UNREADABLE:-}" ] && exit 1; true ;;
  *" pg_restore "*) cat >/dev/null ;;
  *"SELECT count(*)"*) printf '3\n' ;;
  *"SELECT offsite_verify_key FROM"*) printf '%s\n' "${FAKE_DUMP_KEY-ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX}" ;;
  *"verify-key-fingerprint-v1"*) printf '%s\n' "${FAKE_DUMP_FP_HEX:-058d794089aba15beb2576ac21681b43}" ;;
  *"unnest(COALESCE(offsite_previous_verify_keys"*) printf '%s\n' ${FAKE_DUMP_PREVIOUS:-} ;;
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

expect_in "shows the copy before asking" "$out" "Copy:      $A"
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
expect_in "without a terminal the copy must be named" "$out" "name the copy with --archive (see --list)"
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
expect_in "describes the copy with the key, which holds the verify keys" "$log" "offsite-cli.js describe --key-stdin --name $A"
expect_in "lists the trusted verify keys" "$out" "Verify key:      058d-7940-89ab-a15b-eb25-76ac-2168-1b43"
expect_in "says which verify key signed the copy" "$out" "Signed by: 058d-7940-89ab-a15b-eb25-76ac-2168-1b43 (verified with your key file; portal install 0f1e2d3c)"
expect_not_in "a verified copy needs no flag" "$log" "--allow-"
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
expect_in "turns off-site copies off on the new server" "$log" "UPDATE backup_config SET offsite_enabled = false"
expect_in "gives the new server a new install id" "$log" "offsite_install_id = NULL"
expect_in "never keeps the signing key from the backup" "$log" "offsite_signing_key_encrypted = NULL, offsite_signing_key_iv = NULL, offsite_verify_key = NULL"
expect_in "keeps the verify key that checked the copy as an earlier key" "$log" "offsite_previous_verify_keys = ARRAY['ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX']::text[]"
expect_in "says the earlier key was kept" "$out" "Kept 1 earlier verify key(s) of this portal"
expect_in "says to add the new verify key" "$out" "This server makes its own signing key"
expect_in "keeps the folder it restored from" "$log" "offsite_prefix = COALESCE(offsite_prefix, 'gratisgis-0f1e2d3c/')"
expect_in "says how to take over the folder" "$out" "Take over this folder"
expect_in "puts files back" "$log" "offsite-cli.js put-objects --archive /app/backups/offsite-restore/$A"
expect_in "starts everything" "$log" "up -d"
expect_in "prints counts" "$out" "stored files         5 (the backup recorded 5)"
order="$(grep -n -E 'check-key|describe| stop |pg_dump -Fc|pg_restore -l|DROP DATABASE|pg_restore --no-owner|portal-migrate|offsite_enabled = false|put-objects|up -d$' "$tmp/log" | cut -d: -f1 | tr '\n' ' ')"
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

FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_DUMP_PREVIOUS="$VK_B $VK_B")"
expect_in "a verified copy keeps the backup's earlier keys once, then its verify key" "$(cat "$tmp/log")" "offsite_previous_verify_keys = ARRAY['$VK_B','ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX']::text[]"
out="$(run_flow FAKE_LATEST=$A FAKE_DUMP_FP_HEX=ffffffffffffffffffffffffffffffff FAKE_DUMP_PREVIOUS="$VK_B")"
expect_in "a backup verify key that did not sign the copy is not kept; the checking key is" "$(cat "$tmp/log")" "offsite_previous_verify_keys = ARRAY['ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX']::text[]"
expect_in "says one key was kept" "$out" "Kept 1 earlier verify key(s)"
out="$(run_flow FAKE_LATEST=$A FAKE_SIGNER_KEY="$VK_C" FAKE_DUMP_PREVIOUS="$VK_B")"
expect_in "the checking key is kept too when it differs" "$(cat "$tmp/log")" "offsite_previous_verify_keys = ARRAY['$VK_B','ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX','$VK_C']::text[]"
out="$(run_flow FAKE_LATEST=$A FAKE_DUMP_KEY= FAKE_DUMP_PREVIOUS="$VK_B")"
expect_in "a backup without a verify key keeps only the checking key" "$(cat "$tmp/log")" "offsite_previous_verify_keys = ARRAY['ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX']::text[]"

A2=backup-2026-11-24T02-00-00-000-aaaaaaaa-r2.tar.gz
FLOW_ARGS=(--confirm-database portal_db --archive "$A2")
out="$(run_flow FAKE_LATEST=$A2)"
expect_in "a copy uploaded again under a new name is fetched by that name" "$(cat "$tmp/log")" "offsite-cli.js fetch --key-stdin --out /app/backups/offsite-restore --name $A2 --confirm-copy $A2"

# --- signatures ---------------------------------------------------
FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=unsigned)"
log="$(cat "$tmp/log")"
expect_in "an unsigned copy is refused without its flag" "$out" "To restore this one anyway, pass --allow-unsigned-copy"
expect_not_in "nothing fetched for a refused unsigned copy" "$log" "offsite-cli.js fetch"
expect_not_in "nothing stopped for a refused unsigned copy" "$log" " stop "

for other in --allow-foreign-install --allow-untrusted-signer; do
  FLOW_ARGS=(--confirm-database portal_db --archive "$A" "$other")
  out="$(run_flow FAKE_LATEST=$A FAKE_SIG=unsigned)"
  expect_in "$other does not admit an unsigned copy" "$out" "pass --allow-unsigned-copy"
  expect_not_in "nothing stopped with $other for an unsigned copy" "$(cat "$tmp/log")" " stop "
done

FLOW_ARGS=(--confirm-database portal_db --archive "$A" --allow-unsigned-copy)
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=unsigned)"
log="$(cat "$tmp/log")"
expect_in "with the flag, the helper is told" "$log" "offsite-cli.js describe --key-stdin --name $A --allow-unsigned-copy"
expect_in "with the flag, the state is named" "$out" "State:     NOT SIGNED"
expect_in "with the flag, says what was not checked" "$out" "Not checked: who made it. Nothing proves your portal made this copy."
expect_in "with the flag, fetch checks again with the flag" "$log" "offsite-cli.js fetch --key-stdin --out /app/backups/offsite-restore --name $A --confirm-copy $A --allow-unsigned-copy"
expect_in "with the flag, the restore goes on" "$log" "pg_restore --no-owner"
expect_in "an unsigned copy keeps no verify key from the backup" "$log" "offsite_previous_verify_keys = ARRAY[]::text[]"

FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=untrusted FAKE_SIGNER=aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111)"
expect_in "an untrusted signer is refused without its flag" "$out" "pass --allow-untrusted-signer"
expect_not_in "nothing stopped for an untrusted signer" "$(cat "$tmp/log")" " stop "
FLOW_ARGS=(--confirm-database portal_db --archive "$A" --allow-untrusted-signer)
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=untrusted FAKE_SIGNER=aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111)"
expect_in "an untrusted signer is a claim, not checked" "$out" "Signature: claims the verify key aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111 (not checked: your key file does not hold it)"
expect_in "an untrusted signer state is named" "$out" "State:     SIGNER NOT CHECKED"
expect_not_in "an untrusted signer is never shown as the signer" "$out" "Signed by: aaaa"
expect_not_in "no hint to trust an unchecked key" "$out" "trust aaaa"

FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=foreign)"
expect_in "a copy for another install is refused without its flag" "$out" "pass --allow-foreign-install"
FLOW_ARGS=(--confirm-database portal_db --archive "$A" --allow-foreign-install)
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=foreign)"
expect_in "a foreign copy names its state" "$out" "State:     SIGNED FOR ANOTHER PORTAL INSTALL"
expect_in "a foreign copy is checked against the signed record" "$out" "Checked:   size and SHA-256 of the copy, against the signed record"
expect_in "a foreign copy says what was not checked" "$out" "Not checked: that the portal this folder belongs to made it"
expect_in "a foreign copy restores with its flag" "$(cat "$tmp/log")" "pg_restore --no-owner"
expect_in "a foreign copy keeps the key that checked it" "$(cat "$tmp/log")" "offsite_previous_verify_keys = ARRAY['ggver1:6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iyRs4KX']::text[]"

FLOW_ARGS=(--confirm-database portal_db --archive "$A" --allow-foreign-install --allow-untrusted-signer --allow-unsigned-copy)
out="$(run_flow FAKE_LATEST=$A FAKE_SIG=bad)"
expect_in "a bad signature is never restored, even with every flag" "$out" "could not find a copy to restore"
expect_not_in "nothing stopped for a bad signature" "$(cat "$tmp/log")" " stop "

FLOW_ARGS=(--confirm-database portal_db --archive "$A")
out="$(run_flow FAKE_LATEST=$A FAKE_VERIFY_COUNT=0 FAKE_SIG=untrusted)"
expect_in "a key file without verify keys says how to add one" "$out" "Verify keys:     none."
expect_in "and its copies need the untrusted-signer flag" "$out" "pass --allow-untrusted-signer"

# In a terminal, each state asks for its own word. `script` gives the
# restore a terminal; the typed word comes on its input.
prompt_flow() {
  : >"$tmp/log"
  : >"$tmp/stdin"
  local cmd
  printf -v cmd '%q ' env PATH="$tmp/bin:$PATH" FAKE_DOCKER_LOG="$tmp/log" \
    FAKE_DOCKER_STDIN="$tmp/stdin" FAKE_LATEST="$A" FAKE_SIG="$1" FAKE_SIGNER=aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111 \
    bash "$script" --env-file "$tmp/env" --key-file "$tmp/portal.ggkey" --passphrase-file "$tmp/pass" \
    --compose-file "$tmp/compose.yml" --project gg-test --confirm-database portal_db --archive "$A"
  printf '%s\n' "$2" | timeout 60 script -qec "$cmd" /dev/null 2>&1 || true
}
if command -v script >/dev/null 2>&1; then
  for pair in foreign:FOREIGN untrusted:UNTRUSTED unsigned:UNSIGNED; do
    state="${pair%%:*}"
    word="${pair#*:}"
    out="$(prompt_flow "$state" "$word")"
    expect_in "$state: the prompt asks for $word" "$out" "Type $word to use it anyway"
    expect_in "$state: typing $word goes on" "$(cat "$tmp/log")" "pg_restore --no-owner"
    expect_in "$state: the helper is told its flag" "$(cat "$tmp/log")" "describe --key-stdin --name $A $(ggo_allow_flag "$state")"
    for wrong in UNVERIFIED FOREIGN UNTRUSTED UNSIGNED; do
      [[ "$wrong" == "$word" ]] && continue
      out="$(prompt_flow "$state" "$wrong")"
      expect_in "$state: typing $wrong is not enough" "$out" "not confirmed; nothing was changed"
      expect_not_in "$state: nothing stopped after $wrong" "$(cat "$tmp/log")" " stop "
    done
  done
else
  echo "skip the terminal prompt checks: no script command"
fi

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
