#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Opt-in host capture of a GratisGIS compose project.
# Portal database, Keycloak database, and MinIO objects. The credential
# encryption key is not stored; only its sha256 is recorded so a later
# restore can refuse a different key. The recovery passphrase is read
# from a file and is not written into the bundle.
#
#   GRATIS_RECOVERY_PROJECT=gratis-gis-prod \
#     infra/recovery/capture.sh \
#       --confirm-project gratis-gis-prod \
#       --compose-file infra/docker-compose.prod.yml \
#       --recovery-key-file /path/to/recovery.key \
#       --credential-key-file /path/to/credential.key \
#       --secrets-key-file /path/to/secrets.key \
#       --secret-file env=/path/to/.env \
#       --out /path/to/out-dir
#
# Each run writes new files named by UTC time, bundle-<ts>.tar.enc and
# secrets-<ts>.tar.enc, and points latest.tar.enc and
# latest-secrets.tar.enc at them. It never replaces or deletes an
# earlier bundle. Plaintext only exists inside a 0700 staging
# directory that is removed on every exit.
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
DATA_ONLY=0
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
    # Databases and objects only. restore.sh uses this for its
    # pre-restore safety bundle; restore does not change secret files.
    --data-only) DATA_ONLY=1; shift ;;
    *) recovery_die "unknown argument" ;;
  esac
done

