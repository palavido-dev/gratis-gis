#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Guards that do not need a running stack. A fake docker on PATH
# answers the read-only compose queries for one project name and
# fails every command that would change a container, so a test that
# reaches a stop, start, run, or restore fails loudly.
#
# Covers: project confirmation, a wrong project name, a bundle that is
# missing a component, a checksum mismatch, a credential key that does
# not match, a version mismatch, maintenance cleanup on a failure
# before data changes, streaming seal and open of a 50 MB file, a
# tampered byte that leaves no plaintext, and an off-host copy that
# refuses to overwrite.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"

fail() { printf 'recovery-test: %s\n' "$1" >&2; exit 1; }

expect_refused() {
  local name="$1" code
  set +e
  out="$(GRATIS_RECOVERY_PROJECT="$name" bash -c "source '$HERE/common.sh'; recovery_confirm_project '$name'" 2>&1)"
  code=$?
  set -e
  [[ "$code" -ne 0 ]] || fail "project name ${name} was accepted"
}
expect_accepted() {
  GRATIS_RECOVERY_PROJECT="$1" bash -c "source '$HERE/common.sh'; recovery_confirm_project '$1'" \
    || fail "project name $1 was refused"
}

# The real compose names are accepted; generic ones are not.
expect_accepted gratis-gis-prod
expect_accepted gratis-gis
expect_refused default
printf '%s\n' "$out" | grep -q 'generic compose project' || fail 'generic refusal did not say why'
expect_refused compose

set +e
out="$(GRATIS_RECOVERY_PROJECT=gg-recovery-unit bash -c "source '$HERE/common.sh'; recovery_confirm_project other-name" 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'mismatched confirmation was accepted'

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery-test.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Fake docker. Only FAKE_PROJECT has containers.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
SERVICES=(postgres keycloak minio portal-api portal-worker)
if [[ "$1" == compose ]]; then
  shift
  project=""
  while [[ "$1" == -* ]]; do
    [[ "$1" == -p ]] && project="$2"
    shift 2
  done
  case "$1" in
    config)
      [[ "${2:-}" == --services ]] && printf '%s\n' "${SERVICES[@]}"
      exit 0
      ;;
    ps)
      [[ "$project" == "$FAKE_PROJECT" ]] && printf 'cid-%s\n' "${@: -1}"
      exit 0
      ;;
    exec)
      if [[ "$*" == *to_regclass* ]]; then
        printf 't\n'
      elif [[ "$*" == *_prisma_migrations* ]]; then
        printf '%s\n' "$FAKE_MIGRATION"
      else
        exit 1
      fi
      exit 0
      ;;
  esac
  exit 1
fi
case "$1" in
  ps)
    if [[ "$*" == *"com.docker.compose.project=${FAKE_PROJECT} "* ]]; then
      for svc in "${SERVICES[@]}" ${FAKE_EXTRA:-}; do
        printf 'cid-%s|%s|running\n' "$svc" "$svc"
      done
    fi
    ;;
  inspect)
    cid="${*: -1}"
    if [[ "$*" == *Labels* ]]; then
      printf '%s|sha256:%s\n' "${cid#cid-}" "${cid#cid-}"
    elif [[ "$*" == *Mounts* ]]; then
      printf 'vol-minio\n'
    else
      printf 'running\n'
    fi
    ;;
  *)
    # stop, start, run: anything that changes state.
    exit 1
    ;;
esac
SH
chmod 700 "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"
export FAKE_DOCKER_LOG="$WORK/docker.log"
export FAKE_PROJECT=gg-recovery-unit
export FAKE_MIGRATION=20260101000000_init
: >"$FAKE_DOCKER_LOG"

openssl rand -base64 32 >"$WORK/credential.key"
openssl rand -base64 48 >"$WORK/recovery.key"
openssl rand -base64 32 >"$WORK/other-credential.key"
printf 'portal' >"$WORK/portal.dump"
printf 'keycloak' >"$WORK/keycloak.dump"
mkdir -p "$WORK/minio"
printf 'object' >"$WORK/minio/note.bin"
tar -C "$WORK" -cf "$WORK/minio.tar" minio

