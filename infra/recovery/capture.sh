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
MAINT_FILE="${GRATIS_RECOVERY_MAINTENANCE_FILE:-}"
SECRETS_KEY=""
SECRET_FILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --recovery-key-file) RECOVERY_KEY="$2"; shift 2 ;;
    --credential-key-file) CREDENTIAL_KEY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    --maintenance-file) MAINT_FILE="$2"; shift 2 ;;
    --secrets-key-file) SECRETS_KEY="$2"; shift 2 ;;
    --secret-file) SECRET_FILES+=("$2"); shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done

recovery_confirm_project "$CONFIRM"
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || recovery_die 'compose file is required'
[[ -n "$RECOVERY_KEY" && -f "$RECOVERY_KEY" ]] || recovery_die 'recovery key file is required'
[[ -n "$CREDENTIAL_KEY" && -f "$CREDENTIAL_KEY" ]] || recovery_die 'credential key file is required'
[[ -n "$OUT" ]] || recovery_die 'output directory is required'
[[ -n "$SECRETS_KEY" && -f "$SECRETS_KEY" ]] || recovery_die 'secrets key file is required; names alone are not a recoverable copy'
[[ ${#SECRET_FILES[@]} -gt 0 ]] || recovery_die 'at least one --secret-file label=path is required'
if cmp -s "$SECRETS_KEY" "$RECOVERY_KEY"; then
  recovery_die 'the secrets key must be a different file from the recovery passphrase'
fi

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

stopped_ids=()
stopped_names=()
MAINT_CREATED=0
resume() {
  local i
  for ((i=${#stopped_ids[@]}-1; i>=0; i--)); do
    docker start "${stopped_ids[$i]}" >/dev/null 2>&1 || true
  done
}
clear_maintenance() {
  if [[ "$MAINT_CREATED" == 1 && -n "$MAINT_FILE" ]]; then
    rm -f "$MAINT_FILE"
    MAINT_CREATED=0
  fi
}
fail() {
  write_status failed capture "$1"
  resume
  clear_maintenance
  rm -rf "$STAGE" "$OUT/bundle.tar" "$OUT/bundle.tar.enc" "$OUT/secrets.tar.enc" 2>/dev/null || true
  recovery_die "$1"
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
chmod 700 "$OUT" "$STAGE"

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

# Maintenance is raised before any snapshot. A capture failure clears
# it again, because capture does not change the databases. A partial
# restore keeps its own maintenance file.
if [[ -n "$MAINT_FILE" && ! -e "$MAINT_FILE" ]]; then
  mkdir -p "$(dirname "$MAINT_FILE")"
  printf '%s\n' '{"maintenance":true,"phase":"capture"}' >"$MAINT_FILE"
  chmod 644 "$MAINT_FILE"
  MAINT_CREATED=1
fi

# Stop writers that are running. A stopped service stays stopped.
# MinIO is stopped too: a bucket policy does not stop root or an IAM
# Allow on the image we ship, so the process has to be down before
# the data directory is copied. Browser, presigned, and script
# clients then cannot write. Only services this run stopped are
# started again, including when a later step fails.
mapfile -t SERVICES < <(compose config --services)
printf '%s\n' "${SERVICES[@]}" | grep -qx minio || fail 'unsupported-concurrent-write: this compose file has no minio service to isolate'
if ! printf '%s\n' "${SERVICES[@]}" | grep -qx portal-api; then
  [[ "${GRATIS_RECOVERY_EXTERNAL_API:-}" == "stopped" ]] || fail 'unsupported-concurrent-write: portal-api is not in this compose file and GRATIS_RECOVERY_EXTERNAL_API is not stopped'
fi
stop_if_running() {
  local svc="$1"
  local cid state
  printf '%s\n' "${SERVICES[@]}" | grep -qx "$svc" || return 0
  cid="$(compose ps -aq "$svc" 2>/dev/null | head -n 1 || true)"
  [[ -n "$cid" ]] || return 0
  state="$(docker inspect -f '{{.State.Status}}' "$cid")"
  case "$state" in
    running)
      docker stop "$cid" >/dev/null || fail "could not stop ${svc}"
      stopped_ids+=("$cid")
      stopped_names+=("$svc")
      ;;
    exited|created|dead|removing)
      ;;
    *)
      fail "writer ${svc} is ${state}; refusing to snapshot while it can write"
      ;;
  esac
}
for svc in portal-api portal-web portal-worker pointcloud-worker script-runner script-executor keycloak minio; do
  stop_if_running "$svc"
done
trap 'resume; clear_maintenance; rm -rf "$STAGE"' EXIT
if [[ -n "${GRATIS_RECOVERY_WHILE_QUIESCED:-}" ]]; then
  "$GRATIS_RECOVERY_WHILE_QUIESCED" || fail 'quiesce check failed; a writer could still store an object'
fi
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

MINIO_CID="$(compose ps -aq minio | head -n 1)"
[[ -n "$MINIO_CID" ]] || fail 'minio container does not exist; cannot copy its data volume'
MINIO_VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$MINIO_CID")"
[[ -n "$MINIO_VOL" ]] || fail 'minio data volume was not found'
# The MinIO image has no tar. Use a separate image, publish no ports,
# and attach no network. MinIO itself is already stopped.
COPY_IMAGE="${GRATIS_RECOVERY_COPY_IMAGE:-node:24.22.2-bookworm-slim}"
docker run --rm --network none --entrypoint tar \
  -v "${MINIO_VOL}:/data:ro" \
  -v "$STAGE:/out" \
  "$COPY_IMAGE" \
  -C /data -cf /out/minio-data.tar . \
  || fail 'object store copy failed'
mv "$STAGE/minio-data.tar" "$STAGE/minio.tar"
MINIO_JSON='{"objectCount":null,"totalBytes":0,"layout":"minio-data-dir"}'
maybe_fail minio

mapfile -t IMAGES < <(compose config --images | sort -u)
export PAUSED="${stopped_names[*]:-}"
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
            "layout": "minio-data-dir",
            "objectCount": minio.get("objectCount"),
            "totalBytes": files["minio.tar"]["bytes"],
        },
    },
    "images": images,
    "credentialKeySha256": hashlib.sha256(key).hexdigest(),
    "quiesce": {
        "stoppedWriters": paused,
        "minioStopped": True,
        "mechanism": "process-stop",
    },
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
# Sealed copy of the operator's secret files. The secrets key is not
# the recovery passphrase and is not inside either archive.
SECRET_STAGE="$STAGE/secrets"
mkdir -p "$SECRET_STAGE"
chmod 700 "$SECRET_STAGE"
for spec in "${SECRET_FILES[@]}"; do
  label="${spec%%=*}"
  path="${spec#*=}"
  [[ "$label" != "$spec" && -n "$label" && -f "$path" ]] || fail 'a secret file is missing'
  [[ "$label" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || fail 'a secret label is not a plain name'
  cp "$path" "$SECRET_STAGE/$label"
  chmod 600 "$SECRET_STAGE/$label"
done
tar -C "$SECRET_STAGE" -cf "$STAGE/secrets.tar" .
"$NODE" "$HERE/seal.mjs" enc "$SECRETS_KEY" "$STAGE/secrets.tar" "$OUT/secrets.tar.enc"
rm -f "$STAGE/secrets.tar"
chmod 600 "$OUT/secrets.tar.enc"
cat >"$OUT/required-separately.json" <<'EOF'
{
  "sealedSecrets": "secrets.tar.enc",
  "openWith": "secrets key file, kept separate from the recovery passphrase and from both archives",
  "alsoSeparate": ["recovery passphrase file"],
  "why": "The data bundle does not contain passwords or keys. secrets.tar.enc is the recoverable copy of the files named at capture. Losing the secrets key loses those files. Losing the recovery passphrase loses the databases and objects."
}
EOF
chmod 644 "$OUT/required-separately.json"
resume
clear_maintenance
trap 'rm -rf "$STAGE"' EXIT
write_status succeeded local-capture 'sealed bundle written'
printf 'recovery: local capture sealed (%s bytes)\n' "$(wc -c <"$OUT/bundle.tar.enc" | tr -d ' ')"
