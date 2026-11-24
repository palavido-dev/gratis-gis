#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Bring a portal back from an off-site backup copy on a new server.
#
#   infra/restore-from-offsite.sh --env-file infra/.env.prod --list
#
#   infra/restore-from-offsite.sh --env-file infra/.env.prod \
#     --key-file /root/portal.ggkey --passphrase-file /root/portal.ggkey.pass \
#     [--archive NAME | --mirror-run NAME] [--replace-existing] \
#     [--confirm-database NAME] [--allow-foreign-install] \
#     [--allow-untrusted-signer] [--allow-unsigned-copy]
#
# Before you run it: install GratisGIS on the new server with the
# installer (same release as the backup, or newer), and add the
# BACKUP_OFFSITE_* bucket settings to the env file. Put back the
# original CREDENTIAL_ENCRYPTION_KEY if you have it, or stored
# credentials for external services cannot be decrypted. Copy your
# private key file (made by infra/recovery/offsite-key.mjs) to this
# server, and its passphrase into a file only root can read.
#
# What it does, in order:
#   1. Open the key file with the passphrase, before anything else, and
#      list the verify keys it trusts.
#   2. Check the copy's signature against those verify keys. Show the
#      copy it will use (its name, date, size, the key it was encrypted
#      to and the verify key that signed it) and what will be replaced (project, database,
#      row counts), and ask you to type the database name. Nothing has
#      changed before this point. A database that is in use (it has
#      users) is refused unless you pass --replace-existing. Without a
#      terminal, --confirm-database also needs the copy named with
#      --archive or --mirror-run.
#   3. Download that copy into the backups volume, check its size and
#      SHA-256 against the signed record, and only then decrypt it. For
#      a mirror run, also check that every file its index lists is in
#      the bucket with the recorded size. Nothing has changed before
#      this point. The work runs in the portal-api image, which already
#      has the tools.
#   4. Stop the portal's own services (not the database or MinIO).
#   5. Save the current database with pg_dump into the backups volume,
#      check the saved file reads back, then replace the database: drop
#      it, create it empty, and restore the dump in one transaction that
#      stops on the first error.
#   6. Run the database migrations, so an older backup matches this code.
#   7. Empty this server's index of mirrored files, give this server a
#      new off-site install id and turn off-site copies off, so it never
#      cleans up the bucket by mistake. Remove the signing key that came
#      with the backup: this server makes its own, whose verify key you
#      add to your key file. To make it the portal in use, turn off-site
#      copies on again on Admin, Backup and take over the folder.
#   8. Put the stored files back into MinIO.
#   9. Start everything and print counts next to the backup's own.
#
# A copy dated in the future, or well after the provider recorded it,
# is never picked as the newest; it is used only when named.
#
# Signatures: the newest copy whose signature verifies, for the portal
# install this folder belongs to, is used. Without one, the newest copy
# in the first of these states is offered, and used only with its own
# flag, or, in a terminal, after you type its word:
#   signed with a key in your key file, but for another portal install:
#     --allow-foreign-install, or type FOREIGN
#   naming a verify key your key file does not hold (not checked):
#     --allow-untrusted-signer, or type UNTRUSTED
#   not signed (made before signing existed):
#     --allow-unsigned-copy, or type UNSIGNED
# A flag admits only its own state. A copy whose signature does not
# verify is never used.
#
# The key file and the passphrase file are given to the restore helper
# on standard input. Neither is ever an argument, an environment
# variable or printed. One trailing line break (LF or CRLF) is ignored, and
# the text is normalised to Unicode NFC, as offsite-key.mjs does. The
# download and the unpacked files need about twice the archive size of
# free disk in the backups volume.
set -euo pipefail

ENV_FILE=""
KEY_FILE=""
PASS_FILE=""
COMPOSE_FILE=""
PROJECT="${GRATIS_RESTORE_PROJECT:-gratis-gis-prod}"
CONFIRM_DB=""
REPLACE_EXISTING=0
ARCHIVE=""
MIRROR_RUN=""
LIST_ONLY=0
ALLOW_FOREIGN=0
ALLOW_UNTRUSTED=0
ALLOW_UNSIGNED=0
OUT_DIR="/app/backups/offsite-restore"
# Services this script stops and starts. The database, MinIO and the
# proxy keep running.
WRITERS="portal-api portal-worker script-runner script-executor pointcloud-worker portal-web"

