#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fixture restore drill. The only compose project this script will
# touch is gg-recovery-drill, and only when that name is passed twice.
# It does not list or select any other stack.
#
# This is not a full-system recovery. The portal tables are a small
# fixture, and no portal HTTP process is booted. The migrated portal
# drill is drill-portal.sh.
set -euo pipefail

# The drill log is a file. A child that seeks that file back to the
# start and writes will erase the record. Hand children a pipe.
exec > >(cat) 2>&1

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
recovery_umask

CONFIRM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done
export GRATIS_RECOVERY_PROJECT=gg-recovery-drill
recovery_confirm_project "$CONFIRM"
[[ "$CONFIRM" == "gg-recovery-drill" ]] || recovery_die 'this drill only runs as gg-recovery-drill'

COMPOSE="$HERE/compose.drill.yml"
STARTED=0
cleanup() {
  if [[ "$STARTED" -eq 1 ]]; then
    docker compose -p gg-recovery-drill -f "$COMPOSE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 - <<'PY'
import socket
for port in (55433, 18080, 19000):
    sock = socket.socket()
    sock.settimeout(0.3)
    try:
        sock.connect(("127.0.0.1", port))
    except OSError:
        pass
    else:
        raise SystemExit(f"port {port} is already in use; refusing to start the drill")
    finally:
        sock.close()
PY

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery-drill.XXXXXX")"
chmod 700 "$WORK"
openssl rand -base64 32 >"$WORK/credential.key"
openssl rand -base64 48 >"$WORK/recovery.key"
openssl rand -base64 48 >"$WORK/secrets.key"
openssl rand -base64 32 >"$WORK/unique-secret"
openssl rand -base64 24 >"$WORK/ada.pass"
openssl rand -base64 24 >"$WORK/ben.pass"
printf 'drill-credential-ok' >"$WORK/plain.txt"
python3 - <<PY
import os, pathlib
work = pathlib.Path("$WORK")
body = b"GRATIS-DRILL-FILE-v1\n" + os.urandom(32)
(work / "note.bin").write_bytes(body)
import hashlib
(work / "note.sha").write_text(hashlib.sha256(body).hexdigest())
PY

export PATH="$WORK/venv/bin:$PATH"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q boto3
export PATH="$WORK/venv/bin:$PATH"

NODE="${NODE:-node}"
if [[ -x /home/ubuntu/.nvm/versions/node/v24.9.0/bin/node ]]; then
  NODE=/home/ubuntu/.nvm/versions/node/v24.9.0/bin/node
fi

up() {
  docker compose -p gg-recovery-drill -f "$COMPOSE" up -d
  STARTED=1
  for _ in $(seq 1 40); do
    if docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T postgres pg_isready -U gratisgis -d gratisgis >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T postgres pg_isready -U gratisgis -d gratisgis >/dev/null
  for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:18080/realms/master >/dev/null; then
      return 0
    fi
    sleep 2
  done
  recovery_die 'keycloak did not answer on the drill port'
}

psql_db() {
  docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U gratisgis -d gratisgis "$@"
}

# The admin password is the drill fixture in compose.drill.yml. It is
# passed to kcadm inside the container and is not printed here.
kcadm_login() {
  docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://127.0.0.1:8080 --realm master \
    --user admin --password drill-kc-admin >/dev/null
}

seed() {
  kcadm_login
  docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh create realms -s realm=field -s enabled=true >/dev/null
  docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh create clients -r field \
    -s clientId=portal -s publicClient=true \
    -s directAccessGrantsEnabled=true -s standardFlowEnabled=true >/dev/null
  local IFS='|'
  for spec in "ada|$WORK/ada.pass|Ada|Admin" "ben|$WORK/ben.pass|Ben|Viewer"; do
    read -r name passfile first last <<<"$spec"
    docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T keycloak \
      /opt/keycloak/bin/kcadm.sh create users -r field \
      -s username="$name" -s enabled=true \
      -s email="${name}@drill.example" \
      -s firstName="$first" -s lastName="$last" \
      -s emailVerified=true >/dev/null
    docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T keycloak \
      /opt/keycloak/bin/kcadm.sh set-password -r field \
      --username "$name" --new-password "$(cat "$passfile")" >/dev/null
    docker compose -p gg-recovery-drill -f "$COMPOSE" exec -T keycloak \
      /opt/keycloak/bin/kcadm.sh get users -r field -q "username=${name}" --fields id \
      >"$WORK/${name}.json"
  done

  ITEM_PRIVATE=22222222-2222-4222-8222-222222222222
  ITEM_SHARED=33333333-3333-4333-8333-333333333333
  ORG=11111111-1111-4111-8111-111111111111
  CRED=44444444-4444-4444-8444-444444444444
  FEAT=55555555-5555-4555-8555-555555555555

  "$NODE" --experimental-strip-types \
    "$WORK/encrypt.mjs" "$WORK/credential.key" "$ITEM_PRIVATE" \
    "$WORK/plain.txt" "$WORK/cipher.json"

  MINIO_ENDPOINT=http://127.0.0.1:19000 \
  MINIO_ACCESS_KEY=drillminio \
  MINIO_SECRET_KEY=drill-minio-secret \
  "$WORK/venv/bin/python" - "$WORK/note.bin" <<'PY'
import os, sys
import boto3
from botocore.client import Config
body = open(sys.argv[1], "rb").read()
c = boto3.client(
    "s3",
    endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    config=Config(signature_version="s3v4"),
    region_name="us-east-1",
)
c.create_bucket(Bucket="gratisgis")
c.put_object(Bucket="gratisgis", Key="attachments/note.bin", Body=body)
PY

  python3 - "$WORK" <<PY
import json, pathlib, subprocess, os
work = pathlib.Path("$WORK")
def user_id(name):
    raw = (work / f"{name}.json").read_text()
    raw = raw[raw.find("[") :]
    return json.loads(raw)[0]["id"]
ada = user_id("ada")
ben = user_id("ben")
cipher = json.loads((work / "cipher.json").read_text())
sig = (work / "note.sha").read_text().strip()
org = "$ORG"
private = "$ITEM_PRIVATE"
shared = "$ITEM_SHARED"
cred = "$CRED"
feat = "$FEAT"
sql = f"""
CREATE TABLE org (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES org(id),
  username text NOT NULL UNIQUE,
  org_role text NOT NULL
);
CREATE TABLE item (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  title text NOT NULL,
  access text NOT NULL,
  storage_ref text,
  signature_sha256 text
);
CREATE TABLE item_share (
  item_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  permission text NOT NULL
);
CREATE TABLE item_credential (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL UNIQUE,
  encrypted_payload text NOT NULL,
  iv text NOT NULL
);
CREATE TABLE feature_row (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  geojson text NOT NULL
);
INSERT INTO org (id, name) VALUES ('{org}', 'Drill Org');
INSERT INTO app_user (id, org_id, username, org_role) VALUES
  ('{ada}', '{org}', 'ada', 'admin'),
  ('{ben}', '{org}', 'ben', 'viewer');
INSERT INTO item (id, org_id, owner_id, title, access, storage_ref, signature_sha256) VALUES
  ('{private}', '{org}', '{ada}', 'Private note', 'private', 'attachments/note.bin', '{sig}'),
  ('{shared}', '{org}', '{ada}', 'Shared map', 'shared', NULL, NULL);
INSERT INTO item_share (item_id, principal_id, permission) VALUES
  ('{shared}', '{ben}', 'view');
INSERT INTO item_credential (id, item_id, encrypted_payload, iv) VALUES
  ('{cred}', '{private}', '{cipher["ciphertext"]}', '{cipher["iv"]}');
INSERT INTO feature_row (id, item_id, owner_id, geojson) VALUES
  ('{feat}', '{private}', '{ada}', '{{"type":"Feature","geometry":{{"type":"Point","coordinates":[1,2]}},"properties":{{"name":"drill"}}}}');
"""
(work / "seed.sql").write_text(sql)
(work / "ids.json").write_text(json.dumps({"ada": ada, "ben": ben}))
PY
  psql_db <"$WORK/seed.sql" >/dev/null
}

token_user() {
  local name="$1" passfile="$2"
  curl -sf -X POST 'http://127.0.0.1:18080/realms/field/protocol/openid-connect/token' \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'client_id=portal' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode "username=${name}" \
    --data-urlencode "password=$(cat "$passfile")" \
    >"$WORK/${name}.token" 
  "$NODE" --input-type=module - "$WORK/${name}.token" "$name" <<'JS'
import { readFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const token = body.access_token;
if (!token || token.length < 20) process.exit(1);
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
if (payload.preferred_username !== process.argv[3]) process.exit(1);
JS
  rm -f "$WORK/${name}.token"
  printf 'sign-in-ok %s\n' "$name"
  printf 'sign-in-ok %s\n' "$name" >>/tmp/gg-recovery-marks
}

verify() {
  token_user ada "$WORK/ada.pass"
  token_user ben "$WORK/ben.pass"
  python3 - "$WORK/ids.json" <<'PY' >"$WORK/check.sql"
import json, sys
ids = json.load(open(sys.argv[1]))
print(f"""
SELECT username || '=' || org_role FROM app_user ORDER BY username;
SELECT access || ':' || owner_id::text FROM item WHERE title = 'Private note';
SELECT principal_id::text || ':' || permission FROM item_share;
SELECT geojson FROM feature_row;
SELECT encrypted_payload, iv, item_id::text FROM item_credential;
SELECT signature_sha256 FROM item WHERE storage_ref = 'attachments/note.bin';
""")
open('/dev/stderr','w').write('')
PY
  psql_db -At <"$WORK/check.sql" >"$WORK/rows.txt"
  grep -qx 'ada=admin' "$WORK/rows.txt"
  grep -qx 'ben=viewer' "$WORK/rows.txt"
  python3 - "$WORK/ids.json" "$WORK/rows.txt" <<'PY'
import json, pathlib, sys
ids = json.load(open(sys.argv[1]))
rows = pathlib.Path(sys.argv[2]).read_text().splitlines()
if f"private:{ids['ada']}" not in rows:
    raise SystemExit('private item owner was not restored')
if f"{ids['ben']}:view" not in rows:
    raise SystemExit('share was not restored')
if not any('"name":"drill"' in row for row in rows):
    raise SystemExit('feature was not restored')
PY
  # Ben has no share on the private item.
  if grep -q "$(python3 -c "import json;print(json.load(open('$WORK/ids.json'))['ben'])").*[Pp]rivate" "$WORK/rows.txt"; then
    recovery_die 'viewer appears on the private item'
  fi

  MINIO_ENDPOINT=http://127.0.0.1:19000 \
  MINIO_ACCESS_KEY=drillminio \
  MINIO_SECRET_KEY=drill-minio-secret \
  "$WORK/venv/bin/python" - "$WORK/note.bin" <<'PY'
import hashlib, os, sys
import boto3
from botocore.client import Config
expected = open(sys.argv[1], "rb").read()
c = boto3.client(
    "s3",
    endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    config=Config(signature_version="s3v4"),
    region_name="us-east-1",
)
got = c.get_object(Bucket="gratisgis", Key="attachments/note.bin")["Body"].read()
if got != expected:
    raise SystemExit("object bytes do not match")
if hashlib.sha256(got).hexdigest() != hashlib.sha256(expected).hexdigest():
    raise SystemExit("object digest does not match")
print("object-ok")
PY

  psql_db -At -c "SELECT encrypted_payload, iv, item_id::text FROM item_credential" >"$WORK/cred.row"
  "$NODE" --experimental-strip-types \
    "$WORK/decrypt.mjs" "$WORK/credential.key" "$WORK/cred.row" "$WORK/plain.txt"
}

cat >"$WORK/encrypt.mjs" <<JS
import { readFileSync, writeFileSync } from 'node:fs';
import { encryptCredential } from '${ROOT}/apps/portal-api/src/items/credential-cipher.ts';
process.env.CREDENTIAL_ENCRYPTION_KEY = readFileSync(process.argv[2], 'utf8').trim();
const out = encryptCredential(readFileSync(process.argv[4], 'utf8'), process.argv[3]);
writeFileSync(process.argv[5], JSON.stringify(out));
JS
cat >"$WORK/decrypt.mjs" <<JS
import { readFileSync } from 'node:fs';
import { decryptCredential } from '${ROOT}/apps/portal-api/src/items/credential-cipher.ts';
process.env.CREDENTIAL_ENCRYPTION_KEY = readFileSync(process.argv[2], 'utf8').trim();
const [payload, iv, itemId] = readFileSync(process.argv[3], 'utf8').trim().split('|');
const expected = readFileSync(process.argv[4], 'utf8');
const got = decryptCredential(payload, iv, itemId);
if (got !== expected) process.exit(1);
process.stdout.write('decrypt-ok\n');
JS

STARTED_AT="$(date +%s)"
printf 'drill: starting throwaway project gg-recovery-drill\n'
up
seed
export MINIO_ENDPOINT=http://127.0.0.1:19000
export MINIO_ACCESS_KEY=drillminio
export MINIO_SECRET_KEY=drill-minio-secret
cat >"$WORK/during-quiesce.py" <<'PY'
import os
import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError
client = boto3.client(
    "s3",
    endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    config=Config(signature_version="s3v4", connect_timeout=2, read_timeout=2, retries={"max_attempts": 1}),
    region_name="us-east-1",
)
try:
    client.put_object(Bucket="gratisgis", Key="attachments/during-capture.bin", Body=b"concurrent")
except (BotoCoreError, ClientError, OSError):
    raise SystemExit(0)
raise SystemExit(1)
PY
chmod 700 "$WORK/during-quiesce.py"
cat >"$WORK/during-quiesce.sh" <<EOF
#!/bin/sh
exec "$WORK/venv/bin/python" "$WORK/during-quiesce.py"
EOF
chmod 700 "$WORK/during-quiesce.sh"
export GRATIS_RECOVERY_WHILE_QUIESCED="$WORK/during-quiesce.sh"
mkdir -p "$WORK/fail-out"
export GRATIS_RECOVERY_FAIL_AFTER=portal-dump
set +e
"$HERE/capture.sh" \
  --confirm-project gg-recovery-drill \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --secrets-key-file "$WORK/secrets.key" \
  --secret-file "unique-secret=$WORK/unique-secret" \
  --maintenance-file "$WORK/fail-maint" \
  --out "$WORK/fail-out" \
  --status-file "$WORK/fail-status.json" >/dev/null 2>&1
fail_code=$?
set -e
unset GRATIS_RECOVERY_FAIL_AFTER
[[ "$fail_code" -ne 0 ]] || recovery_die 'a forced capture failure was reported as success'
[[ ! -e "$WORK/fail-maint" ]] || recovery_die 'capture failure left the maintenance file it created'
for svc in minio keycloak portal-api; do
  state="$(docker inspect -f '{{.State.Status}}' "$(docker compose -p gg-recovery-drill -f "$COMPOSE" ps -aq "$svc")")"
  [[ "$state" == "running" ]] || recovery_die "capture failure left ${svc} ${state}"
done
printf 'capture-failure-resumed\n'
printf 'before-capture\n' >>/tmp/gg-recovery-marks
mkdir -p "$WORK/out"
"$HERE/capture.sh" \
  --confirm-project gg-recovery-drill \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --secrets-key-file "$WORK/secrets.key" \
  --secret-file "unique-secret=$WORK/unique-secret" \
  --maintenance-file "$WORK/capture-maint" \
  --out "$WORK/out" \
  --status-file "$WORK/capture-status.json"
printf 'capture-sealed\n' >>/tmp/gg-recovery-marks
python3 - "$WORK/capture-status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "succeeded"
assert doc["kind"] == "local-capture"
assert doc["portalDownload"] is False
assert doc["offsiteVerified"] is False
assert doc["immutable"] is False
PY

# The manifest must record that the running writer was paused.
NODE="$(recovery_node)"
"$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/out/latest.tar.enc" "$WORK/opened.tar"
mkdir -p "$WORK/opened"
tar -C "$WORK/opened" -xf "$WORK/opened.tar" manifest.json
rm -f "$WORK/opened.tar"
python3 - "$WORK/opened/manifest.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
stopped = doc["quiesce"]["stoppedWriters"]
if doc["quiesce"].get("mechanism") != "process-stop" or doc["quiesce"].get("minioStopped") is not True:
    raise SystemExit("capture did not record a process stop")
for name in ("keycloak", "portal-api", "minio"):
    if name not in stopped:
        raise SystemExit("capture did not stop " + name)
if "postgres" in stopped:
    raise SystemExit("capture stopped postgres")
if "CREDENTIAL_ENCRYPTION_KEY" not in doc["notIncluded"]:
    raise SystemExit("manifest does not say the credential key is absent")
if doc["components"]["minio"].get("layout") != "minio-data-dir":
    raise SystemExit("object archive is not the data directory")
PY
rm -rf "$WORK/opened"
[[ ! -e "$WORK/capture-maint" ]] || recovery_die 'a successful capture left the maintenance file'
"$HERE/unseal-secrets.sh" \
  --secrets-key-file "$WORK/secrets.key" \
  --sealed "$WORK/out/latest-secrets.tar.enc" \
  --out "$WORK/unsealed"
cmp -s "$WORK/unique-secret" "$WORK/unsealed/unique-secret" || recovery_die 'unsealed secret does not match'
if grep -a -F -q -f "$WORK/unique-secret" "$WORK/out/latest.tar.enc"; then
  recovery_die 'the data bundle contains the sealed secret'
fi
set +e
"$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/out/latest-secrets.tar.enc" "$WORK/secrets-with-recovery.tar" >/dev/null 2>&1
secrets_code=$?
set -e
[[ "$secrets_code" -ne 0 ]] || recovery_die 'the recovery passphrase opened the secrets archive'
"$WORK/venv/bin/python" - <<'PY'
import os
import boto3
from botocore.client import Config
client = boto3.client(
    "s3",
    endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    config=Config(signature_version="s3v4"),
    region_name="us-east-1",
)
client.put_object(Bucket="gratisgis", Key="attachments/after-resume.bin", Body=b"after")
try:
    client.get_object(Bucket="gratisgis", Key="attachments/during-capture.bin")
except client.exceptions.NoSuchKey:
    pass
else:
    raise SystemExit("a put during capture was stored")
print("quiesce-put-ok")
PY

mkdir -p "$WORK/off"
"$HERE/offhost.sh" \
  --confirm-project gg-recovery-drill \
  --bundle "$WORK/out/latest.tar.enc" \
  --dest "file:$WORK/off" \
  --status-file "$WORK/off-status.json"

# Wrong key must fail before the databases change.
openssl rand -base64 32 >"$WORK/wrong.key"
set +e
"$HERE/restore.sh" \
  --confirm-project gg-recovery-drill \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/wrong.key" \
  --bundle "$WORK/out/latest.tar.enc" \
  --status-file "$WORK/wrong-status.json" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || recovery_die 'wrong credential key was accepted against the live drill'
psql_db -At -c "SELECT count(*) FROM app_user" | grep -qx 2

# Fresh cluster, then a restore that stops after Keycloak.
docker compose -p gg-recovery-drill -f "$COMPOSE" down -v
STARTED=0
up
export GRATIS_RECOVERY_FAIL_AFTER=keycloak
set +e
"$HERE/restore.sh" \
  --confirm-project gg-recovery-drill \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --bundle "$WORK/out/latest.tar.enc" \
  --status-file "$WORK/partial-status.json" >"$WORK/partial.out" 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || recovery_die 'partial restore reported success'
python3 - "$WORK/partial-status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "failed", doc
assert doc["phase"] == "partial", doc
PY
# The portal database must still be the empty fresh one.
if psql_db -At -c "SELECT count(*) FROM app_user" >/dev/null 2>&1; then
  recovery_die 'partial restore wrote the portal database'
fi
unset GRATIS_RECOVERY_FAIL_AFTER

# Fresh cluster again, then the full restore.
docker compose -p gg-recovery-drill -f "$COMPOSE" down -v
STARTED=0
up
RESTORE_AT="$(date +%s)"
"$HERE/restore.sh" \
  --confirm-project gg-recovery-drill \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --bundle "$WORK/out/latest.tar.enc" \
  --status-file "$WORK/restore-status.json"
# Keycloak was stopped for the restore and started again. Wait for it.
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:18080/realms/field >/dev/null; then
    break
  fi
  sleep 2
done
curl -sf http://127.0.0.1:18080/realms/field >/dev/null || recovery_die 'realm did not return after restore'
verify
printf 'verify-returned\n' >>/tmp/gg-recovery-marks
RESTORE_DONE="$(date +%s)"
python3 - "$WORK/restore-status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["outcome"] == "succeeded"
assert doc["phase"] == "restored"
PY

# A truncated bundle must fail.
dd if=/dev/zero of="$WORK/out/latest.tar.enc" bs=32 count=1 conv=notrunc status=none
set +e
"$HERE/restore.sh" \
  --confirm-project gg-recovery-drill \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --bundle "$WORK/out/latest.tar.enc" \
  --status-file "$WORK/trunc-status.json" >/dev/null 2>&1
code=$?
set -e
[[ "$code" -ne 0 ]] || recovery_die 'a truncated bundle was restored'
# The earlier successful rows are still there: the truncated file
# failed before writes.
psql_db -At -c "SELECT count(*) FROM app_user" | grep -qx 2

END="$(date +%s)"
printf 'drill wall seconds: %s\n' "$((END - STARTED_AT))"
printf 'restore-and-verify seconds: %s\n' "$((RESTORE_DONE - RESTORE_AT))"
printf 'drill scope: keycloak password grant for two users, portal org/role/owner/share/feature/signature rows, minio object bytes, credential decrypt with the original key, process-stop quiesce with a refused put while MinIO was stopped and a put after resume, sealed secrets round trip, capture failure resumes writers and clears maintenance, wrong-key refusal, partial restore refusal, truncated bundle refusal, verified read-only off-host copy. The portal HTTP API was not booted.\n'

# Secret tripwire on this script's own status files and stdout markers.
if grep -R -q 'drill-credential-ok' "$WORK/capture-status.json" "$WORK/restore-status.json" "$WORK/partial-status.json" "$WORK/off-status.json"; then
  recovery_die 'status file contains the credential plaintext'
fi
