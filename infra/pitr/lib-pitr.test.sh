#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Pure helpers behind the continuous backup scripts. No docker.
#
#   bash infra/pitr/lib-pitr.test.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=infra/pitr/lib-pitr.sh
. "$root/infra/pitr/lib-pitr.sh"
fails=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
yes() { if "${@:2}" >/dev/null; then ok "$1"; else bad "$1"; fi; }
no() { if "${@:2}" >/dev/null; then bad "$1"; else ok "$1"; fi; }
has() {
  if grep -qF -- "$3" <<<"$2"; then ok "$1"; else
    echo "FAIL $1: wanted [$3] in:"; printf '     %s\n' "$2"; fails=$((fails + 1))
  fi
}

# Versions.
yes "same version" pitr_version_ge 2.59.3 2.59.3
yes "newer patch" pitr_version_ge 2.60.1 2.59.3
yes "newer minor beats bigger patch" pitr_version_ge 2.60.0 2.59.9
no "older patch" pitr_version_ge 2.59.2 2.59.3
no "trixie package" pitr_version_ge 2.55.1 2.59.3
yes "two parts" pitr_version_ge 3.0 2.59.3
no "not a version" pitr_version_ge abc 2.59.3

# Target time format.
yes "seconds and +00" pitr_valid_target '2026-11-24 14:05:00+00'
yes "minutes and +00:00" pitr_valid_target '2026-11-24 14:05+00:00'
yes "fraction and -08" pitr_valid_target '2026-11-24 14:05:00.123-08'
no "no zone" pitr_valid_target '2026-11-24 14:05:00'
no "zone name" pitr_valid_target '2026-11-24 14:05:00 PST'
no "T separator" pitr_valid_target '2026-11-24T14:05:00Z'
no "shell text" pitr_valid_target "2026-11-24 14:05:00+00'; rm -rf /"
no "empty" pitr_valid_target ''

now="$(date -u -d '2026-11-24 15:00:00+00' +%s)"
out="$(pitr_target_problem '2026-11-24 14:05:00+00' "$now" 14 || true)"
if [[ -z "$out" ]]; then ok "an hour ago is fine"; else bad "an hour ago is fine: $out"; fi
out="$(pitr_target_problem '2026-11-24 16:05:00+00' "$now" 14 || true)"
has "future refused" "$out" "is in the future"
out="$(pitr_target_problem '2026-11-01 14:05:00+00' "$now" 14 || true)"
has "past the window refused" "$out" "more than 14 days ago"
out="$(pitr_target_problem '2026-02-30 14:05:00+00' "$now" 14 || true)"
has "impossible date refused" "$out" "not a real date"
out="$(pitr_target_problem '2026-11-24 14:05' "$now" 14 || true)"
has "missing zone explained" "$out" "with a time zone"
out="$(pitr_target_problem '2026-11-24 09:05:00-05' "$now" 14 || true)"
if [[ -z "$out" ]]; then ok "other zone is converted"; else bad "other zone is converted: $out"; fi

# Env file.
out="$(pitr_env_problems "$tmp/nope" || true)"
has "missing env file" "$out" "Copy infra/pitr/pitr.env.example"
cp "$root/infra/pitr/pitr.env.example" "$tmp/example"
out="$(pitr_env_problems "$tmp/example" || true)"
has "template placeholders refused" "$out" "PGBACKREST_REPO1_S3_BUCKET in $tmp/example is empty or still a placeholder."
has "template passphrase refused" "$out" "PGBACKREST_REPO1_CIPHER_PASS in $tmp/example is empty or still a placeholder."
cat >"$tmp/good" <<'EOF'
# comment
PGBACKREST_REPO1_S3_ENDPOINT=s3.us-west-004.backblazeb2.com
PGBACKREST_REPO1_S3_REGION=us-west-004
PGBACKREST_REPO1_S3_BUCKET="example-pg"
PGBACKREST_REPO1_S3_KEY=keyid
export PGBACKREST_REPO1_S3_KEY_SECRET='secret'
PGBACKREST_REPO1_CIPHER_PASS=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab
EOF
if out="$(pitr_env_problems "$tmp/good")"; then ok "complete env file passes"; else bad "complete env file passes: $out"; fi
sed 's/^PGBACKREST_REPO1_CIPHER_PASS=.*/PGBACKREST_REPO1_CIPHER_PASS=short/' "$tmp/good" >"$tmp/short"
out="$(pitr_env_problems "$tmp/short" || true)"
has "short passphrase refused" "$out" "shorter than 32 characters"
grep -v S3_KEY_SECRET "$tmp/good" >"$tmp/nosecret"
out="$(pitr_env_problems "$tmp/nosecret" || true)"
has "missing variable named" "$out" "PGBACKREST_REPO1_S3_KEY_SECRET is not set"