write_manifest() {
  python3 - "$WORK" "$1" <<'PY'
import hashlib, json, pathlib, sys
work = pathlib.Path(sys.argv[1])
migration = sys.argv[2]
key = (work / "credential.key").read_bytes()
files = {}
for name in ("portal.dump", "keycloak.dump", "minio.tar"):
    data = (work / name).read_bytes()
    files[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
doc = {
    "kind": "gratis-recovery-bundle",
    "format": 4,
    "components": {
        "portalDatabase": files["portal.dump"],
        "keycloakDatabase": files["keycloak.dump"],
        "minio": {**files["minio.tar"], "objectCount": None, "totalBytes": 6},
    },
    "images": [
        {"service": svc, "id": "sha256:" + svc}
        for svc in ("keycloak", "minio", "portal-api", "portal-worker", "postgres")
    ],
    "latestMigration": migration,
    "credentialKeySha256": hashlib.sha256(key).hexdigest(),
    "quiesce": {"stoppedWriters": []},
    "notIncluded": ["CREDENTIAL_ENCRYPTION_KEY", "recovery passphrase"],
}
(work / "manifest.json").write_text(json.dumps(doc))
PY
}
write_manifest "$FAKE_MIGRATION"

NODE="$(recovery_node)"
seal() {
  tar -C "$WORK" -cf "$WORK/$1.tar" "${@:2}"
  rm -f "$WORK/$1.tar.enc"
  "$NODE" "$HERE/seal.mjs" enc "$WORK/recovery.key" "$WORK/$1.tar" "$WORK/$1.tar.enc"
}
seal bundle manifest.json portal.dump keycloak.dump minio.tar
touch "$WORK/compose.yml"

export GRATIS_RECOVERY_PROJECT=gg-recovery-unit

run_restore() {
  local project="${3:-gg-recovery-unit}"
  set +e
  out="$(GRATIS_RECOVERY_PROJECT="$project" "$HERE/restore.sh" \
    --confirm-project "$project" \
    --compose-file "$WORK/compose.yml" \
    --recovery-key-file "$WORK/recovery.key" \
    --credential-key-file "$1" \
    --bundle "$2" \
    --maintenance-file "$WORK/maint" \
    --status-file "$WORK/status.json" "${@:4}" 2>&1)"
  code=$?
  set -e
  printf '%s\n' "$out"
  return "$code"
}

no_changes() {
  [[ ! -e "$WORK/maint" ]] || fail "$1: maintenance file was left behind"
  if grep -Eq '^(stop|start|run) ' "$FAKE_DOCKER_LOG"; then
    fail "$1: a container was changed"
  fi
  if grep -q 'pg_restore' "$FAKE_DOCKER_LOG"; then
    fail "$1: a database restore was attempted"
  fi
  : >"$FAKE_DOCKER_LOG"
}

# A project with no containers is refused before anything else.
set +e
msg="$(run_restore "$WORK/credential.key" "$WORK/bundle.tar.enc" gratis-gis-prod)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a project with no containers was accepted'
printf '%s\n' "$msg" | grep -q 'check the project name' || fail 'wrong project did not say so'
no_changes 'wrong project'

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
no_changes 'wrong key'

# Drop a component and seal again.
mv "$WORK/minio.tar" "$WORK/minio.tar.keep"
seal partial manifest.json portal.dump keycloak.dump
mv "$WORK/minio.tar.keep" "$WORK/minio.tar"
set +e
msg="$(run_restore "$WORK/credential.key" "$WORK/partial.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a bundle missing objects was accepted'
printf '%s\n' "$msg" | grep -q 'incomplete' || fail 'partial bundle was not called incomplete'
no_changes 'partial bundle'

# Checksum mismatch: change a dump and keep the old manifest.
printf 'PORTAL' >"$WORK/portal.dump"
seal bad manifest.json portal.dump keycloak.dump minio.tar
printf 'portal' >"$WORK/portal.dump"
set +e
msg="$(run_restore "$WORK/credential.key" "$WORK/bad.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a checksum mismatch was accepted'
no_changes 'checksum mismatch'

# Version mismatch: the running stack has a newer migration.
set +e
msg="$(FAKE_MIGRATION=20260202000000_next run_restore "$WORK/credential.key" "$WORK/bundle.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a migration mismatch was accepted'
printf '%s\n' "$msg" | grep -q 'allow-version-mismatch' || fail 'version refusal did not name the override'
printf '%s\n' "$msg" | grep -q 'latest migration' || fail 'version refusal did not name the migration'
no_changes 'version mismatch'

# With the override the checks pass, maintenance is raised, and the
# fake docker refuses to stop a writer. That failure is before any
# data change, so the maintenance file must be gone again.
set +e
msg="$(FAKE_MIGRATION=20260202000000_next run_restore "$WORK/credential.key" "$WORK/bundle.tar.enc" \
  gg-recovery-unit --allow-version-mismatch)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'the fake stop was reported as success'
printf '%s\n' "$msg" | grep -q 'could not stop' || fail "override did not reach the writer stop: $msg"
[[ ! -e "$WORK/maint" ]] || fail 'a failure before data changed left the maintenance file'
! grep -q 'pg_restore' "$FAKE_DOCKER_LOG" || fail 'a database restore ran without a safety bundle'
python3 - "$WORK/status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "failed", doc
assert doc["maintenance"] is False, doc
PY
: >"$FAKE_DOCKER_LOG"

# A running container outside the known services stops the restore,
# even when the compose file does not name it.
set +e
msg="$(FAKE_EXTRA=mystery-writer run_restore "$WORK/credential.key" "$WORK/bundle.tar.enc")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'an unknown running service was accepted'
printf '%s\n' "$msg" | grep -q 'not a known service' || fail 'unknown service refusal did not say why'
no_changes 'unknown service'

# After a partial restore, a retry that fails early must leave the
# maintenance file and the partial status exactly as they were. The
# --env-file is passed to every compose call.
printf 'held' >"$WORK/maint"
printf '%s\n' '{"outcome":"failed","phase":"partial","maintenance":true}' >"$WORK/status.json"
printf 'X=1\n' >"$WORK/env.prod"
set +e
msg="$(FAKE_MIGRATION=20260202000000_next run_restore "$WORK/credential.key" "$WORK/bundle.tar.enc" \
  gg-recovery-unit --allow-version-mismatch --env-file "$WORK/env.prod")"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'the fake stop was reported as success'
[[ "$(cat "$WORK/maint" 2>/dev/null)" == held ]] || fail 'a retry removed or rewrote an existing maintenance file'
grep -q '"phase":"partial"' "$WORK/status.json" || fail 'a retry overwrote the partial status'
grep -q -- "--env-file $WORK/env.prod config --services" "$FAKE_DOCKER_LOG" || fail '--env-file was not passed to compose'
rm -f "$WORK/maint" "$WORK/status.json"
: >"$FAKE_DOCKER_LOG"

# Capture refuses a project with no containers before it writes.
mkdir -p "$WORK/cap-out"
set +e
GRATIS_RECOVERY_PROJECT=gratis-gis "$HERE/capture.sh" \
  --confirm-project gratis-gis \
  --compose-file "$WORK/compose.yml" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --out "$WORK/cap-out" \
  --maintenance-file "$WORK/maint" \
  --data-only >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'capture accepted a project with no containers'
[[ -z "$(ls -A "$WORK/cap-out")" ]] || fail 'capture wrote output for a wrong project'
no_changes 'capture wrong project'

mkdir -p "$WORK/off"
ln -s bundle.tar.enc "$WORK/latest.tar.enc"
"$HERE/offhost.sh" \
  --confirm-project gg-recovery-unit \
  --bundle "$WORK/latest.tar.enc" \
  --dest "file:$WORK/off" \
  --status-file "$WORK/off-status.json"
[[ -f "$WORK/off/bundle.tar.enc" && ! -L "$WORK/off/bundle.tar.enc" ]] || fail 'off-host copy did not follow latest'
perm="$(stat -c '%a' "$WORK/off/bundle.tar.enc")"
(( (8#$perm & 8#222) == 0 )) || fail "off-host copy mode is $perm"
[[ -z "$(find "$WORK/off" -name '.*')" ]] || fail 'off-host copy left a temporary file'
python3 - "$WORK/off-status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "succeeded"
assert doc["secondaryFileVerified"] is True
assert doc["sameDisk"] is True
assert doc["offsiteVerified"] is False
assert doc["immutable"] is False
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

# A file someone else put at the target name is neither replaced nor
# deleted.
mkdir -p "$WORK/off2"
printf 'theirs' >"$WORK/off2/bundle.tar.enc"
set +e
"$HERE/offhost.sh" \
  --confirm-project gg-recovery-unit \
  --bundle "$WORK/bundle.tar.enc" \
  --dest "file:$WORK/off2" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'off-host copy replaced a foreign file'
[[ "$(cat "$WORK/off2/bundle.tar.enc")" == theirs ]] || fail 'off-host copy changed a foreign file'
[[ "$(find "$WORK/off2" -type f | wc -l)" == 1 ]] || fail 'off-host copy left a temporary file'

# The passphrase bytes must not appear in the sealed file.
if grep -a -F -q -f "$WORK/recovery.key" "$WORK/bundle.tar.enc"; then
  fail 'the sealed bundle contains the passphrase'
fi
mode="$(stat -c '%a' "$WORK/bundle.tar.enc")"
[[ "$mode" == "600" ]] || fail "bundle mode is $mode"
# Two seals of the same input differ (random salt and IV).
"$NODE" "$HERE/seal.mjs" enc "$WORK/recovery.key" "$WORK/bundle.tar" "$WORK/again.enc"
! cmp -s "$WORK/bundle.tar.enc" "$WORK/again.enc" || fail 'two seals produced the same bytes'
# Sealing never replaces an existing file.
set +e
"$NODE" "$HERE/seal.mjs" enc "$WORK/recovery.key" "$WORK/bundle.tar" "$WORK/again.enc" 2>/dev/null
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'seal replaced an existing file'

# A header that asks for a higher scrypt cost than enc writes is
# refused before any key derivation.
python3 - "$WORK/bundle.tar.enc" "$WORK/costly.enc" <<'PY'
import sys
data = bytearray(open(sys.argv[1], "rb").read())
data[6] = 22
open(sys.argv[2], "wb").write(data)
PY
set +e
msg="$("$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/costly.enc" "$WORK/costly.tar" 2>&1)"
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a high-cost header was accepted'
printf '%s\n' "$msg" | grep -q 'unsupported parameters' || fail 'a high-cost header was not refused up front'

# Streaming: 50 MB spans many 1 MiB records.
head -c 52428800 /dev/urandom >"$WORK/large.bin"
"$NODE" "$HERE/seal.mjs" enc "$WORK/recovery.key" "$WORK/large.bin" "$WORK/large.enc"
mkdir -m 700 "$WORK/open"
"$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/large.enc" "$WORK/open/large.bin"
cmp -s "$WORK/large.bin" "$WORK/open/large.bin" || fail 'large round trip changed bytes'
rm -f "$WORK/open/large.bin"

# One flipped byte late in the file: every earlier record verifies,
# the flipped one does not, and no plaintext reaches the destination
# directory, not even under a temporary name.
python3 - "$WORK/large.enc" "$WORK/tampered.enc" <<'PY'
import shutil, sys
src, dst = sys.argv[1:]
shutil.copyfile(src, dst)
with open(dst, "r+b") as f:
    f.seek(40 * 1024 * 1024)
    b = f.read(1)
    f.seek(40 * 1024 * 1024)
    f.write(bytes([b[0] ^ 1]))
PY
set +e
"$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/tampered.enc" "$WORK/open/tampered.bin" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a tampered bundle decrypted'
[[ -z "$(ls -A "$WORK/open")" ]] || fail 'a tampered bundle left plaintext behind'

# A bundle cut at a record boundary is refused.
head -c $((38 + 1048592 * 3)) "$WORK/large.enc" >"$WORK/cut.enc"
set +e
"$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/cut.enc" "$WORK/open/cut.bin" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a truncated bundle decrypted'
[[ -z "$(ls -A "$WORK/open")" ]] || fail 'a truncated bundle left plaintext behind'
rm -f "$WORK/large.bin" "$WORK/large.enc" "$WORK/tampered.enc" "$WORK/cut.enc"

# Traversal, symlink, and a tiny size cap.
mkdir -p "$WORK/escape"
python3 - "$WORK/evil.tar" <<'PY'
import io, tarfile, sys
with tarfile.open(sys.argv[1], 'w') as tar:
    info = tarfile.TarInfo('../evil')
    data = b'x'
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))
PY
set +e
python3 "$HERE/safe_untar.py" "$WORK/evil.tar" "$WORK/escape" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a parent-path member was extracted'
[[ ! -e "$WORK/evil" && ! -e "$WORK/escape/../evil" ]] || fail 'traversal wrote a file'

python3 - "$WORK/link.tar" <<'PY'
import tarfile, sys
with tarfile.open(sys.argv[1], 'w') as tar:
    info = tarfile.TarInfo('link')
    info.type = tarfile.SYMTYPE
    info.linkname = '/tmp'
    tar.addfile(info)
PY
set +e
python3 "$HERE/safe_untar.py" "$WORK/link.tar" "$WORK/escape" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'a symlink member was extracted'

printf '0123456789' >"$WORK/big.bin"
tar -C "$WORK" -cf "$WORK/big.tar" big.bin
set +e
GRATIS_RECOVERY_MAX_UNCOMPRESSED=4 python3 "$HERE/safe_untar.py" "$WORK/big.tar" "$WORK/escape" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || fail 'an oversize member was extracted'

printf 'recovery-test: guards passed\n'
