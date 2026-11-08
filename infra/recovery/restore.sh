#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Restore a host recovery bundle into a running GratisGIS project.
#
#   GRATIS_RECOVERY_PROJECT=gratis-gis-prod \
#     infra/recovery/restore.sh \
#       --confirm-project gratis-gis-prod \
#       --compose-file infra/docker-compose.prod.yml \
#       --recovery-key-file /path/to/recovery.key \
#       --credential-key-file /path/to/credential.key \
#       --bundle /path/to/out-dir/latest.tar.enc \
#       [--safety-out /path/to/pre-restore] [--allow-version-mismatch]
#
# Order: check the project, decrypt and verify the bundle inside a
# 0700 staging directory, compare the bundle's images and latest
# Prisma migration with the running stack, then raise maintenance,
# stop every writer, and seal the current state as a safety bundle.
# Only after that safety bundle is written are the Keycloak database,
# the portal database, and the MinIO data directory replaced. Each
# database is restored in one transaction that stops on the first
# error. A failure before the first database write starts the stopped
# writers again and removes the maintenance file. A failure after it is
# a partial restore: writers stay stopped, maintenance stays, and the
# safety bundle path is printed.
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
SAFETY_OUT=""
ALLOW_VERSION_MISMATCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --recovery-key-file) RECOVERY_KEY="$2"; shift 2 ;;
    --credential-key-file) CREDENTIAL_KEY="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    --maintenance-file) MAINT_FILE="$2"; shift 2 ;;
    --safety-out) SAFETY_OUT="$2"; shift 2 ;;
    --allow-version-mismatch) ALLOW_VERSION_MISMATCH=1; shift ;;
    *) recovery_die "unknown argument" ;;
  esac
done

recovery_confirm_project "$CONFIRM"
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || recovery_die 'compose file is required'
[[ -n "$RECOVERY_KEY" && -f "$RECOVERY_KEY" ]] || recovery_die 'recovery key file is required'
[[ -n "$CREDENTIAL_KEY" && -f "$CREDENTIAL_KEY" ]] || recovery_die 'credential key file is required'
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || recovery_die 'bundle is required'
BUNDLE="$(readlink -f "$BUNDLE")"
if [[ -z "$SAFETY_OUT" ]]; then
  SAFETY_OUT="$(dirname "$BUNDLE")/pre-restore"
fi

PROJECT="$GRATIS_RECOVERY_PROJECT"
PORTAL_DB="${GRATIS_RECOVERY_PORTAL_DB:-gratisgis}"
KEYCLOAK_DB="${GRATIS_RECOVERY_KEYCLOAK_DB:-keycloak}"
FAIL_AFTER="${GRATIS_RECOVERY_FAIL_AFTER:-}"

STATUS_WRITTEN=0
write_status() {
  [[ -n "$STATUS_FILE" ]] || return 0
  local maint="${4:-false}"
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat >"$STATUS_FILE" <<EOF
{"outcome":"$1","phase":"$2","kind":"restore","portalDownload":false,"secondaryFileVerified":false,"sameDisk":false,"offsiteVerified":false,"immutable":false,"maintenance":${maint},"detail":"$3"}
EOF
  chmod 644 "$STATUS_FILE"
  STATUS_WRITTEN=1
}