# Verdict. now=1000000; every input healthy first.
n=1000000
if out="$(pitr_verdict $n on 0 $n $((n - 30)) 0 $((n - 86400)) $((n - 3600)) false)"; then
  ok "healthy is quiet"
else
  bad "healthy is quiet: $out"
fi
out="$(pitr_verdict $n on 1 $((n - 30)) $((n - 30)) 0 $((n - 86400)) $((n - 3600)) false || true)"
if [[ -z "$out" ]]; then ok "one fresh waiting file is fine"; else bad "one fresh waiting file is fine: $out"; fi
out="$(pitr_verdict $n on 3 $((n - 700)) $((n - 700)) 0 $((n - 86400)) $((n - 3600)) false || true)"
has "stuck archive after 10 minutes" "$out" "3 WAL file(s) waiting; the oldest for 11 minutes"
out="$(pitr_verdict $n on 0 $n 0 0 $((n - 86400)) $((n - 3600)) false || true)"
if [[ -z "$out" ]]; then ok "quiet database with no waiting WAL does not alert"; else bad "quiet database: $out"; fi
out="$(pitr_verdict $n off 0 $n 0 0 $((n - 86400)) $((n - 3600)) false || true)"
has "archive_mode off" "$out" "archive_mode is 'off'"
out="$(pitr_verdict $n on 0 $n $((n - 600)) $((n - 10)) $((n - 86400)) $((n - 3600)) false || true)"
has "last attempt failed" "$out" "last archive attempt failed"
out="$(pitr_verdict $n on 0 $n $((n - 5)) $((n - 10)) $((n - 86400)) $((n - 3600)) false || true)"
if [[ -z "$out" ]]; then ok "failure followed by success is fine"; else bad "failure then success: $out"; fi
out="$(pitr_verdict $n on 0 $n $n 0 0 0 false || true)"
has "no full backup" "$out" "no full backup in the repository"
out="$(pitr_verdict $n on 0 $n $n 0 $((n - 9 * 86400)) $((n - 3600)) false || true)"
has "old full backup" "$out" "the last full backup is 216 hours old"
out="$(pitr_verdict $n on 0 $n $n 0 $((n - 86400)) $((n - 31 * 3600)) false || true)"
has "missed daily backup" "$out" "the last backup of any kind is 31 hours old"
out="$(pitr_verdict $n on 0 $n $n 0 $((n - 86400)) $((n - 3600)) true || true)"
has "backup errors" "$out" "page checksum or copy errors"

# Size jump.
yes "steady size" pitr_size_jump 5368709120 5905580032
yes "small database doubling is not news" pitr_size_jump 104857600 314572800
no "big jump" pitr_size_jump 2147483648 6442450944
yes "first full has nothing to compare" pitr_size_jump 0 6442450944

# Metrics.
has "metric with labels" "$(pitr_metric gg_x 3 'type="full"')" 'gg_x{type="full"} 3'
has "metric without labels" "$(pitr_metric gg_y 0)" 'gg_y 0'

# Missing objects.
printf 'item-file/b\nfeature-attachment/a\nmap-icon/c.png\nitem-file/b\n' >"$tmp/ref"
printf 'feature-attachment/a\nunrelated/x\n' >"$tmp/bucket"
out="$(pitr_missing_keys "$tmp/ref" "$tmp/bucket")"
if [[ "$out" == $'item-file/b\nmap-icon/c.png' ]]; then ok "missing keys listed once, sorted"; else bad "missing keys: [$out]"; fi
: >"$tmp/empty"
out="$(pitr_missing_keys "$tmp/empty" "$tmp/bucket")"
if [[ -z "$out" ]]; then ok "nothing referenced, nothing missing"; else bad "empty reference list: [$out]"; fi

if [[ "$fails" -gt 0 ]]; then
  echo "$fails failure(s)"
  exit 1
fi
echo "all passed"