ggo_die() {
  echo "restore-from-offsite: $*" >&2
  exit 1
}

# Value of KEY in an env file, without sourcing it. Strips matching
# quotes. Prints nothing when the key is absent.
ggo_env_value() {
  local file="$1" key="$2" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [[ -z "$line" ]] && return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s\n' "$value"
}

# An archive name exactly as the portal writes it.
ggo_valid_archive() {
  [[ "$1" =~ ^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}-[0-9a-f]{8}\.tar\.gz$ ]]
}

# A mirror run folder name: <time stamp>-<8 hex>.
ggo_valid_mirror_run() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}-[0-9a-f]{8}$ ]]
}

# A bucket folder as the portal writes it: plain path parts, ending in "/".
# Same rule as isValidOffsitePrefix in apps/portal-api/src/backup/offsite-config.ts.
ggo_valid_prefix() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/$ ]] && [[ ! "$1" =~ (^|/)\.\.?/ ]]
}

# A database or role name safe to put inside double or single quotes in SQL.
ggo_valid_identifier() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]
}

# Value of KEY from key=value lines on stdin.
ggo_kv() {
  local key="$1" line
  while IFS= read -r line; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s\n' "${line#*=}"
      return 0
    fi
  done
  return 0
}

# Bytes as a short human figure.
ggo_size() {
  local b="$1"
  if [[ ! "$b" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$b"
  elif (( b >= 1073741824 )); then
    printf '%s.%s GB\n' "$(( b / 1073741824 ))" "$(( b % 1073741824 * 10 / 1073741824 ))"
  else
    printf '%s MB\n' "$(( (b + 1048575) / 1048576 ))"
  fi
}

ggo_compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Run the off-site helper in the portal-api image. No dependencies are
# started; MinIO is addressed on the compose network directly.
ggo_cli() {
  ggo_compose run --rm -T --no-deps --entrypoint node \
    -e MINIO_ENDPOINT=http://minio:9000 \
    portal-api dist/backup/offsite-cli.js "$@"
}

# The same, with the key file (base64, one line) and then the
# passphrase file on standard input. Nothing of either is an argument
# or an environment variable, and the container's own user does not
# need to read a file only root can.
ggo_cli_key() {
  local cmd="$1"
  shift
  { base64 -w0 <"$KEY_FILE"; printf '\n'; cat "$PASS_FILE"; } |
    ggo_compose run --rm -T --no-deps --entrypoint node \
      -e MINIO_ENDPOINT=http://minio:9000 \
      portal-api dist/backup/offsite-cli.js "$cmd" --key-stdin "$@"
}

ggo_psql() {
  local db="$1"
  shift
  ggo_compose exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$db" "$@"
}

ggo_usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
}

# The flag that admits one state of a copy that is not verified.
ggo_allow_flag() {
  case "$1" in
    foreign) echo "--allow-foreign-install" ;;
    untrusted) echo "--allow-untrusted-signer" ;;
    unsigned) echo "--allow-unsigned-copy" ;;
    *) return 1 ;;
  esac
}

# The flags given so far, as arguments for the helper.
ggo_allow_args() {
  ALLOW_ARGS=()
  [[ "$ALLOW_FOREIGN" == "1" ]] && ALLOW_ARGS+=(--allow-foreign-install)
  [[ "$ALLOW_UNTRUSTED" == "1" ]] && ALLOW_ARGS+=(--allow-untrusted-signer)
  [[ "$ALLOW_UNSIGNED" == "1" ]] && ALLOW_ARGS+=(--allow-unsigned-copy)
  return 0
}

