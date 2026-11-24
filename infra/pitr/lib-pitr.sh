#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Shared helpers for the opt-in continuous backup scripts
# (infra/pitr-*.sh). Pure functions only: nothing here calls docker,
# the network or the database, so infra/pitr/lib-pitr.test.sh can run
# them anywhere.
#
# The design is in docs/cloud/backup-design.md.

# Stanza name used in pgbackrest.conf and by every script.
PITR_STANZA="${PITR_STANZA:-gratisgis}"

# Oldest pgBackRest that may write an encrypted repository. Releases
# before 2.59.3 did not check for an error when generating random
# data for encryption subkeys and salts (pgBackRest news, 2026-10-04).
export PITR_MIN_PGBACKREST=2.59.3

# Alert thresholds, in seconds. The WAL limit is the runbook's 10
# minutes. Full backups run weekly and differentials daily, so one
# missed run plus some slack is the limit for each.
PITR_WAL_MAX_AGE="${PITR_WAL_MAX_AGE:-600}"
PITR_FULL_MAX_AGE="${PITR_FULL_MAX_AGE:-$((8 * 86400 + 6 * 3600))}"
PITR_ANY_MAX_AGE="${PITR_ANY_MAX_AGE:-$((30 * 3600))}"

# pgBackRest drops WAL once 8 GiB is waiting (archive-push-queue-max in
# pgbackrest.conf). Alert at a quarter of that: 128 WAL files of 16 MiB
# is 2 GiB. Change both together.
PITR_QUEUE_LIMIT_BYTES=$((8 * 1073741824))
PITR_QUEUE_WARN_FILES="${PITR_QUEUE_WARN_FILES:-128}"

# Variables infra/.env.pitr must set, with a non-placeholder value.
PITR_REQUIRED_VARS=(
  PGBACKREST_REPO1_S3_ENDPOINT
  PGBACKREST_REPO1_S3_REGION
  PGBACKREST_REPO1_S3_BUCKET
  PGBACKREST_REPO1_S3_KEY
  PGBACKREST_REPO1_S3_KEY_SECRET
  PGBACKREST_REPO1_CIPHER_PASS
)