recovery_confirm_project "$CONFIRM"
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || recovery_die 'compose file is required'
[[ -n "$RECOVERY_KEY" && -f "$RECOVERY_KEY" ]] || recovery_die 'recovery key file is required'
[[ -n "$CREDENTIAL_KEY" && -f "$CREDENTIAL_KEY" ]] || recovery_die 'credential key file is required'
[[ -n "$OUT" ]] || recovery_die 'output directory is required'
if [[ "$DATA_ONLY" != 1 ]]; then
  [[ -n "$SECRETS_KEY" && -f "$SECRETS_KEY" ]] || recovery_die 'secrets key file is required; names alone are not a recoverable copy'
  [[ ${#SECRET_FILES[@]} -gt 0 ]] || recovery_die 'at least one --secret-file label=path is required'
  if cmp -s "$SECRETS_KEY" "$RECOVERY_KEY"; then
    recovery_die 'the secrets key must be a different file from the recovery passphrase'
  fi
  for spec in "${SECRET_FILES[@]}"; do
    label="${spec%%=*}"
    path="${spec#*=}"
    [[ "$label" != "$spec" && -n "$label" && -f "$path" ]] || recovery_die 'a secret file is missing'
    [[ "$label" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || recovery_die 'a secret label is not a plain name'
  done
fi

PROJECT="$GRATIS_RECOVERY_PROJECT"
PORTAL_DB="${GRATIS_RECOVERY_PORTAL_DB:-gratisgis}"
KEYCLOAK_DB="${GRATIS_RECOVERY_KEYCLOAK_DB:-keycloak}"

# The project must be a real GratisGIS stack before anything changes.
recovery_require_stack

STATUS_WRITTEN=0
write_status() {
  [[ -n "$STATUS_FILE" ]] || return 0
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"outcome":"$1","phase":"$2","kind":"local-capture","portalDownload":false,"secondaryFileVerified":false,"sameDisk":false,"offsiteVerified":false,"immutable":false,"detail":"$3"}
EOF
  chmod 644 "$STATUS_FILE"
  STATUS_WRITTEN=1
}

MAINT_CREATED=0
clear_maintenance() {
  if [[ "$MAINT_CREATED" == 1 && -n "$MAINT_FILE" ]]; then
    rm -f "$MAINT_FILE"
    MAINT_CREATED=0
  fi
}

TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
chmod 700 "$OUT"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery.XXXXXX")"
chmod 700 "$STAGE"
# Sealed output is written under temporary names in OUT and published
# with a hard link, which fails instead of replacing an existing name.
TMP_BUNDLE="$OUT/.bundle-${TS}.$$.partial"
TMP_SECRETS="$OUT/.secrets-${TS}.$$.partial"
TMP_SUM="$OUT/.bundle-${TS}.$$.sha256.partial"
DONE=0
on_exit() {
  local rc=$?
  if [[ "$DONE" != 1 ]]; then
    [[ "$STATUS_WRITTEN" == 1 ]] || write_status failed capture 'capture stopped on an unexpected error'
    recovery_start_stopped
    clear_maintenance
  fi
  rm -f "$TMP_BUNDLE" "$TMP_SECRETS" "$TMP_SUM"
  rm -rf "$STAGE"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

fail() {
  write_status failed capture "$1"
  recovery_die "$1"
}

# Maintenance is raised before any snapshot, after the checks above.
# A capture failure clears it again, because capture does not change
# the databases. A file that already existed (a restore's) is left.
if [[ -n "$MAINT_FILE" && ! -e "$MAINT_FILE" ]]; then
  mkdir -p "$(dirname "$MAINT_FILE")"
  printf '%s\n' '{"maintenance":true,"phase":"capture"}' >"$MAINT_FILE"
  chmod 644 "$MAINT_FILE"
  MAINT_CREATED=1
fi

# Stop writers that are running. MinIO is stopped too: a bucket policy
# does not stop root or an IAM Allow on the image we ship, so the
# process has to be down before the data directory is copied. Only
# services this run stopped are started again, including on failure.
recovery_stop_writers
if [[ -n "${GRATIS_RECOVERY_WHILE_QUIESCED:-}" ]]; then
  "$GRATIS_RECOVERY_WHILE_QUIESCED" || fail 'quiesce check failed; a writer could still store an object'
fi
maybe_fail() {
  if [[ "${GRATIS_RECOVERY_FAIL_AFTER:-}" == "$1" ]]; then
    fail "stopped after ${1} on purpose"
  fi
}

recovery_compose exec -T -e PGOPTIONS='-c lock_timeout=15000' postgres \
  pg_dump -U "${POSTGRES_USER:-gratisgis}" -d "$PORTAL_DB" -Fc --no-owner --no-privileges >"$STAGE/portal.dump" \
  || fail 'portal database dump failed'
recovery_compose exec -T -e PGOPTIONS='-c lock_timeout=15000' postgres \
  pg_dump -U "${POSTGRES_USER:-gratisgis}" -d "$KEYCLOAK_DB" -Fc >"$STAGE/keycloak.dump" \
  || fail 'keycloak database dump failed'
[[ -s "$STAGE/portal.dump" && -s "$STAGE/keycloak.dump" ]] || fail 'a database dump is empty'
LATEST_MIGRATION="$(recovery_latest_migration "$PORTAL_DB")" || fail 'could not read the portal migration history'
maybe_fail portal-dump

MINIO_CID="$(recovery_compose ps -aq minio | head -n 1)"
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
maybe_fail minio

recovery_images >"$STAGE/images.txt" || fail 'could not list the stack images'
export PAUSED="${RECOVERY_STOPPED_NAMES[*]:-}"
export LATEST_MIGRATION
python3 - "$STAGE/manifest.json" "$CREDENTIAL_KEY" "$STAGE/images.txt" <<'PY' || fail 'manifest could not be written'
import hashlib, json, os, pathlib, sys
out, key_path, images_path = sys.argv[1:]
stage = pathlib.Path(out).parent

def digest(path):
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
            n += len(b)
    return {"sha256": h.hexdigest(), "bytes": n}

files = {name: digest(stage / name) for name in ("portal.dump", "keycloak.dump", "minio.tar")}
paused = [p for p in os.environ.get("PAUSED", "").split(" ") if p]
images = []
for line in pathlib.Path(images_path).read_text().splitlines():
    if line:
        ref, _, image_id = line.partition("|")
        images.append({"ref": ref, "id": image_id})
key = pathlib.Path(key_path).read_bytes()
doc = {
    "kind": "gratis-recovery-bundle",
    "format": 3,
    "encryption": "aes-256-gcm",
    "components": {
        "portalDatabase": files["portal.dump"],
        "keycloakDatabase": files["keycloak.dump"],
        "minio": {
            **files["minio.tar"],
            "layout": "minio-data-dir",
            "objectCount": None,
            "totalBytes": files["minio.tar"]["bytes"],
        },
    },
    "images": images,
    "latestMigration": os.environ.get("LATEST_MIGRATION", ""),
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

# The plaintext tar is built inside STAGE (0700, removed on exit) and
# each component is removed once it is in the tar.
tar -C "$STAGE" -cf "$STAGE/bundle.tar" manifest.json portal.dump keycloak.dump minio.tar \
  || fail 'bundle archive could not be written'
rm -f "$STAGE/portal.dump" "$STAGE/keycloak.dump" "$STAGE/minio.tar"
NODE="$(recovery_node)"
[[ -n "$NODE" ]] || fail 'node was not found for seal.mjs'
"$NODE" "$HERE/seal.mjs" enc "$RECOVERY_KEY" "$STAGE/bundle.tar" "$TMP_BUNDLE" \
  || fail 'bundle could not be sealed'
rm -f "$STAGE/bundle.tar"

if [[ "$DATA_ONLY" != 1 ]]; then
  # Sealed copy of the operator's secret files. The secrets key is not
  # the recovery passphrase and is not inside either archive.
  SECRET_STAGE="$STAGE/secrets"
  mkdir -p "$SECRET_STAGE"
  chmod 700 "$SECRET_STAGE"
  for spec in "${SECRET_FILES[@]}"; do
    label="${spec%%=*}"
    path="${spec#*=}"
    cp "$path" "$SECRET_STAGE/$label" || fail 'a secret file could not be read'
    chmod 600 "$SECRET_STAGE/$label"
  done
  tar -C "$SECRET_STAGE" -cf "$STAGE/secrets.tar" . || fail 'secrets archive could not be written'
  rm -rf "$SECRET_STAGE"
  "$NODE" "$HERE/seal.mjs" enc "$SECRETS_KEY" "$STAGE/secrets.tar" "$TMP_SECRETS" \
    || fail 'secrets could not be sealed'
  rm -f "$STAGE/secrets.tar"
fi

# Publish. Each final name is new; ln refuses to replace one.
BUNDLE_NAME="bundle-${TS}.tar.enc"
SECRETS_NAME="secrets-${TS}.tar.enc"
publish() {
  ln "$1" "$OUT/$2" 2>/dev/null || fail "${2} already exists; refusing to replace it"
  rm -f "$1"
}
sha="$(recovery_sha256 "$TMP_BUNDLE")"
printf '%s  %s\n' "$sha" "$BUNDLE_NAME" >"$TMP_SUM"
chmod 644 "$TMP_SUM"
publish "$TMP_BUNDLE" "$BUNDLE_NAME"
publish "$TMP_SUM" "${BUNDLE_NAME}.sha256"
if [[ "$DATA_ONLY" != 1 ]]; then
  publish "$TMP_SECRETS" "$SECRETS_NAME"
fi
# Stable names for scripts and docs. A symlink is replaced by rename,
# so a reader sees the old target or the new one.
link_latest() {
  ln -sfn "$2" "$OUT/.$1.$$"
  mv -T "$OUT/.$1.$$" "$OUT/$1"
}
link_latest latest.tar.enc "$BUNDLE_NAME"
if [[ "$DATA_ONLY" != 1 ]]; then
  link_latest latest-secrets.tar.enc "$SECRETS_NAME"
  cat >"$OUT/.required-separately.json.$$" <<'EOF'
{
  "sealedSecrets": "latest-secrets.tar.enc (secrets-<timestamp>.tar.enc)",
  "openWith": "secrets key file, kept separate from the recovery passphrase and from both archives",
  "alsoSeparate": ["recovery passphrase file"],
  "why": "The data bundle does not contain passwords or keys. The secrets archive is the recoverable copy of the files named at capture. Losing the secrets key loses those files. Losing the recovery passphrase loses the databases and objects."
}
EOF
  chmod 644 "$OUT/.required-separately.json.$$"
  mv -T "$OUT/.required-separately.json.$$" "$OUT/required-separately.json"
fi

DONE=1
recovery_start_stopped
clear_maintenance
write_status succeeded local-capture 'sealed bundle written'
printf 'recovery: local capture sealed %s (%s bytes)\n' "$OUT/$BUNDLE_NAME" "$(wc -c <"$OUT/$BUNDLE_NAME" | tr -d ' ')"
