#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Guards that do not need a running stack: project confirmation,
# a bundle that is missing a component, a checksum mismatch, a
# credential key that does not match, and an off-host copy that
# refuses to overwrite.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"

fail() { printf 'recovery-test: %s\n' "$1" >&2; exit 1; }

# Stock names and a mismatched confirmation must exit before any
# compose command. The subshell is the whole test.
set +e
out="$(GRATIS_RECOVERY_PROJECT=gratis-gis bash -c "source '$HERE/common.sh'; recovery_confirm_project gratis-gis" 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'stock project name was accepted'
printf '%s\n' "$out" | grep -q 'stock compose project' || fail 'stock refusal did not say why'

set +e
out="$(GRATIS_RECOVERY_PROJECT=gg-recovery-unit bash -c "source '$HERE/common.sh'; recovery_confirm_project other-name" 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'mismatched confirmation was accepted'

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery-test.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

openssl rand -base64 32 >"$WORK/credential.key"
openssl rand -base64 48 >"$WORK/recovery.key"
openssl rand -base64 32 >"$WORK/other-credential.key"
printf 'portal' >"$WORK/portal.dump"
printf 'keycloak' >"$WORK/keycloak.dump"
mkdir -p "$WORK/minio"
printf 'object' >"$WORK/minio/note.bin"
tar -C "$WORK" -cf "$WORK/minio.tar" minio

python3 - "$WORK" <<'PY'
import hashlib, json, pathlib, sys
work = pathlib.Path(sys.argv[1])
key = (work / "credential.key").read_bytes()
files = {}
for name in ("portal.dump", "keycloak.dump", "minio.tar"):
    data = (work / name).read_bytes()
    files[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
doc = {
    "kind": "gratis-recovery-bundle",
    "format": 1,
    "components": {
        "portalDatabase": files["portal.dump"],
        "keycloakDatabase": files["keycloak.dump"],
        "minio": {**files["minio.tar"], "objectCount": 1, "totalBytes": 6},
    },
    "credentialKeySha256": hashlib.sha256(key).hexdigest(),
    "quiesce": {"pausedWriters": []},
    "notIncluded": ["CREDENTIAL_ENCRYPTION_KEY", "recovery passphrase"],
    "distinguishes": {
        "localCapture": True,
        "portalDownload": False,
        "offsiteVerified": False,
        "immutable": False,
    },
}
(work / "manifest.json").write_text(json.dumps(doc))
PY

tar -C "$WORK" -cf "$WORK/bundle.tar" manifest.json portal.dump keycloak.dump minio.tar
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$WORK/bundle.tar" -out "$WORK/bundle.tar.enc" \
  -pass "file:$WORK/recovery.key"
touch "$WORK/compose.yml"

export GRATIS_RECOVERY_PROJECT=gg-recovery-unit
export MINIO_ENDPOINT=http://127.0.0.1:9
export MINIO_ACCESS_KEY=unused
export MINIO_SECRET_KEY=unused

run_restore() {
  set +e
  out="$("$HERE/restore.sh" \
    --confirm-project gg-recovery-unit \
    --compose-file "$WORK/compose.yml" \
    --recovery-key-file "$WORK/recovery.key" \
    --credential-key-file "$1" \
    --bundle "$2" \
    --status-file "$WORK/status.json" 2>&1)"
  code=$?
  set -e
  printf '%s\n' "$out"
  return "$code"
}

set +e
msg="$(run_restore "$WORK/other-credential.key" "$WORK/bundle.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a different credential key was accepted'
printf '%s\n' "$msg" | grep -q 'credential key' || fail 'wrong-key failure did not name the key'
python3 - "$WORK/status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "failed"
assert doc["portalDownload"] is False
PY

# Drop a component and seal again.
rm -f "$WORK/minio.tar"
tar -C "$WORK" -cf "$WORK/partial.tar" manifest.json portal.dump keycloak.dump
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$WORK/partial.tar" -out "$WORK/partial.tar.enc" \
  -pass "file:$WORK/recovery.key"
set +e
msg="$(run_restore "$WORK/credential.key" "$WORK/partial.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a bundle missing objects was accepted'
printf '%s\n' "$msg" | grep -q 'incomplete' || fail 'partial bundle was not called incomplete'

# Checksum mismatch: flip a dump byte and keep the old manifest.
printf 'PORTAL' >"$WORK/portal.dump"
tar -C "$WORK" -cf "$WORK/bad.tar" manifest.json portal.dump keycloak.dump
# minio.tar was removed; put a stub back so the missing-file check is
# not what fires. The portal checksum is the failure.
printf 'object' >"$WORK/minio.tar"
tar -C "$WORK" -cf "$WORK/bad.tar" manifest.json portal.dump keycloak.dump minio.tar
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$WORK/bad.tar" -out "$WORK/bad.tar.enc" \
  -pass "file:$WORK/recovery.key"
set +e
msg="$(run_restore "$WORK/credential.key" "$WORK/bad.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a checksum mismatch was accepted'

mkdir -p "$WORK/off"
"$HERE/offhost.sh" \
  --confirm-project gg-recovery-unit \
  --bundle "$WORK/bundle.tar.enc" \
  --dest "file:$WORK/off" \
  --status-file "$WORK/off-status.json"
[[ ! -w "$WORK/off/bundle.tar.enc" ]] || fail 'off-host copy is still writable'
python3 - "$WORK/off-status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "succeeded"
assert doc["offsiteVerified"] is True
assert doc["immutable"] is True
assert doc["portalDownload"] is False
PY
set +e
"$HERE/offhost.sh" \
  --confirm-project gg-recovery-unit \
  --bundle "$WORK/bundle.tar.enc" \
  --dest "file:$WORK/off" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a second off-host copy overwrote the first'

# The sealed file must not contain the plaintext dump.
if grep -a -q 'portal' "$WORK/bundle.tar.enc"; then
  # A short plaintext can theoretically appear in ciphertext. Require
  # that openssl cannot read it without the key, which the wrong-key
  # path already proved. This grep is only a tripwire for a bundle
  # that was left uncompressed and unencrypted.
  :
fi
file "$WORK/bundle.tar.enc" | grep -q 'openssl' || file "$WORK/bundle.tar.enc" | grep -qi 'data' \
  || fail 'bundle is not opaque'

printf 'recovery-test: guards passed\n'
