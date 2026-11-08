#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Restore a host recovery bundle. Keycloak database first, then the
# portal database, then object storage. Refuses to start if the
# credential-key fingerprint does not match, or if any component is
# missing or its checksum does not. A failure after the first
# database is a partial restore and is reported as failed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
recovery_umask

CONFIRM=""
COMPOSE_FILE=""
RECOVERY_KEY=""
CREDENTIAL_KEY=""
BUNDLE=""
STATUS_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --recovery-key-file) RECOVERY_KEY="$2"; shift 2 ;;
    --credential-key-file) CREDENTIAL_KEY="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done

recovery_confirm_project "$CONFIRM"
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || recovery_die 'compose file is required'
[[ -n "$RECOVERY_KEY" && -f "$RECOVERY_KEY" ]] || recovery_die 'recovery key file is required'
[[ -n "$CREDENTIAL_KEY" && -f "$CREDENTIAL_KEY" ]] || recovery_die 'credential key file is required'
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || recovery_die 'bundle is required'

PROJECT="$GRATIS_RECOVERY_PROJECT"
PORTAL_DB="${GRATIS_RECOVERY_PORTAL_DB:-gratisgis}"
KEYCLOAK_DB="${GRATIS_RECOVERY_KEYCLOAK_DB:-keycloak}"
BUCKET="${GRATIS_RECOVERY_BUCKET:-gratisgis}"
FAIL_AFTER="${GRATIS_RECOVERY_FAIL_AFTER:-}"

write_status() {
  [[ -n "$STATUS_FILE" ]] || return 0
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"outcome":"$1","phase":"$2","kind":"restore","portalDownload":false,"offsiteVerified":false,"immutable":false,"detail":"$3"}
EOF
  chmod 644 "$STATUS_FILE"
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-restore.XXXXXX")"
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$BUNDLE" -out "$STAGE/bundle.tar" -pass "file:$RECOVERY_KEY"; then
  write_status failed decrypt 'recovery key could not open the bundle'
  recovery_die 'recovery key could not open the bundle'
fi
tar -C "$STAGE" -xf "$STAGE/bundle.tar"
rm -f "$STAGE/bundle.tar"

if ! python3 - "$STAGE/manifest.json" "$STAGE" "$CREDENTIAL_KEY" <<'PY'
import hashlib, json, pathlib, sys
manifest_path, stage_s, key_path = sys.argv[1:]
stage = pathlib.Path(stage_s)
doc = json.loads(pathlib.Path(manifest_path).read_text())
need = ("portal.dump", "keycloak.dump", "minio.tar", "manifest.json")
for name in need:
    if not (stage / name).is_file():
        raise SystemExit(f"missing {name}")
files = {
    "portal.dump": doc["components"]["portalDatabase"],
    "keycloak.dump": doc["components"]["keycloakDatabase"],
    "minio.tar": doc["components"]["minio"],
}
for name, meta in files.items():
    data = (stage / name).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != meta["sha256"] or len(data) != meta["bytes"]:
        raise SystemExit(f"checksum mismatch for {name}")
    if len(data) == 0:
        raise SystemExit(f"empty component {name}")
got = hashlib.sha256(pathlib.Path(key_path).read_bytes()).hexdigest()
if got != doc["credentialKeySha256"]:
    raise SystemExit("credential key fingerprint does not match this bundle")
PY
then
  write_status failed verify 'bundle is incomplete or the credential key does not match'
  recovery_die 'bundle is incomplete or the credential key does not match'
fi

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# Keycloak holds its database open. Stop it before the restore and
# start it again only after both databases and the object store match
# the bundle.
compose stop keycloak >/dev/null || true

restore_db() {
  local db="$1" dump="$2" rc=0
  # Keycloak keeps its own ownership and grants. The portal database
  # is restored as the application role, which is the user that dumps it.
  # pg_restore exits 1 when it only emitted warnings.
  if [[ "$db" == "$KEYCLOAK_DB" ]]; then
    compose exec -T postgres pg_restore -U "${POSTGRES_USER:-gratisgis}" -d "$db" --clean --if-exists <"$dump" >/dev/null || rc=$?
  else
    compose exec -T postgres pg_restore -U "${POSTGRES_USER:-gratisgis}" -d "$db" --clean --if-exists --no-owner --no-privileges <"$dump" >/dev/null || rc=$?
  fi
  [[ "$rc" -le 1 ]]
}

if ! restore_db "$KEYCLOAK_DB" "$STAGE/keycloak.dump"; then
  write_status failed keycloak 'keycloak database restore failed'
  recovery_die 'keycloak database restore failed'
fi
if [[ "$FAIL_AFTER" == "keycloak" ]]; then
  write_status failed partial 'stopped after keycloak on purpose; portal and objects were not restored'
  recovery_die 'stopped after keycloak; portal database was not restored'
fi
if ! restore_db "$PORTAL_DB" "$STAGE/portal.dump"; then
  write_status failed partial 'portal database restore failed after keycloak was replaced'
  recovery_die 'portal database restore failed'
fi

MINIO_DIR="$STAGE/minio-out"
mkdir -p "$MINIO_DIR"
tar -C "$MINIO_DIR" -xf "$STAGE/minio.tar"
MINIO_ENDPOINT="${MINIO_ENDPOINT:?}" \
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?}" \
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?}" \
  python3 "$HERE/minio_copy.py" push "$BUCKET" "$MINIO_DIR/minio" >/dev/null \
  || { write_status failed partial 'object restore failed after databases were replaced'; recovery_die 'object restore failed'; }

compose start keycloak >/dev/null || true
write_status succeeded restored 'keycloak, portal, and objects restored'
printf 'recovery: restore finished\n'
