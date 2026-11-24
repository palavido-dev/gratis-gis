#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Bring a portal back from an off-site backup copy on a new server.
#
#   infra/restore-from-offsite.sh --env-file infra/.env.prod \
#     --passphrase-file /root/offsite.pass --list
#
#   infra/restore-from-offsite.sh --env-file infra/.env.prod \
#     --passphrase-file /root/offsite.pass \
#     --confirm-project gratis-gis-prod [--archive NAME | --mirror-run NAME]
#
# Before you run it: install GratisGIS on the new server with the
# installer (same release as the backup, or newer), and add the
# BACKUP_OFFSITE_* bucket settings to the env file. Put back the
# original CREDENTIAL_ENCRYPTION_KEY if you have it, or stored
# credentials for external services cannot be decrypted.
#
# What it does, in order:
#   1. Download the newest complete copy (or the one named) into the
#      backups volume, check its checksum and decrypt it. The work runs
#      in the portal-api image, which already has the tools.
#   2. Stop the portal's own services (not the database or MinIO).
#   3. Replace the portal database: drop it, create it empty, and
#      restore the dump in one transaction that stops on the first error.
#   4. Run the database migrations, so an older backup matches this code.
#   5. Put the stored files back into MinIO.
#   6. Start everything and print counts next to the backup's own.
#
# The passphrase is read from a file and passed on standard input. It
# is never an argument, never in the environment of a child process
# and never printed. The download and the unpacked files need about
# twice the archive size of free disk in the backups volume.
set -euo pipefail

ENV_FILE=""
PASS_FILE=""
COMPOSE_FILE=""
PROJECT="${GRATIS_RESTORE_PROJECT:-gratis-gis-prod}"
CONFIRM=""
ARCHIVE=""
MIRROR_RUN=""
LIST_ONLY=0
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

# An archive name as the portal writes it.
ggo_valid_archive() {
  [[ "$1" =~ ^backup-[0-9A-Za-z-]+\.tar\.gz$ ]]
}

# A mirror run folder name: <time stamp>-<8 hex>.
ggo_valid_mirror_run() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+-[0-9a-f]{8}$ ]]
}

# A database or role name safe to put inside double quotes in SQL.
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

# The time stamp at the front of an archive or mirror run name, for
# picking the newer of the two kinds.
ggo_stamp() {
  local n="${1#backup-}"
  printf '%s\n' "${n:0:23}"
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

# The same, with the passphrase on standard input.
ggo_cli_pass() {
  printf '%s' "$PASSPHRASE" | ggo_cli "$@" --passphrase-stdin
}

ggo_usage() {
  sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
}

ggo_parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file) ENV_FILE="${2:-}"; shift 2 ;;
      --passphrase-file) PASS_FILE="${2:-}"; shift 2 ;;
      --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
      --project) PROJECT="${2:-}"; shift 2 ;;
      --confirm-project) CONFIRM="${2:-}"; shift 2 ;;
      --archive) ARCHIVE="${2:-}"; shift 2 ;;
      --mirror-run) MIRROR_RUN="${2:-}"; shift 2 ;;
      --list) LIST_ONLY=1; shift ;;
      -h | --help) ggo_usage; exit 0 ;;
      *) ggo_die "unknown argument: $1 (see --help)" ;;
    esac
  done
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || ggo_die "--env-file must name an existing file"
  [[ -n "$PASS_FILE" && -f "$PASS_FILE" ]] || ggo_die "--passphrase-file must name an existing file"
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
  if [[ "$LIST_ONLY" != "1" && "$CONFIRM" != "$PROJECT" ]]; then
    ggo_die "this replaces the portal database; pass --confirm-project $PROJECT to go ahead"
  fi
  return 0
}