# The helper found no verified copy; the best one left is in state $1.
# In a terminal, ask for that state's word typed in full; otherwise its
# flag must be on the command line.
ggo_confirm_state() {
  local state="$1" flag word
  flag="$(ggo_allow_flag "$state")" || ggo_die "unexpected copy state: $state"
  if [[ ! -t 0 ]] || [[ ! -r /dev/tty ]]; then
    ggo_die "no verified copy (see above). To restore this one anyway, pass $flag"
  fi
  {
    echo ""
    case "$state" in
      foreign)
        word="FOREIGN"
        echo "WARNING: SIGNED FOR ANOTHER PORTAL INSTALL. The signature checks with a"
        echo "verify key in your key file, so its contents are checked against the signed"
        echo "record, but it names another portal install than the one this folder"
        echo "belongs to. Continue only if you know why."
        ;;
      untrusted)
        word="UNTRUSTED"
        echo "WARNING: SIGNER NOT CHECKED. The copy names a verify key your key file"
        echo "does not hold, so nothing proves your portal made it: anyone who could"
        echo "write to the bucket could have put it there. Continue only if you have"
        echo "not added this portal's verify key to your key file yet."
        ;;
      unsigned)
        word="UNSIGNED"
        echo "WARNING: NOT SIGNED. Nothing proves your portal made this copy: anyone"
        echo "who could write to the bucket could have put it there. Continue only"
        echo "for a copy made before signing existed."
        ;;
    esac
    printf 'Type %s to use it anyway: ' "$word"
  } >/dev/tty
  local typed
  IFS= read -r typed </dev/tty || true
  [[ "$typed" == "$word" ]] || ggo_die "not confirmed; nothing was changed"
  case "$state" in
    foreign) ALLOW_FOREIGN=1 ;;
    untrusted) ALLOW_UNTRUSTED=1 ;;
    unsigned) ALLOW_UNSIGNED=1 ;;
  esac
}

ggo_parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file) ENV_FILE="${2:-}"; shift 2 ;;
      --key-file) KEY_FILE="${2:-}"; shift 2 ;;
      --passphrase-file) PASS_FILE="${2:-}"; shift 2 ;;
      --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
      --project) PROJECT="${2:-}"; shift 2 ;;
      --confirm-database) CONFIRM_DB="${2:-}"; shift 2 ;;
      --replace-existing) REPLACE_EXISTING=1; shift ;;
      --archive) ARCHIVE="${2:-}"; shift 2 ;;
      --mirror-run) MIRROR_RUN="${2:-}"; shift 2 ;;
      --list) LIST_ONLY=1; shift ;;
      --allow-foreign-install) ALLOW_FOREIGN=1; shift ;;
      --allow-untrusted-signer) ALLOW_UNTRUSTED=1; shift ;;
      --allow-unsigned-copy) ALLOW_UNSIGNED=1; shift ;;
      -h | --help) ggo_usage; exit 0 ;;
      *) ggo_die "unknown argument: $1 (see --help)" ;;
    esac
  done
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || ggo_die "--env-file must name an existing file"
  if [[ -z "$COMPOSE_FILE" ]]; then
    COMPOSE_FILE="$(cd "$(dirname "$0")" && pwd)/docker-compose.prod.yml"
  fi
  [[ -f "$COMPOSE_FILE" ]] || ggo_die "compose file not found: $COMPOSE_FILE"
  [[ -n "$ARCHIVE" && -n "$MIRROR_RUN" ]] && ggo_die "give --archive or --mirror-run, not both"
  if [[ -n "$ARCHIVE" ]] && ! ggo_valid_archive "$ARCHIVE"; then
    ggo_die "--archive must be a name such as backup-2026-11-24T02-00-00-000-abcdef12.tar.gz"
  fi
  if [[ -n "$MIRROR_RUN" ]] && ! ggo_valid_mirror_run "$MIRROR_RUN"; then
    ggo_die "--mirror-run must be a run name as --list prints it (without mirror:)"
  fi
  if [[ "$LIST_ONLY" != "1" ]]; then
    [[ -n "$KEY_FILE" && -f "$KEY_FILE" ]] || ggo_die "--key-file must name your private key file (made by infra/recovery/offsite-key.mjs)"
    [[ -n "$PASS_FILE" && -f "$PASS_FILE" ]] || ggo_die "--passphrase-file must name a file holding the key file's passphrase"
    KEY_FILE="$(cd "$(dirname "$KEY_FILE")" && pwd)/$(basename "$KEY_FILE")"
  fi
  return 0
}