# The project must be a real GratisGIS stack before anything else.
recovery_require_stack

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gg-restore.XXXXXX")"
chmod 700 "$STAGE"
MAINT_CREATED=0
DATA_TOUCHED=0
DONE=0
SAFETY_BUNDLE=""
on_exit() {
  local rc=$?
  if [[ "$DONE" != 1 ]]; then
    if [[ "$DATA_TOUCHED" == 1 ]]; then
      # Partial restore. Leave writers stopped and maintenance up so
      # nothing serves a mix of old and new data.
      [[ "$STATUS_WRITTEN" == 1 ]] || write_status failed partial 'restore stopped after data was changed' true
      if [[ -n "$SAFETY_BUNDLE" ]]; then
        printf 'recovery: the state before this restore is sealed in %s\n' "$SAFETY_BUNDLE" >&2
      fi
    else
      [[ "$STATUS_WRITTEN" == 1 ]] || write_status failed preflight 'restore stopped before any data was changed' false
      recovery_start_stopped
      if [[ "$MAINT_CREATED" == 1 && -n "$MAINT_FILE" ]]; then
        rm -f "$MAINT_FILE"
      fi
    fi
  fi
  rm -rf "$STAGE"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

fail() {
  if [[ "$DATA_TOUCHED" == 1 ]]; then
    write_status failed partial "$1" true
  else
    write_status failed preflight "$1" false
  fi
  recovery_die "$1"
}
fail_phase() {
  write_status failed "$1" "$2" false
  recovery_die "$2"
}

# Decrypt into STAGE (0700). seal.mjs writes the plaintext inside its
# own 0700 directory and moves it here only after every record has
# verified, so a tampered bundle leaves no plaintext behind.
NODE="$(recovery_node)"
[[ -n "$NODE" ]] || fail_phase decrypt 'node was not found for seal.mjs'
if ! "$NODE" "$HERE/seal.mjs" dec "$RECOVERY_KEY" "$BUNDLE" "$STAGE/bundle.tar"; then
  fail_phase decrypt 'recovery key could not open the bundle'
fi
# A plain tar is no larger than its members, so the tar's own size is
# the extraction cap unless the operator sets a smaller one.
BUNDLE_TAR_BYTES="$(stat -c %s "$STAGE/bundle.tar")"
if ! GRATIS_RECOVERY_MAX_UNCOMPRESSED="${GRATIS_RECOVERY_MAX_UNCOMPRESSED:-$BUNDLE_TAR_BYTES}" \
  python3 "$HERE/safe_untar.py" "$STAGE/bundle.tar" "$STAGE/unpacked"; then
  fail_phase verify 'bundle archive was rejected'
fi
rm -f "$STAGE/bundle.tar"
for name in manifest.json portal.dump keycloak.dump minio.tar; do
  if [[ -f "$STAGE/unpacked/$name" ]]; then
    mv "$STAGE/unpacked/$name" "$STAGE/$name"
  fi
done

if ! python3 - "$STAGE/manifest.json" "$STAGE" "$CREDENTIAL_KEY" <<'PY'
import hashlib, json, pathlib, sys
manifest_path, stage_s, key_path = sys.argv[1:]
stage = pathlib.Path(stage_s)
need = ("portal.dump", "keycloak.dump", "minio.tar", "manifest.json")
for name in need:
    if not (stage / name).is_file():
        raise SystemExit(f"missing {name}")
doc = json.loads(pathlib.Path(manifest_path).read_text())

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
    return h.hexdigest(), n

files = {
    "portal.dump": doc["components"]["portalDatabase"],
    "keycloak.dump": doc["components"]["keycloakDatabase"],
    "minio.tar": doc["components"]["minio"],
}
for name, meta in files.items():
    got, size = digest(stage / name)
    if got != meta["sha256"] or size != meta["bytes"]:
        raise SystemExit(f"checksum mismatch for {name}")
    if size == 0:
        raise SystemExit(f"empty component {name}")
got = hashlib.sha256(pathlib.Path(key_path).read_bytes()).hexdigest()
if got != doc["credentialKeySha256"]:
    raise SystemExit("credential key fingerprint does not match this bundle")
PY
then
  fail_phase verify 'bundle is incomplete or the credential key does not match'
fi

# Version check. The bundle records the images its stack ran and the
# latest applied Prisma migration. Restoring a dump into different code
# is refused unless the operator says so.
recovery_images >"$STAGE/running-images.txt" || fail_phase version 'could not list the running stack images'
RUNNING_MIGRATION="$(recovery_latest_migration "$PORTAL_DB")" || fail_phase version 'could not read the running portal migration history'
export RUNNING_MIGRATION
if ! python3 - "$STAGE/manifest.json" "$STAGE/running-images.txt" <<'PY'
import json, os, pathlib, sys
manifest_path, images_path = sys.argv[1:]
doc = json.loads(pathlib.Path(manifest_path).read_text())
problems = []
if "images" not in doc or "latestMigration" not in doc:
    problems.append("bundle does not record its images and migration")
else:
    recorded = {(i.get("ref", ""), i.get("id", "")) for i in doc["images"]}
    running = set()
    for line in pathlib.Path(images_path).read_text().splitlines():
        if line:
            ref, _, image_id = line.partition("|")
            running.add((ref, image_id))
    for ref, image_id in sorted(recorded - running):
        problems.append(f"bundle image not running: {ref} {image_id or '(no id)'}")
    for ref, image_id in sorted(running - recorded):
        problems.append(f"running image not in bundle: {ref} {image_id or '(no id)'}")
    want = doc["latestMigration"] or "(none)"
    have = os.environ.get("RUNNING_MIGRATION", "") or "(none)"
    if want != have:
        problems.append(f"latest migration: bundle {want}, running {have}")
for p in problems:
    print(f"recovery: {p}", file=sys.stderr)
raise SystemExit(1 if problems else 0)
PY
then
  if [[ "$ALLOW_VERSION_MISMATCH" == 1 ]]; then
    printf 'recovery: continuing with a version mismatch because --allow-version-mismatch was passed\n' >&2
  else
    fail_phase version 'bundle was captured from a different version; pass --allow-version-mismatch only if you mean it'
  fi
fi

# Object archive and volume checks, still before any change.
MINIO_CID="$(recovery_compose ps -aq minio 2>/dev/null | head -n 1 || true)"
[[ -n "$MINIO_CID" ]] || fail_phase preflight 'minio container is missing'
MINIO_VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$MINIO_CID")"
[[ -n "$MINIO_VOL" ]] || fail_phase preflight 'minio data volume was not found'
# The data directory has more members than the outer bundle. Reject
# traversal, links, and an oversized archive before anything is written.
if ! GRATIS_RECOVERY_MAX_MEMBERS="${GRATIS_RECOVERY_DATA_MAX_MEMBERS:-1000000}" \
  GRATIS_RECOVERY_MAX_UNCOMPRESSED="${GRATIS_RECOVERY_MAX_UNCOMPRESSED:-$(stat -c %s "$STAGE/minio.tar")}" \
  python3 "$HERE/safe_untar.py" check "$STAGE/minio.tar"; then
  fail_phase verify 'object archive was rejected'
fi

# All checks passed. Raise maintenance, then stop the same writers
# capture.sh stops so nothing writes during the restore.
# Restore owns the file from here: it is removed on success and on any
# failure before data changes, and kept after a partial restore.
if [[ -n "$MAINT_FILE" ]]; then
  mkdir -p "$(dirname "$MAINT_FILE")"
  printf '%s\n' '{"maintenance":true,"phase":"restore"}' >"$MAINT_FILE"
  chmod 644 "$MAINT_FILE"
  MAINT_CREATED=1
fi
recovery_stop_writers

# Safety bundle of the current state. Writers are already stopped, so
# capture.sh copies a quiet stack and leaves them stopped. No data is
# changed unless this succeeds.
mkdir -p "$SAFETY_OUT"
if ! env -u GRATIS_RECOVERY_WHILE_QUIESCED -u GRATIS_RECOVERY_FAIL_AFTER -u GRATIS_RECOVERY_MAINTENANCE_FILE \
  "$HERE/capture.sh" \
  --confirm-project "$PROJECT" \
  --compose-file "$COMPOSE_FILE" \
  --recovery-key-file "$RECOVERY_KEY" \
  --credential-key-file "$CREDENTIAL_KEY" \
  --out "$SAFETY_OUT" \
  --data-only >"$STAGE/safety.log" 2>&1; then
  sed 's/^/  /' "$STAGE/safety.log" >&2 || true
  fail 'pre-restore safety bundle failed; nothing was restored'
fi
SAFETY_BUNDLE="$(readlink -f "$SAFETY_OUT/latest.tar.enc")"
printf 'recovery: current state sealed in %s\n' "$SAFETY_BUNDLE"

restore_db() {
  local db="$1" dump="$2"
  # One transaction per database, stopping on the first error, so a
  # failed database is left as it was. Keycloak keeps its own
  # ownership and grants. The portal database is restored as the
  # application role, which is the user that dumps it.
  if [[ "$db" == "$KEYCLOAK_DB" ]]; then
    recovery_compose exec -T postgres pg_restore -U "${POSTGRES_USER:-gratisgis}" -d "$db" \
      --clean --if-exists --exit-on-error --single-transaction <"$dump" >/dev/null
  else
    recovery_compose exec -T postgres pg_restore -U "${POSTGRES_USER:-gratisgis}" -d "$db" \
      --clean --if-exists --exit-on-error --single-transaction --no-owner --no-privileges <"$dump" >/dev/null
  fi
}

DATA_TOUCHED=1
if ! restore_db "$KEYCLOAK_DB" "$STAGE/keycloak.dump"; then
  fail 'keycloak database restore failed'
fi
if [[ "$FAIL_AFTER" == "keycloak" ]]; then
  fail 'stopped after keycloak on purpose; portal and objects were not restored'
fi
if ! restore_db "$PORTAL_DB" "$STAGE/portal.dump"; then
  fail 'portal database restore failed after keycloak was replaced'
fi

# The MinIO image has no shell, so a separate image extracts the tar.
# No ports are published and the network is none. MinIO is stopped.
COPY_IMAGE="${GRATIS_RECOVERY_COPY_IMAGE:-node:24.22.2-bookworm-slim}"
docker run --rm --network none --entrypoint sh \
  -v "${MINIO_VOL}:/data" \
  -v "$STAGE/minio.tar:/in/minio.tar:ro" \
  "$COPY_IMAGE" \
  -c 'find /data -mindepth 1 -delete && tar -C /data -xf /in/minio.tar' \
  || fail 'object restore failed after the databases were replaced'

DONE=1
recovery_start_stopped
if [[ "$MAINT_CREATED" == 1 && -n "$MAINT_FILE" ]]; then
  rm -f "$MAINT_FILE"
fi
write_status succeeded restored 'keycloak, portal, and objects restored' false
printf 'recovery: restore finished\n'