ggo_read_passphrase() {
  local mode
  mode="$(stat -c '%a' "$PASS_FILE" 2>/dev/null || echo 600)"
  if [[ "${mode: -1}" != "0" ]]; then
    echo "Note: $PASS_FILE can be read by other users of this server (mode $mode). chmod 600 it." >&2
  fi
  # Command substitution drops trailing newlines; a portal passphrase
  # never ends in one.
  PASSPHRASE="$(cat "$PASS_FILE")"
  [[ ${#PASSPHRASE} -ge 16 ]] || ggo_die "the passphrase file holds fewer than 16 characters"
}

ggo_step() {
  echo ""
  echo "== $* =="
}

ggo_main() {
  ggo_parse_args "$@"
  command -v docker >/dev/null 2>&1 || ggo_die "docker is required"
  ggo_read_passphrase

  if [[ "$LIST_ONLY" == "1" ]]; then
    ggo_cli list
    return 0
  fi

  local pg_user pg_db running
  pg_user="$(ggo_env_value "$ENV_FILE" POSTGRES_USER)"
  pg_user="${pg_user:-gratisgis}"
  pg_db="$(ggo_env_value "$ENV_FILE" POSTGRES_DB)"
  pg_db="${pg_db:-gratisgis}"
  ggo_valid_identifier "$pg_user" || ggo_die "POSTGRES_USER has unexpected characters"
  ggo_valid_identifier "$pg_db" || ggo_die "POSTGRES_DB has unexpected characters"

  running="$(ggo_compose ps --status running --services 2>/dev/null || true)"
  grep -qx postgres <<<"$running" || ggo_die "the postgres service of project $PROJECT is not running; install and start the stack first"

  # Which copy: the one named, or the newest of either kind.
  local mode="archive"
  if [[ -n "$MIRROR_RUN" ]]; then
    mode="mirror"
  elif [[ -z "$ARCHIVE" ]]; then
    local listing latest latest_mirror
    listing="$(ggo_cli list)"
    latest="$(ggo_kv latest <<<"$listing")"
    latest_mirror="$(ggo_kv latestMirror <<<"$listing")"
    [[ -z "$latest" && -z "$latest_mirror" ]] && ggo_die "no complete off-site copy was found"
    if [[ -n "$latest_mirror" && ( -z "$latest" || "$(ggo_stamp "$latest_mirror")" > "$(ggo_stamp "$latest")" ) ]]; then
      mode="mirror"
      MIRROR_RUN="$latest_mirror"
    else
      ARCHIVE="$latest"
    fi
  fi

  ggo_step "1. Download and decrypt"
  local fetched dump_cmd database objects
  if [[ "$mode" == "mirror" ]]; then
    fetched="$(ggo_cli_pass fetch-mirror --out "$OUT_DIR" --run "$MIRROR_RUN")"
    local dump
    dump="$(ggo_kv dump <<<"$fetched")"
    [[ "$dump" == "$OUT_DIR/"* ]] || ggo_die "unexpected dump path"
    dump_cmd=(cat "$dump")
  else
    fetched="$(ggo_cli_pass fetch --out "$OUT_DIR" ${ARCHIVE:+--name "$ARCHIVE"})"
    local archive_path
    archive_path="$(ggo_kv archive <<<"$fetched")"
    [[ "$archive_path" == "$OUT_DIR/"* ]] || ggo_die "unexpected archive path"
    database="$(ggo_kv database <<<"$fetched")"
    ggo_valid_identifier "$database" || ggo_die "the archive names an unexpected database"
    dump_cmd=(tar -xzOf "$archive_path" "postgres/${database}.dump")
  fi
  objects="$(ggo_kv objects <<<"$fetched")"
  echo "$fetched"

  ggo_step "2. Stop the portal services"
  local services stop=()
  services="$(ggo_compose config --services)"
  for s in $WRITERS; do
    grep -qx "$s" <<<"$services" && stop+=("$s")
  done
  ggo_compose stop "${stop[@]}"

  echo "If a later step fails, the portal stays stopped. Read the error, fix it, and run this script again."

  ggo_step "3. Replace the portal database ($pg_db)"
  ggo_compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$pg_db\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$pg_db\" OWNER \"$pg_user\""
  ggo_compose run --rm -T --no-deps --entrypoint "${dump_cmd[0]}" portal-api "${dump_cmd[@]:1}" |
    ggo_compose exec -T postgres pg_restore --no-owner --no-privileges --exit-on-error \
      --single-transaction -U "$pg_user" -d "$pg_db"

  ggo_step "4. Run the database migrations"
  ggo_compose run --rm portal-migrate

  ggo_step "5. Put the stored files back"
  ggo_compose up -d minio
  local put
  if [[ "$mode" == "mirror" ]]; then
    put="$(ggo_cli_pass put-mirror-objects --run "$MIRROR_RUN")"
  else
    put="$(ggo_cli put-objects --archive "$archive_path")"
  fi
  echo "$put"

  ggo_step "6. Start the portal"
  ggo_compose up -d

  ggo_step "Check"
  local q count
  for q in organization user item _prisma_migrations; do
    count="$(ggo_compose exec -T postgres psql -X -A -t -U "$pg_user" -d "$pg_db" \
      -c "SELECT count(*) FROM \"$q\"" 2>/dev/null || echo '?')"
    printf '  %-20s %s\n' "$q" "$count"
  done
  local in_bucket
  in_bucket="$(ggo_cli count-objects | ggo_kv objects)"
  printf '  %-20s %s (the backup recorded %s)\n' "stored files" "${in_bucket:-?}" "${objects:-?}"
  echo ""
  echo "Done. Sign in and check the portal. The downloaded copy is in $OUT_DIR in the"
  echo "backups volume; delete it once you are satisfied."
  echo "User accounts and passwords are not part of a portal backup: they come from this"
  echo "server's own sign-in service."
}

if [[ "${GG_RESTORE_LIB_ONLY:-0}" != "1" ]]; then
  ggo_main "$@"
fi