ggo_check_secret_files() {
  local f mode
  for f in "$KEY_FILE" "$PASS_FILE"; do
    mode="$(stat -c '%a' "$f" 2>/dev/null || echo 600)"
    if [[ "${mode: -1}" != "0" ]]; then
      echo "Note: $f can be read by other users of this server (mode $mode). chmod 600 it." >&2
    fi
  done
}

ggo_step() {
  echo ""
  echo "== $* =="
}

# "orgs users items" of the target database, "absent" when it does not
# exist, or "empty" when it has no portal tables.
ggo_target_state() {
  local exists tables
  exists="$(ggo_psql postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$PG_DB'" | tr -d '[:space:]')"
  if [[ "$exists" != "1" ]]; then
    echo absent
    return 0
  fi
  tables="$(ggo_psql "$PG_DB" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('organization', 'user', 'item')" | tr -d '[:space:]')"
  if [[ "$tables" != "3" ]]; then
    echo empty
    return 0
  fi
  ggo_psql "$PG_DB" -c "SELECT (SELECT count(*) FROM organization) || ' ' || (SELECT count(*) FROM \"user\") || ' ' || (SELECT count(*) FROM item) AS counts" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'
}

# Typed confirmation: --confirm-database, or the name typed on the terminal.
# Without a terminal the copy must have been named, so a script never
# restores whatever happens to be newest in the bucket.
ggo_confirm() {
  if [[ -n "$CONFIRM_DB" ]]; then
    [[ "$CONFIRM_DB" == "$PG_DB" ]] || ggo_die "--confirm-database $CONFIRM_DB does not match the database $PG_DB"
    [[ "$COPY_NAMED" == "1" ]] || ggo_die "with --confirm-database, name the copy with --archive or --mirror-run (see --list)"
    return 0
  fi
  if [[ ! -t 0 ]] || [[ ! -r /dev/tty ]]; then
    ggo_die "type the database name to confirm: run this in a terminal, or pass --confirm-database $PG_DB"
  fi
  local typed
  printf 'Type the database name (%s) to replace it: ' "$PG_DB" >/dev/tty
  IFS= read -r typed </dev/tty || true
  [[ "$typed" == "$PG_DB" ]] || ggo_die "not confirmed; nothing was changed"
}

