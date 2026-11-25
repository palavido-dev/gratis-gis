#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# gg_load_env_file reads quoted values the way Compose does, and
# gg_ensure_signing_secret adds a secret to an older env file.
#
#   bash infra/lib-env.test.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/env" <<'ENV'
SINGLE_COMMENT='s3cret$x' # rotated 2026-10
DOUBLE_COMMENT="abc" # note
DOUBLE_ESCAPES="a\"b\\c"
PLAIN=value # trailing comment
PLAIN_DOLLAR=a$$b
SINGLE='keep # this'
ENV
fails=0
check() {
  local name="$1" want="$2" got
  got="$(bash -c ". '$root/infra/lib-env.sh'; gg_load_env_file '$work/env' 2>/dev/null; printf '%s' \"\${$name}\"")"
  if [[ "$got" == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name: got [$got] want [$want]"; fails=$((fails + 1)); fi
}
check SINGLE_COMMENT 's3cret$x'
check DOUBLE_COMMENT 'abc'
check DOUBLE_ESCAPES 'a"b\c'
check PLAIN 'value'
check PLAIN_DOLLAR 'a$b'
check SINGLE 'keep # this'

# gg_ensure_signing_secret gives an older env file its own signing
# secret on the next deploy and never changes one that is set.
expect() {
  local label="$1"; shift
  if "$@"; then echo "ok   $label"; else echo "FAIL $label"; fails=$((fails + 1)); fi
}
ensure() { bash -c ". '$root/infra/lib-env.sh'; gg_ensure_signing_secret '$1'" >/dev/null; }
value_of() { bash -c ". '$root/infra/lib-env.sh'; gg_load_env_file '$1' 2>/dev/null; printf '%s' \"\${GRATIS_SIGNING_SECRET-}\""; }

printf 'POSTGRES_PASSWORD=keepme\nMINIO_ROOT_PASSWORD=storagepw' > "$work/old.env"
chmod 600 "$work/old.env"
ensure "$work/old.env"
added="$(value_of "$work/old.env")"
expect "older file gets a secret" test "${#added}" -ge 32
expect "it is not the MinIO password" test "$added" != storagepw
expect "other lines kept" grep -qx 'POSTGRES_PASSWORD=keepme' "$work/old.env"
expect "last line without a newline kept" grep -qx 'MINIO_ROOT_PASSWORD=storagepw' "$work/old.env"
expect "mode 600 kept" test "$(stat -c %a "$work/old.env")" = 600
ensure "$work/old.env"
expect "a second deploy keeps it" test "$(value_of "$work/old.env")" = "$added"
expect "only one line" test "$(grep -c '^GRATIS_SIGNING_SECRET=' "$work/old.env")" = 1

printf 'A=1\nGRATIS_SIGNING_SECRET=GENERATE\nB=2\n' > "$work/gen.env"
ensure "$work/gen.env"
filled="$(value_of "$work/gen.env")"
expect "GENERATE is filled in" test "${#filled}" -ge 32
expect "GENERATE is gone" bash -c "! grep -q GENERATE '$work/gen.env'"
expect "neighbours kept" grep -qx 'B=2' "$work/gen.env"

printf 'GRATIS_SIGNING_SECRET=\n' > "$work/empty.env"
ensure "$work/empty.env"
expect "an empty value is filled in" test "$(value_of "$work/empty.env" | wc -c)" -ge 32
expect "still one line" test "$(grep -c '^GRATIS_SIGNING_SECRET=' "$work/empty.env")" = 1

printf "GRATIS_SIGNING_SECRET='set-by-the-operator-long-value'\n" > "$work/set.env"
cp "$work/set.env" "$work/set.before"
ensure "$work/set.env"
expect "a set value is never changed" cmp -s "$work/set.env" "$work/set.before"

# The placeholder check refuses it like the other secrets.
weak_env() {
  bash -c ". '$root/infra/lib-env.sh'
    PORTAL_DOMAIN=a.example.org AUTH_DOMAIN=auth.a.example.org STORAGE_DOMAIN=s.a.example.org
    PUBLIC_URL=https://a.example.org ACME_EMAIL=me@example.org POSTGRES_PASSWORD=p1p1p1p1p1p1p1p1
    KEYCLOAK_DB_PASSWORD=p2p2p2p2p2p2p2p2 MINIO_ROOT_USER=gratisgis MINIO_ROOT_PASSWORD=p3p3p3p3p3p3p3p3
    KEYCLOAK_ADMIN_PASSWORD=p4p4p4p4p4p4p4p4 KEYCLOAK_ADMIN_CLIENT_SECRET=p5p5p5p5p5p5p5p5
    CREDENTIAL_ENCRYPTION_KEY=\$(openssl rand -base64 32) INITIAL_USER_PASSWORD=p6p6p6p6p6p6p6p6
    NEXTAUTH_SECRET=p7p7p7p7p7p7p7p7 DEFAULT_ORG_SLUG=gratis-gis CHROMIUM_TOKEN=p8p8p8p8p8p8p8p8
    SCRIPT_EXECUTOR_TOKEN=p9p9p9p9p9p9p9p9 GRATIS_SIGNING_SECRET='$1'
    gg_require_prod_env" >/dev/null 2>&1
}
expect "a real signing secret passes" weak_env 'k3P9vQz2Lr8XwYt6NbHc4JmD7sFa1GeU'
expect "a missing one does not stop an older install" weak_env ''
refused() { ! weak_env "$1"; }
expect "devpassword is refused" refused devpassword
expect "changeme is refused" refused changeme

[[ "$fails" -eq 0 ]] && echo "lib-env: ok" || { echo "lib-env: $fails failure(s)"; exit 1; }