# pitr_version_ge HAVE WANT: true when version HAVE >= WANT.
# Dotted numbers only (2.60.1). Missing parts count as 0.
pitr_version_ge() {
  local have="$1" want="$2" i h w
  local -a ha wa
  IFS=. read -r -a ha <<<"$have"
  IFS=. read -r -a wa <<<"$want"
  for i in 0 1 2; do
    h="${ha[$i]:-0}"
    w="${wa[$i]:-0}"
    [[ "$h" =~ ^[0-9]+$ && "$w" =~ ^[0-9]+$ ]] || return 1
    if ((10#$h > 10#$w)); then return 0; fi
    if ((10#$h < 10#$w)); then return 1; fi
  done
  return 0
}

# pitr_valid_target TEXT: true when TEXT is a timestamp with an
# explicit time zone, in the form PostgreSQL and pgBackRest accept:
#   2026-11-24 14:05:00+00
#   2026-11-24 14:05+00:00
#   2026-11-24 14:05:00.123-08
# A time without a zone is refused: the server and the person typing
# may not agree on what it means.
pitr_valid_target() {
  local re='^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?[+-][0-9]{2}(:?[0-9]{2})?$'
  [[ "$1" =~ $re ]]
}

# pitr_target_epoch TEXT: print TEXT as seconds since 1970 (GNU date).
pitr_target_epoch() {
  date -u -d "$1" +%s 2>/dev/null
}

# pitr_target_problem TEXT NOW_EPOCH WINDOW_DAYS: print why TEXT cannot
# be a restore target, or nothing when it can. Returns 1 on a problem.
pitr_target_problem() {
  local target="$1" now="$2" days="${3:-14}" epoch
  if ! pitr_valid_target "$target"; then
    echo "Target time must look like '2026-11-24 14:05:00+00', with a time zone."
    return 1
  fi
  if ! epoch="$(pitr_target_epoch "$target")" || [[ -z "$epoch" ]]; then
    echo "Target time '$target' is not a real date and time."
    return 1
  fi
  if ((epoch > now)); then
    echo "Target time '$target' is in the future."
    return 1
  fi
  if ((epoch < now - days * 86400)); then
    echo "Target time '$target' is more than $days days ago. Backups do not reach that far back."
    return 1
  fi
  return 0
}

# pitr_env_problems FILE: print one line per problem in an .env.pitr
# file. Returns 1 when there is any. The file is read as text, never
# sourced.
pitr_env_problems() {
  local file="$1" var line value found bad=0
  if [[ ! -f "$file" ]]; then
    echo "Missing $file. Copy infra/pitr/pitr.env.example to it and fill it in."
    return 1
  fi
  for var in "${PITR_REQUIRED_VARS[@]}"; do
    found=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line#export }"
      if [[ "$line" == "$var="* ]]; then
        found=1
        value="${line#*=}"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        if [[ -z "$value" || "$value" == *CHANGE_ME* ]]; then
          echo "$var in $file is empty or still a placeholder."
          bad=1
        fi
      fi
    done <"$file"
    if [[ "$found" -eq 0 ]]; then
      echo "$var is not set in $file."
      bad=1
    fi
  done
  # A short passphrase is guessable. pitr-setup.sh writes 64 characters.
  value="$(grep -E '^(export )?PGBACKREST_REPO1_CIPHER_PASS=' "$file" | tail -n 1 | cut -d= -f2-)"
  value="${value//[\"\']/}"
  if [[ -n "$value" && "$value" != *CHANGE_ME* && "${#value}" -lt 32 ]]; then
    echo "PGBACKREST_REPO1_CIPHER_PASS is shorter than 32 characters."
    bad=1
  fi
  return "$bad"
}

# pitr_verdict NOW ARCHIVE_MODE READY_COUNT READY_OLDEST_EPOCH
#   LAST_ARCHIVED_EPOCH LAST_FAILED_EPOCH LAST_FULL_EPOCH LAST_ANY_EPOCH
#   LAST_ERROR
# Print one "ALERT ..." line per problem. Returns 1 when any.
# Epoch values are 0 when unknown (never happened).
pitr_verdict() {
  local now="$1" mode="$2" ready="$3" ready_oldest="$4" archived="$5"
  local failed="$6" full="$7" any="$8" err="$9" bad=0
  if [[ "$mode" != "on" && "$mode" != "always" ]]; then
    echo "ALERT archive_mode is '$mode'. WAL is not being archived. Was the stack started without docker-compose.pitr.yml?"
    bad=1
  fi
  if ((ready > 0 && now - ready_oldest > PITR_WAL_MAX_AGE)); then
    echo "ALERT $ready WAL file(s) waiting; the oldest for $(((now - ready_oldest) / 60)) minutes. Archiving is stuck. The disk will fill if this continues."
    bad=1
  fi
  if ((ready >= PITR_QUEUE_WARN_FILES)); then
    echo "ALERT $ready WAL files ($((ready * 16)) MiB) are waiting. pgBackRest starts dropping WAL at $((PITR_QUEUE_LIMIT_BYTES / 1048576)) MiB, which breaks the restore chain."
    bad=1
  fi
  if ((failed > 0 && failed > archived)); then
    echo "ALERT the last archive attempt failed and nothing has been archived since."
    bad=1
  fi
  if ((full == 0)); then
    echo "ALERT there is no full backup in the repository."
    bad=1
  elif ((now - full > PITR_FULL_MAX_AGE)); then
    echo "ALERT the last full backup is $(((now - full) / 3600)) hours old."
    bad=1
  fi
  if ((any > 0 && now - any > PITR_ANY_MAX_AGE)); then
    echo "ALERT the last backup of any kind is $(((now - any) / 3600)) hours old."
    bad=1
  fi
  if [[ "$err" == "true" ]]; then
    echo "ALERT the last backup recorded page checksum or copy errors."
    bad=1
  fi
  return "$bad"
}

# pitr_size_jump PREVIOUS_BYTES CURRENT_BYTES: print an ALERT line and
# return 1 when the newest full backup is more than twice the size of
# the one before and at least 1 GiB bigger. A sudden jump can mean a
# runaway import, or a table full of junk that will cost money to keep.
pitr_size_jump() {
  local prev="$1" cur="$2"
  if ((prev > 0 && cur > 2 * prev && cur - prev >= 1073741824)); then
    echo "ALERT the newest full backup is $((cur / 1048576)) MiB, more than twice the previous $((prev / 1048576)) MiB."
    return 1
  fi
  return 0
}

# pitr_metric NAME VALUE [LABELS]: one Prometheus text-format line.
pitr_metric() {
  if [[ -n "${3:-}" ]]; then
    printf '%s{%s} %s\n' "$1" "$3" "$2"
  else
    printf '%s %s\n' "$1" "$2"
  fi
}

# pitr_missing_keys REFERENCED_FILE BUCKET_FILE: print keys listed in
# REFERENCED_FILE that are not in BUCKET_FILE. One key per line in
# each; order and duplicates do not matter.
pitr_missing_keys() {
  LC_ALL=C comm -23 <(LC_ALL=C sort -u "$1") <(LC_ALL=C sort -u "$2")
}
