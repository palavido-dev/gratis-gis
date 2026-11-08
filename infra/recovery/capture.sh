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
{"outcome":"$1","phase":"$2","kind":"local-capture","portalDownload":false,"secondaryFileVerified":false,"sameDisk":false,"offsiteVerified":false,"immutable":false,"detail":"$3"}
EOF
  chmod 644 "$STATUS_FILE"
}

FROZEN=0
paused_ids=()
pause_names=()
thaw() {
  if [[ "$FROZEN" == 1 ]]; then
    MINIO_ENDPOINT="${MINIO_ENDPOINT:-}" MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-}" MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-}" \
      python3 "$HERE/minio_copy.py" thaw "$BUCKET" >/dev/null 2>&1 || true
    FROZEN=0
  fi
}
unpause() {
  local cid
  for cid in "${paused_ids[@]+"${paused_ids[@]}"}"; do
    docker unpause "$cid" >/dev/null 2>&1 || true
  done
}
fail() {
  write_status failed capture "$1"
  thaw
  unpause
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

# Quiesce writers this compose file defines. A service that is not in
# the file is not a writer on this stack. A service that is stopped
# stays stopped: capture never starts it. A running writer that will
# not pause fails the capture. Only containers this run paused are
# unpaused, including when a later step fails.
mapfile -t SERVICES < <(compose config --services)
for svc in keycloak portal-api portal-web portal-worker pointcloud-worker script-runner script-executor; do
  if printf '%s\n' "${SERVICES[@]}" | grep -qx "$svc"; then
    cid="$(compose ps -aq "$svc" 2>/dev/null | head -n 1 || true)"
    if [[ -z "$cid" ]]; then
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$cid")"
    case "$state" in
      running)
        docker pause "$cid" >/dev/null || fail "could not pause ${svc}"
        paused_ids+=("$cid")
        pause_names+=("$svc")
        ;;
      exited|created|dead|removing)
        ;;
      *)
        fail "writer ${svc} is ${state} and was not paused"
        ;;
    esac
  fi
done
# Deny new puts and deletes. MinIO's root user bypasses a bucket
# policy, so this stops a non-root upload credential. Writer
# containers are paused separately, including one that uses root.
# Thaw removes the policy, including when a later step fails.
if MINIO_ENDPOINT="${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}" \
   MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?}" \
   MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?}" \
   python3 "$HERE/minio_copy.py" freeze "$BUCKET" >/dev/null; then
  FROZEN=1
else
  fail 'could not freeze object writes'
fi
trap 'thaw; unpause; rm -rf "$STAGE"' EXIT
maybe_fail() {
  if [[ "${GRATIS_RECOVERY_FAIL_AFTER:-}" == "$1" ]]; then
    fail "stopped after ${1} on purpose"
  fi
}

compose exec -T -e PGOPTIONS='-c lock_timeout=15000' postgres \
  pg_dump -U "${POSTGRES_USER:-gratisgis}" -d "$PORTAL_DB" -Fc --no-owner --no-privileges >"$STAGE/portal.dump" \
  || fail 'portal database dump failed'
compose exec -T -e PGOPTIONS='-c lock_timeout=15000' postgres \
  pg_dump -U "${POSTGRES_USER:-gratisgis}" -d "$KEYCLOAK_DB" -Fc >"$STAGE/keycloak.dump" \
  || fail 'keycloak database dump failed'
[[ -s "$STAGE/portal.dump" && -s "$STAGE/keycloak.dump" ]] || fail 'a database dump is empty'
maybe_fail portal-dump

MINIO_DIR="$STAGE/minio"
MINIO_JSON="$(
  MINIO_ENDPOINT="${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}" \
  MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?}" \
  MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?}" \
  python3 "$HERE/minio_copy.py" pull "$BUCKET" "$MINIO_DIR"
)" || fail 'object store copy failed'
tar -C "$STAGE" -cf "$STAGE/minio.tar" minio
rm -rf "$MINIO_DIR"
maybe_fail minio

mapfile -t IMAGES < <(compose config --images | sort -u)
export PAUSED="${pause_names[*]:-}"
export IMAGES_JOINED
IMAGES_JOINED="$(printf '%s\n' "${IMAGES[@]+"${IMAGES[@]}"}")"
python3 - "$STAGE/manifest.json" "$CREDENTIAL_KEY" "$MINIO_JSON" <<'PY'
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
images = [p for p in os.environ.get("IMAGES_JOINED", "").split("\n") if p]
doc = {
    "kind": "gratis-recovery-bundle",
    "format": 2,
    "encryption": "aes-256-gcm",
    "components": {
        "portalDatabase": files["portal.dump"],
        "keycloakDatabase": files["keycloak.dump"],
        "minio": {
            **files["minio.tar"],
            "objectCount": minio["objectCount"],
            "totalBytes": minio["totalBytes"],
        },
    },
    "images": images,
    "credentialKeySha256": hashlib.sha256(key).hexdigest(),
    "quiesce": {"pausedWriters": paused, "objectWritesFrozen": True},
    "notIncluded": [
        "CREDENTIAL_ENCRYPTION_KEY",
        "recovery passphrase",
        "POSTGRES_PASSWORD",
        "KEYCLOAK_DB_PASSWORD",
        "MINIO_ROOT_PASSWORD",
        "KEYCLOAK_CLIENT_SECRET_WEB",
        "KEYCLOAK_ADMIN_CLIENT_SECRET",
        "NEXTAUTH_SECRET",
    ],
    "distinguishes": {
        "localCapture": True,
        "portalDownload": False,
        "secondaryFileVerified": False,
        "sameDisk": False,
        "offsiteVerified": False,
        "immutable": False,
    },
}
pathlib.Path(out).write_text(json.dumps(doc, indent=2) + "\n")
PY

tar -C "$STAGE" -cf "$OUT/bundle.tar" manifest.json portal.dump keycloak.dump minio.tar
NODE="$(recovery_node)"
"$NODE" "$HERE/seal.mjs" enc "$RECOVERY_KEY" "$OUT/bundle.tar" "$OUT/bundle.tar.enc"
rm -f "$OUT/bundle.tar"
chmod 600 "$OUT/bundle.tar.enc"
sha="$(recovery_sha256 "$OUT/bundle.tar.enc")"
printf '%s  bundle.tar.enc\n' "$sha" >"$OUT/bundle.tar.enc.sha256"
chmod 644 "$OUT/bundle.tar.enc.sha256"
# Names only. Values stay in the operator's own files.
cat >"$OUT/required-separately.json" <<'EOF'
{
  "indispensable": [
    "recovery passphrase file",
    "CREDENTIAL_ENCRYPTION_KEY file",
    "POSTGRES_PASSWORD",
    "KEYCLOAK_DB_PASSWORD",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "KEYCLOAK_CLIENT_SECRET_WEB",
    "KEYCLOAK_ADMIN_CLIENT_SECRET",
    "NEXTAUTH_SECRET"
  ],
  "why": "Role passwords and object credentials are not inside a database dump. The recovery passphrase and the credential key are not in the bundle. The portal will not boot or decrypt credentials without these files, kept outside the archive."
}
EOF
chmod 644 "$OUT/required-separately.json"
thaw
unpause
trap 'rm -rf "$STAGE"' EXIT
write_status succeeded local-capture 'sealed bundle written'
printf 'recovery: local capture sealed (%s bytes)\n' "$(wc -c <"$OUT/bundle.tar.enc" | tr -d ' ')"
