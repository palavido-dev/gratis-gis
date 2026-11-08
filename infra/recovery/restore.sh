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
MAINT_FILE="${GRATIS_RECOVERY_MAINTENANCE_FILE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --recovery-key-file) RECOVERY_KEY="$2"; shift 2 ;;
    --credential-key-file) CREDENTIAL_KEY="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    --maintenance-file) MAINT_FILE="$2"; shift 2 ;;
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
  local maint="${4:-false}"
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"outcome":"$1","phase":"$2","kind":"restore","portalDownload":false,"secondaryFileVerified":false,"sameDisk":false,"offsiteVerified":false,"immutable":false,"maintenance":${maint},"detail":"$3"}
EOF
  chmod 644 "$STATUS_FILE"
}

hold_maintenance() {
  [[ -n "$MAINT_FILE" ]] || return 0
  mkdir -p "$(dirname "$MAINT_FILE")"
  printf '%s\n' '{"maintenance":true,"phase":"restore"}' >"$MAINT_FILE"
  chmod 644 "$MAINT_FILE"
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-restore.XXXXXX")"
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

NODE="$(recovery_node)"
if ! "$NODE" "$HERE/seal.mjs" dec "$RECOVERY_KEY" "$BUNDLE" "$STAGE/bundle.tar"; then
  write_status failed decrypt 'recovery key could not open the bundle' false
  recovery_die 'recovery key could not open the bundle'
fi
if ! python3 "$HERE/safe_untar.py" "$STAGE/bundle.tar" "$STAGE/unpacked"; then
  write_status failed verify 'bundle archive was rejected' false
  recovery_die 'bundle archive was rejected'
fi
rm -f "$STAGE/bundle.tar"
# The checks below read the unpacked names from STAGE root.
for name in manifest.json portal.dump keycloak.dump minio.tar; do
  if [[ -f "$STAGE/unpacked/$name" ]]; then
    mv "$STAGE/unpacked/$name" "$STAGE/$name"
  fi
done

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
  write_status failed verify 'bundle is incomplete or the credential key does not match' false
  recovery_die 'bundle is incomplete or the credential key does not match'
fi

# Checks passed. From here a failure has changed data, so the
# maintenance file stays in place for the API to keep serving 503.
hold_maintenance

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# Stop Keycloak only when it is running. A stopped Keycloak stays
# stopped. It is started again only after a successful restore.
KC_WAS_RUNNING=0
if [[ -n "$(compose ps -q keycloak 2>/dev/null || true)" ]]; then
  KC_WAS_RUNNING=1
  compose stop keycloak >/dev/null
fi

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
  write_status failed keycloak 'keycloak database restore failed' true
  recovery_die 'keycloak database restore failed'
fi
if [[ "$FAIL_AFTER" == "keycloak" ]]; then
  write_status failed partial 'stopped after keycloak on purpose; portal and objects were not restored' true
  recovery_die 'stopped after keycloak; portal database was not restored'
fi
if ! restore_db "$PORTAL_DB" "$STAGE/portal.dump"; then
  write_status failed partial 'portal database restore failed after keycloak was replaced' true
  recovery_die 'portal database restore failed'
fi

MINIO_DIR="$STAGE/minio-out"
mkdir -p "$MINIO_DIR"
python3 "$HERE/safe_untar.py" "$STAGE/minio.tar" "$MINIO_DIR"
MINIO_ENDPOINT="${MINIO_ENDPOINT:?}" \
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?}" \
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?}" \
  python3 "$HERE/minio_copy.py" push "$BUCKET" "$MINIO_DIR/minio" >/dev/null \
  || { write_status failed partial 'object restore failed after databases were replaced' true; recovery_die 'object restore failed'; }

if [[ "$KC_WAS_RUNNING" == 1 ]]; then
  compose start keycloak >/dev/null
fi
if [[ -n "$MAINT_FILE" ]]; then
  rm -f "$MAINT_FILE"
fi
write_status succeeded restored 'keycloak, portal, and objects restored' false
printf 'recovery: restore finished\n'
