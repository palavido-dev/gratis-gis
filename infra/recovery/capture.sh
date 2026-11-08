#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Opt-in host capture of a GratisGIS compose project.
# Portal database, Keycloak database, and MinIO objects. The credential
# encryption key is not stored; only its sha256 is recorded so a later
# restore can refuse a different key. The recovery passphrase is read
# from a file and is not written into the bundle.
#
#   GRATIS_RECOVERY_PROJECT=gg-recovery-drill \
#     infra/recovery/capture.sh \
#       --confirm-project gg-recovery-drill \
#       --compose-file infra/recovery/compose.drill.yml \
#       --recovery-key-file /path/to/recovery.key \
#       --credential-key-file /path/to/credential.key \
#       --out /path/to/out-dir
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
recovery_umask

CONFIRM=""
COMPOSE_FILE=""
RECOVERY_KEY=""
CREDENTIAL_KEY=""
OUT=""
STATUS_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --recovery-key-file) RECOVERY_KEY="$2"; shift 2 ;;
    --credential-key-file) CREDENTIAL_KEY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done

recovery_confirm_project "$CONFIRM"
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || recovery_die 'compose file is required'
[[ -n "$RECOVERY_KEY" && -f "$RECOVERY_KEY" ]] || recovery_die 'recovery key file is required'
[[ -n "$CREDENTIAL_KEY" && -f "$CREDENTIAL_KEY" ]] || recovery_die 'credential key file is required'
[[ -n "$OUT" ]] || recovery_die 'output directory is required'

PROJECT="$GRATIS_RECOVERY_PROJECT"
PORTAL_DB="${GRATIS_RECOVERY_PORTAL_DB:-gratisgis}"
KEYCLOAK_DB="${GRATIS_RECOVERY_KEYCLOAK_DB:-keycloak}"
BUCKET="${GRATIS_RECOVERY_BUCKET:-gratisgis}"

write_status() {
  [[ -n "$STATUS_FILE" ]] || return 0
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"outcome":"$1","phase":"$2","kind":"local-capture","portalDownload":false,"offsiteVerified":false,"immutable":false,"detail":"$3"}
EOF
  chmod 644 "$STATUS_FILE"
}

fail() {
  write_status failed capture "$1"
  rm -rf "$STAGE" "$OUT/bundle.tar" "$OUT/bundle.tar.enc" 2>/dev/null || true
  recovery_die "$1"
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
chmod 700 "$OUT" "$STAGE"

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# Quiesce writers that this compose file actually defines. A service
# that is not in the file is not a writer on this stack. A service
# that is defined but not running cannot write. A running writer that
# will not pause fails the capture.
mapfile -t SERVICES < <(compose config --services)
pause_list=()
for svc in keycloak portal-api portal-worker pointcloud-worker script-runner script-executor; do
  if printf '%s\n' "${SERVICES[@]}" | grep -qx "$svc"; then
    cid="$(compose ps -q "$svc" 2>/dev/null || true)"
    if [[ -n "$cid" ]]; then
      docker pause "$cid" >/dev/null || fail "could not pause ${svc}"
      pause_list+=("$svc")
    fi
  fi
done
unpause() {
  for svc in "${pause_list[@]+"${pause_list[@]}"}"; do
    cid="$(compose ps -q "$svc" 2>/dev/null || true)"
    if [[ -n "$cid" ]]; then docker unpause "$cid" >/dev/null || true; fi
  done
}
trap 'unpause; rm -rf "$STAGE"' EXIT

compose exec -T -e PGOPTIONS='-c lock_timeout=15000' postgres \
  pg_dump -U "${POSTGRES_USER:-gratisgis}" -d "$PORTAL_DB" -Fc --no-owner --no-privileges >"$STAGE/portal.dump" \
  || fail 'portal database dump failed'
compose exec -T -e PGOPTIONS='-c lock_timeout=15000' postgres \
  pg_dump -U "${POSTGRES_USER:-gratisgis}" -d "$KEYCLOAK_DB" -Fc >"$STAGE/keycloak.dump" \
  || fail 'keycloak database dump failed'
[[ -s "$STAGE/portal.dump" && -s "$STAGE/keycloak.dump" ]] || fail 'a database dump is empty'

MINIO_DIR="$STAGE/minio"
MINIO_JSON="$(
  MINIO_ENDPOINT="${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}" \
  MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?}" \
  MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?}" \
  python3 "$HERE/minio_copy.py" pull "$BUCKET" "$MINIO_DIR"
)" || fail 'object store copy failed'
tar -C "$STAGE" -cf "$STAGE/minio.tar" minio
rm -rf "$MINIO_DIR"

PAUSED="${pause_list[*]:-}" python3 - "$STAGE/manifest.json" "$CREDENTIAL_KEY" "$MINIO_JSON" <<'PY'
import hashlib, json, os, pathlib, sys
out, key_path, minio_raw = sys.argv[1:]
stage = pathlib.Path(out).parent
key = pathlib.Path(key_path).read_bytes()
minio = json.loads(minio_raw)
files = {}
for name in ("portal.dump", "keycloak.dump", "minio.tar"):
    data = (stage / name).read_bytes()
    files[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
paused = [p for p in os.environ.get("PAUSED", "").split(" ") if p]
doc = {
    "kind": "gratis-recovery-bundle",
    "format": 1,
    "components": {
        "portalDatabase": files["portal.dump"],
        "keycloakDatabase": files["keycloak.dump"],
        "minio": {
            **files["minio.tar"],
            "objectCount": minio["objectCount"],
            "totalBytes": minio["totalBytes"],
        },
    },
    "credentialKeySha256": hashlib.sha256(key).hexdigest(),
    "quiesce": {"pausedWriters": paused},
    "notIncluded": ["CREDENTIAL_ENCRYPTION_KEY", "recovery passphrase"],
    "distinguishes": {
        "localCapture": True,
        "portalDownload": False,
        "offsiteVerified": False,
        "immutable": False,
    },
}
pathlib.Path(out).write_text(json.dumps(doc, indent=2) + "\n")
PY

tar -C "$STAGE" -cf "$OUT/bundle.tar" manifest.json portal.dump keycloak.dump minio.tar
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$OUT/bundle.tar" -out "$OUT/bundle.tar.enc" \
  -pass "file:$RECOVERY_KEY"
rm -f "$OUT/bundle.tar"
chmod 600 "$OUT/bundle.tar.enc"
sha="$(recovery_sha256 "$OUT/bundle.tar.enc")"
printf '%s  bundle.tar.enc\n' "$sha" >"$OUT/bundle.tar.enc.sha256"
chmod 644 "$OUT/bundle.tar.enc.sha256"
unpause
trap 'rm -rf "$STAGE"' EXIT
write_status succeeded local-capture 'encrypted bundle written'
printf 'recovery: local capture sealed (%s bytes)\n' "$(wc -c <"$OUT/bundle.tar.enc" | tr -d ' ')"