ggo_main() {
  ggo_parse_args "$@"
  command -v docker >/dev/null 2>&1 || ggo_die "docker is required"

  if [[ "$LIST_ONLY" == "1" ]]; then
    ggo_cli list
    return 0
  fi
  ggo_check_secret_files

  PG_USER="$(ggo_env_value "$ENV_FILE" POSTGRES_USER)"
  PG_USER="${PG_USER:-gratisgis}"
  PG_DB="$(ggo_env_value "$ENV_FILE" POSTGRES_DB)"
  PG_DB="${PG_DB:-gratisgis}"
  ggo_valid_identifier "$PG_USER" || ggo_die "POSTGRES_USER has unexpected characters"
  ggo_valid_identifier "$PG_DB" || ggo_die "POSTGRES_DB has unexpected characters"

  local running
  running="$(ggo_compose ps --status running --services 2>/dev/null || true)"
  grep -qx postgres <<<"$running" || ggo_die "the postgres service of project $PROJECT is not running; install and start the stack first"

  ggo_step "1. Open the key file"
  local key_info fingerprint verify_count
  key_info="$(ggo_cli_key check-key)" || key_info=""
  fingerprint="$(ggo_kv fingerprint <<<"$key_info")"
  [[ -n "$fingerprint" ]] || ggo_die "the key file did not open; check the key file and its passphrase"
  echo "Key fingerprint: $fingerprint"
  verify_count="$(ggo_kv verifyKeys <<<"$key_info")"
  if [[ "${verify_count:-0}" == "0" ]]; then
    echo "Verify keys:     none. The key file cannot check who made a copy; add the"
    echo "                 verify key from Admin, Backup with: offsite-key.mjs trust"
  else
    local line
    while IFS= read -r line; do
      [[ "$line" == verifyKey=* ]] && echo "Verify key:      ${line#verifyKey=}"
    done <<<"$key_info"
  fi

  # Which copy: the one named, or the newest good one of either kind.
  # Nothing is downloaded or changed here.
  COPY_NAMED=0
  local describe_args=()
  if [[ -n "$ARCHIVE" ]]; then
    COPY_NAMED=1
    describe_args=(--name "$ARCHIVE")
  elif [[ -n "$MIRROR_RUN" ]]; then
    COPY_NAMED=1
    describe_args=(--run "$MIRROR_RUN")
  fi
  local described copy_kind copy_name copy_created copy_uploaded copy_bytes copy_fp copy_suspect copy_prefix
  local copy_sig copy_signer copy_claimed copy_install needs rc tries=0
  # Exit status 3 from the helper: no verified copy, and the best one
  # left needs the flag named by needs=.
  while :; do
    ggo_allow_args
    rc=0
    described="$(ggo_cli_key describe "${describe_args[@]}" "${ALLOW_ARGS[@]}")" || rc=$?
    [[ "$rc" == "3" && "$tries" -lt 3 ]] || break
    tries=$((tries + 1))
    needs="$(ggo_kv needs <<<"$described")"
    ggo_confirm_state "$needs"
  done
  [[ "$rc" == "0" ]] || ggo_die "could not find a copy to restore (see the message above)"
  copy_kind="$(ggo_kv kind <<<"$described")"
  copy_name="$(ggo_kv name <<<"$described")"
  copy_created="$(ggo_kv created <<<"$described")"
  copy_uploaded="$(ggo_kv uploaded <<<"$described")"
  copy_bytes="$(ggo_kv bytes <<<"$described")"
  copy_fp="$(ggo_kv fingerprint <<<"$described")"
  copy_suspect="$(ggo_kv suspect <<<"$described")"
  copy_prefix="$(ggo_kv prefix <<<"$described")"
  copy_sig="$(ggo_kv signature <<<"$described")"
  copy_signer="$(ggo_kv signedBy <<<"$described")"
  copy_claimed="$(ggo_kv claimedSigner <<<"$described")"
  copy_install="$(ggo_kv install <<<"$described")"
  case "$copy_sig" in
    verified) ;;
    foreign) [[ "$ALLOW_FOREIGN" == "1" ]] || ggo_die "the helper offered a copy signed for another install" ;;
    untrusted) [[ "$ALLOW_UNTRUSTED" == "1" ]] || ggo_die "the helper offered a copy whose signer is not checked" ;;
    unsigned) [[ "$ALLOW_UNSIGNED" == "1" ]] || ggo_die "the helper offered a copy that is not signed" ;;
    *) ggo_die "unexpected signature state: $copy_sig" ;;
  esac
  ggo_valid_prefix "$copy_prefix" || ggo_die "unexpected bucket folder name: $copy_prefix"
  if [[ "$copy_kind" == "mirror" ]]; then
    ggo_valid_mirror_run "$copy_name" || ggo_die "unexpected copy name"
    MIRROR_RUN="$copy_name"
    ARCHIVE=""
  else
    ggo_valid_archive "$copy_name" || ggo_die "unexpected copy name"
    ARCHIVE="$copy_name"
    MIRROR_RUN=""
  fi
  if [[ "$copy_fp" != "unknown" && "$copy_fp" != "$fingerprint" ]]; then
    ggo_die "this copy was encrypted to the key $copy_fp, not to the key file given ($fingerprint)"
  fi

  ggo_step "2. Check the copy and what it will replace"
  echo "Copy:      $copy_name ($copy_kind)"
  echo "Made:      $copy_created"
  echo "Uploaded:  $copy_uploaded"
  echo "Size:      $(ggo_size "$copy_bytes") encrypted"
  echo "Key:       $copy_fp"
  case "$copy_sig" in
    verified)
      echo "Signed by: $copy_signer (verified with your key file; portal install ${copy_install:0:8})"
      echo "Checked:   size and SHA-256 of every file, against the signed record"
      ;;
    foreign)
      echo "State:     SIGNED FOR ANOTHER PORTAL INSTALL"
      echo "Signed by: $copy_signer (verified with your key file; portal install ${copy_install:0:8},"
      echo "           not the one this folder belongs to)"
      echo "Checked:   size and SHA-256 of every file, against the signed record"
      echo "Not checked: that the portal this folder belongs to made it"
      ;;
    untrusted)
      echo "State:     SIGNER NOT CHECKED"
      echo "Signature: claims the verify key ${copy_claimed:-unknown} (not checked: your key file does not hold it)"
      echo "Checked:   only against unsigned records in the bucket, which catches damage, not a deliberate change"
      echo "Not checked: who made it. Nothing proves your portal made this copy."
      ;;
    unsigned)
      echo "State:     NOT SIGNED"
      echo "Checked:   only against unsigned records in the bucket, which catches damage, not a deliberate change"
      echo "Not checked: who made it. Nothing proves your portal made this copy."
      ;;
  esac
  if [[ -n "$copy_suspect" ]]; then
    echo ""
    echo "WARNING: this copy is dated $([[ "$copy_suspect" == "future" ]] && echo "in the future" || echo "after the provider recorded its upload")."
    echo "The portal did not make it with that date. Restore it only if you know where it came from."
  fi
  echo ""
  echo "Restore a copy made before any suspected break-in or damage. Anyone who"
  echo "could write to the bucket could have added a copy."
  echo ""
  local state orgs users items
  state="$(ggo_target_state)"
  echo "Project:   $PROJECT"
  echo "Compose:   $COMPOSE_FILE"
  echo "Database:  $PG_DB (user $PG_USER)"
  case "$state" in
    absent) echo "It does not exist yet." ;;
    empty) echo "It exists and holds no portal tables." ;;
    *)
      read -r orgs users items <<<"$state"
      echo "It holds ${orgs:-?} organization(s), ${users:-?} user(s) and ${items:-?} item(s)."
      if [[ "${users:-0}" != "0" && "$REPLACE_EXISTING" != "1" ]]; then
        ggo_die "this database is in use (it has users). Pass --replace-existing to replace it; a copy is saved first."
      fi
      ;;
  esac
  ggo_confirm

  ggo_step "3. Download and decrypt"
  local fetched dump_cmd database objects archive_path=""
  if [[ "$copy_kind" == "mirror" ]]; then
    # Also checks every file of the run is in the bucket with its size,
    # so a run that cannot be put back stops here, before any change.
    fetched="$(ggo_cli_key fetch-mirror --out "$OUT_DIR" --run "$MIRROR_RUN" --confirm-copy "$MIRROR_RUN" "${ALLOW_ARGS[@]}")"
    local dump
    dump="$(ggo_kv dump <<<"$fetched")"
    [[ "$dump" == "$OUT_DIR/"* ]] || ggo_die "unexpected dump path"
    dump_cmd=(cat "$dump")
  else
    fetched="$(ggo_cli_key fetch --out "$OUT_DIR" --name "$ARCHIVE" --confirm-copy "$ARCHIVE" "${ALLOW_ARGS[@]}")"
    archive_path="$(ggo_kv archive <<<"$fetched")"
    [[ "$archive_path" == "$OUT_DIR/"* ]] || ggo_die "unexpected archive path"
    database="$(ggo_kv database <<<"$fetched")"
    ggo_valid_identifier "$database" || ggo_die "the archive names an unexpected database"
    dump_cmd=(tar -xzOf "$archive_path" "postgres/${database}.dump")
  fi
  objects="$(ggo_kv objects <<<"$fetched")"
  echo "$fetched"

  ggo_step "4. Stop the portal services"
  local services stop=()
  services="$(ggo_compose config --services)"
  for s in $WRITERS; do
    grep -qx "$s" <<<"$services" && stop+=("$s")
  done
  ggo_compose stop "${stop[@]}"

  echo "If a later step fails, the portal stays stopped. Read the error, fix it, and run this script again."

  ggo_step "5. Save, then replace the portal database ($PG_DB)"
  if [[ "$state" != "absent" ]]; then
    local safety
    safety="$OUT_DIR/pre-restore-${PG_DB}-$(date -u +%Y%m%dT%H%M%SZ).dump"
    # The inner script takes the path as $1; it is meant not to expand here.
    # The saved file must be non-empty and list as a pg_dump archive
    # before anything is dropped.
    # shellcheck disable=SC2016
    ggo_compose exec -T postgres pg_dump -Fc -U "$PG_USER" -d "$PG_DB" |
      ggo_compose run --rm -T --no-deps --entrypoint sh portal-api \
        -c 'umask 077; mkdir -p "$(dirname "$1")" && cat >"$1" && test -s "$1" && pg_restore -l "$1" >/dev/null' sh "$safety" ||
      ggo_die "could not save the current database, or the saved copy does not read back; nothing was dropped"
    echo "The database as it was is saved in the backups volume: $safety"
  fi
  ggo_psql postgres \
    -c "DROP DATABASE IF EXISTS \"$PG_DB\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$PG_DB\" OWNER \"$PG_USER\""
  ggo_compose run --rm -T --no-deps --entrypoint "${dump_cmd[0]}" portal-api "${dump_cmd[@]:1}" |
    ggo_compose exec -T postgres pg_restore --no-owner --no-privileges --exit-on-error \
      --single-transaction -U "$PG_USER" -d "$PG_DB"

  ggo_step "6. Run the database migrations"
  ggo_compose run --rm portal-migrate

  ggo_step "7. Reset the off-site state"
  # A new install id (the portal makes one on next use): this server
  # does not own the bucket folder until an admin takes it over. The
  # folder restored from is kept as the setting, since the default
  # folder name comes from the install id. The signing key that came
  # with the dump is removed, never reused: this server makes its own.
  # Its verify key is kept as an earlier key, so copies the old server
  # signed still count for retention once this server takes over.
  ggo_psql "$PG_DB" \
    -c "TRUNCATE backup_offsite_object, backup_offsite_mirror_run" \
    -c "UPDATE backup_config SET offsite_enabled = false, offsite_install_id = NULL, offsite_prefix = COALESCE(offsite_prefix, '$copy_prefix')" \
    -c "UPDATE backup_config SET offsite_previous_verify_keys = array_append(COALESCE(offsite_previous_verify_keys, ARRAY[]::text[]), offsite_verify_key) WHERE offsite_verify_key IS NOT NULL" \
    -c "UPDATE backup_config SET offsite_signing_key_encrypted = NULL, offsite_signing_key_iv = NULL, offsite_verify_key = NULL, offsite_signing_key_changed_at = NULL, offsite_signing_key_changed_by = NULL"
  echo "Off-site copies are off on this server, and it does not own the bucket folder."
  echo "If this server replaces the old one: on Admin, Backup, turn off-site copies on"
  echo "and use \"Take over this folder\". For a test restore, leave them off."
  echo "This server makes its own signing key. Add its verify key (shown on Admin,"
  echo "Backup) to your key file with offsite-key.mjs trust before you rely on new copies."

  ggo_step "8. Put the stored files back"
  ggo_compose up -d minio
  local put
  if [[ "$copy_kind" == "mirror" ]]; then
    put="$(ggo_cli_key put-mirror-objects --run "$MIRROR_RUN" --work "$OUT_DIR" "${ALLOW_ARGS[@]}")"
  else
    put="$(ggo_cli put-objects --archive "$archive_path")"
  fi
  echo "$put"

  ggo_step "9. Start the portal"
  ggo_compose up -d

  ggo_step "Check"
  local q count
  for q in organization user item _prisma_migrations; do
    count="$(ggo_psql "$PG_DB" -c "SELECT count(*) FROM \"$q\"" 2>/dev/null || echo '?')"
    printf '  %-20s %s\n' "$q" "$count"
  done
  local in_bucket
  in_bucket="$(ggo_cli count-objects | ggo_kv objects)"
  printf '  %-20s %s (the backup recorded %s)\n' "stored files" "${in_bucket:-?}" "${objects:-?}"
  echo ""
  echo "Done. Sign in and check the portal. The downloaded copy is in $OUT_DIR in the"
  echo "backups volume; delete it, and any pre-restore dump, once you are satisfied."
  echo "User accounts and passwords are not part of a portal backup: they come from this"
  echo "server's own sign-in service."
}

if [[ "${GG_RESTORE_LIB_ONLY:-0}" != "1" ]]; then
  ggo_main "$@"
fi
