#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Migrated-portal restore drill. The only compose project this script
# touches is gg-recovery-portal, and only when that name is passed
# twice. The fixture drill (drill.sh) is a smaller schema and is not
# this proof.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
recovery_umask
exec > >(cat) 2>&1

CONFIRM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-project) CONFIRM="$2"; shift 2 ;;
    *) recovery_die "unknown argument" ;;
  esac
done
export GRATIS_RECOVERY_PROJECT=gg-recovery-portal
recovery_confirm_project "$CONFIRM"
[[ "$CONFIRM" == "gg-recovery-portal" ]] || recovery_die 'this drill only runs as gg-recovery-portal'

COMPOSE="$HERE/compose.portal.yml"
API_PID=""
STARTED=0
cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$STARTED" -eq 1 ]]; then
    docker compose -p gg-recovery-portal -f "$COMPOSE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 - <<'PY'
import socket
for port in (55435, 18081, 19010, 4010):
    sock = socket.socket()
    sock.settimeout(0.3)
    try:
        sock.connect(("127.0.0.1", port))
    except OSError:
        pass
    else:
        raise SystemExit(f"port {port} is already in use; refusing to start the portal drill")
    finally:
        sock.close()
PY

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gg-recovery-portal.XXXXXX")"
chmod 700 "$WORK"
openssl rand -base64 32 >"$WORK/credential.key"
openssl rand -base64 48 >"$WORK/recovery.key"
openssl rand -base64 48 >"$WORK/secrets.key"
openssl rand -base64 32 >"$WORK/unique-secret"
openssl rand -base64 24 >"$WORK/ada.pass"
openssl rand -base64 24 >"$WORK/ben.pass"
printf 'portal-credential-ok' >"$WORK/plain.txt"
python3 - <<PY
import hashlib, os, pathlib
work = pathlib.Path("$WORK")
body = b"GRATIS-PORTAL-FILE-v1\n" + os.urandom(32)
(work / "note.bin").write_bytes(body)
(work / "note.sha").write_text(hashlib.sha256(body).hexdigest())
PY
NODE="$(recovery_node)"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q boto3
export PATH="$WORK/venv/bin:$PATH"

up() {
  docker compose -p gg-recovery-portal -f "$COMPOSE" up -d
  STARTED=1
  for _ in $(seq 1 40); do
    if docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T postgres pg_isready -U gratisgis -d gratisgis >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T postgres pg_isready -U gratisgis -d gratisgis >/dev/null
  for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:18081/realms/master >/dev/null; then
      return 0
    fi
    sleep 2
  done
  docker logs gg-recovery-portal-keycloak-1 2>&1 | tail -n 20 || true
  recovery_die 'keycloak did not answer on the portal drill port'
}

psql_db() {
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U gratisgis -d gratisgis "$@"
}

kcadm_login() {
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://127.0.0.1:8080 --realm master \
    --user admin --password portal-drill-kc-admin >/dev/null
}

stop_api() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
    API_PID=""
  fi
}

start_api() {
  stop_api
  cat >"$WORK/api.env" <<EOF
DATABASE_URL=postgresql://gratisgis:portal-drill-pg@127.0.0.1:55435/gratisgis?schema=public
KEYCLOAK_URL=http://127.0.0.1:18081
KEYCLOAK_REALM=field
KEYCLOAK_CLIENT_ID_WEB=portal-web
KEYCLOAK_CLIENT_SECRET_WEB=portal-drill-web-secret
KEYCLOAK_ADMIN_CLIENT_ID=portal-api-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=portal-drill-admin-secret
MINIO_ENDPOINT=http://127.0.0.1:19010
MINIO_ACCESS_KEY=drillminio
MINIO_SECRET_KEY=portal-drill-minio
MINIO_BUCKET=gratisgis
CREDENTIAL_ENCRYPTION_KEY=$(tr -d '\n' <"$WORK/credential.key")
PORT=4010
GRATIS_RECOVERY_MAINTENANCE_FILE=$WORK/maintenance
EOF
  chmod 600 "$WORK/api.env"
  (
    set -a
    # shellcheck disable=SC1091
    source "$WORK/api.env"
    set +a
    cd "$ROOT/apps/portal-api"
    exec "$NODE" dist/main.js
  ) >"$WORK/api.log" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 90); do
    if curl -sf http://127.0.0.1:4010/health >/dev/null; then
      return 0
    fi
    sleep 1
  done
  tail -n 30 "$WORK/api.log" >&2 || true
  recovery_die 'portal-api did not answer on 4010'
}

token_user() {
  local name="$1" passfile="$2"
  local code
  code="$(curl -s -o "$WORK/${name}.token" -w '%{http_code}' -X POST \
    'http://127.0.0.1:18081/realms/field/protocol/openid-connect/token' \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'client_id=portal-web' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode "username=${name}" \
    --data-urlencode "password=$(cat "$passfile")")"
  if [[ "$code" != "200" ]]; then
    "$NODE" -e 'const b=require("fs").readFileSync(process.argv[1],"utf8"); const j=JSON.parse(b); console.error(j.error||"token-http-"+process.argv[2], j.error_description||"");' \
      "$WORK/${name}.token" "$code" >&2 || true
    rm -f "$WORK/${name}.token"
    recovery_die "token grant for ${name} failed"
  fi
  "$NODE" --input-type=module - "$WORK/${name}.token" "$name" <<'JS'
import { readFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const token = body.access_token;
if (!token || token.length < 20) process.exit(1);
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
if (payload.preferred_username !== process.argv[3]) {
  process.stderr.write('token-username-mismatch\n');
  process.exit(1);
}
if (payload.org !== 'drill') {
  process.stderr.write('token-missing-org\n');
  process.exit(1);
}
if (payload.azp !== 'portal-web') {
  process.stderr.write('token-azp-mismatch\n');
  process.exit(1);
}
JS
  rm -f "$WORK/${name}.token"
  printf 'sign-in-ok %s\n' "$name"
}

items_for() {
  local name="$1" passfile="$2" out="$3"
  curl -sf -X POST 'http://127.0.0.1:18081/realms/field/protocol/openid-connect/token' \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'client_id=portal-web' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode "username=${name}" \
    --data-urlencode "password=$(cat "$passfile")" \
    >"$WORK/${name}.token"
  "$NODE" --input-type=module - "$WORK/${name}.token" "$out" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const body = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const res = await fetch('http://127.0.0.1:4010/api/items', {
  headers: { authorization: `Bearer ${body.access_token}` },
});
const text = await res.text();
writeFileSync(process.argv[3], `${res.status}\n${text}`);
if (res.status !== 200) process.exit(1);
JS
  rm -f "$WORK/${name}.token"
}

STARTED_AT="$(date +%s)"
printf 'portal-drill: starting gg-recovery-portal\n'
up
export DATABASE_URL='postgresql://gratisgis:portal-drill-pg@127.0.0.1:55435/gratisgis?schema=public'
if ! ( cd "$ROOT/apps/portal-api" && pnpm exec prisma migrate deploy >/dev/null ); then
  recovery_die 'prisma migrate deploy failed'
fi

kcadm_login
docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
  /opt/keycloak/bin/kcadm.sh create realms -s realm=field -s enabled=true >/dev/null
docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
  /opt/keycloak/bin/kcadm.sh create clients -r field \
  -s clientId=portal-web -s publicClient=true \
  -s directAccessGrantsEnabled=true -s standardFlowEnabled=true >/dev/null
docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
  /opt/keycloak/bin/kcadm.sh get clients -r field -q clientId=portal-web --fields id \
  >"$WORK/client.json"
python3 - "$WORK" <<'PY'
import json, pathlib, sys
work = pathlib.Path(sys.argv[1])
raw = (work / "client.json").read_text()
raw = raw[raw.find("["):]
(work / "client-id").write_text(json.loads(raw)[0]["id"])
PY
CLIENT_ID="$(cat "$WORK/client-id")"
docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
  /opt/keycloak/bin/kcadm.sh create "clients/${CLIENT_ID}/protocol-mappers/models" -r field \
  -s name=org -s protocol=openid-connect \
  -s protocolMapper=oidc-usermodel-attribute-mapper \
  -s 'config."user.attribute"=org' \
  -s 'config."claim.name"=org' \
  -s 'config."jsonType.label"=String' \
  -s 'config."id.token.claim"=true' \
  -s 'config."access.token.claim"=true' \
  -s 'config."userinfo.token.claim"=true' >/dev/null
docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
  /opt/keycloak/bin/kcadm.sh create "clients/${CLIENT_ID}/protocol-mappers/models" -r field \
  -s name=org-hardcoded -s protocol=openid-connect \
  -s protocolMapper=oidc-hardcoded-claim-mapper \
  -s 'config."claim.name"=org' \
  -s 'config."claim.value"=drill' \
  -s 'config."jsonType.label"=String' \
  -s 'config."id.token.claim"=true' \
  -s 'config."access.token.claim"=true' >/dev/null

OLD_IFS="$IFS"
IFS='|'
for spec in "ada|$WORK/ada.pass|Ada|Owner" "ben|$WORK/ben.pass|Ben|Viewer"; do
  read -r name passfile first last <<<"$spec"
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh create users -r field \
    -s username="$name" -s enabled=true \
    -s email="${name}@drill.example" \
    -s firstName="$first" -s lastName="$last" \
    -s emailVerified=true >/dev/null
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh set-password -r field \
    --username "$name" --new-password "$(cat "$passfile")" >/dev/null
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh get users -r field -q "username=${name}" --fields id \
    >"$WORK/${name}.json"
done
IFS="$OLD_IFS"

python3 - "$WORK" <<'PY'
import json, pathlib, sys
work = pathlib.Path(sys.argv[1])
def user_id(name):
    raw = (work / f"{name}.json").read_text()
    raw = raw[raw.find("["):]
    return json.loads(raw)[0]["id"]
ada, ben = user_id("ada"), user_id("ben")
(work / "ids.json").write_text(json.dumps({"ada": ada, "ben": ben}))
for name, uid in (("ada", ada), ("ben", ben)):
    (work / f"{name}.attr").write_text(uid)
PY
for name in ada ben; do
  uid="$(python3 -c "import json;print(json.load(open('$WORK/ids.json'))['$name'])")"
  docker compose -p gg-recovery-portal -f "$COMPOSE" exec -T keycloak \
    /opt/keycloak/bin/kcadm.sh update "users/${uid}" -r field \
    -s 'attributes.org=["drill"]' >/dev/null
done

ITEM_PRIVATE=22222222-2222-4222-8222-222222222222
ITEM_SHARED=33333333-3333-4333-8333-333333333333
ORG=11111111-1111-4111-8111-111111111111
cat >"$WORK/encrypt.mjs" <<JS
import { readFileSync, writeFileSync } from 'node:fs';
import { encryptCredential } from '${ROOT}/apps/portal-api/src/items/credential-cipher.ts';
process.env.CREDENTIAL_ENCRYPTION_KEY = readFileSync(process.argv[2], 'utf8').trim();
const out = encryptCredential(readFileSync(process.argv[4], 'utf8'), process.argv[3]);
writeFileSync(process.argv[5], JSON.stringify(out));
JS
"$NODE" --experimental-strip-types "$WORK/encrypt.mjs" \
  "$WORK/credential.key" "$ITEM_PRIVATE" "$WORK/plain.txt" "$WORK/cipher.json"

MINIO_ENDPOINT=http://127.0.0.1:19010 \
MINIO_ACCESS_KEY=drillminio \
MINIO_SECRET_KEY=portal-drill-minio \
"$WORK/venv/bin/python" - "$WORK/note.bin" <<'PY'
import os, sys
import boto3
from botocore.client import Config
body = open(sys.argv[1], "rb").read()
c = boto3.client("s3", endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    config=Config(signature_version="s3v4"), region_name="us-east-1")
c.create_bucket(Bucket="gratisgis")
c.put_object(Bucket="gratisgis", Key="attachments/note.bin", Body=body)
PY

# A bucket Deny does not stop root or an IAM Allow on the MinIO image
# this stack ships. The capture hook below puts an object while MinIO
# is stopped and must fail. That is the quiesce this drill checks.

printf 'seed-start\n'
python3 - "$WORK" "$ORG" "$ITEM_PRIVATE" "$ITEM_SHARED" <<'PY'
import json, pathlib, sys
work, org, private, shared = sys.argv[1:]
ids = json.loads(pathlib.Path(work, "ids.json").read_text())
cipher = json.loads(pathlib.Path(work, "cipher.json").read_text())
sig = pathlib.Path(work, "note.sha").read_text().strip()
ada, ben = ids["ada"], ids["ben"]
sql = f"""
INSERT INTO organization (id, slug, name) VALUES ('{org}', 'drill', 'Drill Org');
INSERT INTO "user" (id, org_id, username, email, full_name, org_role) VALUES
  ('{ada}', '{org}', 'ada', 'ada@drill.example', 'Ada Owner', 'admin'),
  ('{ben}', '{org}', 'ben', 'ben@drill.example', 'Ben Viewer', 'viewer');
INSERT INTO item (id, org_id, owner_id, type, title, access, data_json, updated_at) VALUES
  ('{private}', '{org}', '{ada}', 'data-layer', 'Private note', 'private', '{{"signatureSha256":"{sig}"}}', now()),
  ('{shared}', '{org}', '{ada}', 'data-layer', 'Shared map', 'private', '{{}}', now());
INSERT INTO item_share (item_id, principal_type, principal_id, permission)
  VALUES ('{shared}', 'user', '{ben}', 'view');
INSERT INTO item_credential (id, item_id, auth_kind, encrypted_payload, iv, updated_by)
  VALUES ('44444444-4444-4444-8444-444444444444', '{private}', 'bearer',
          '{cipher["ciphertext"]}', '{cipher["iv"]}', '{ada}');
"""
pathlib.Path(work, "seed.sql").write_text(sql)
PY
printf 'seed-sql-written\n'
psql_db <"$WORK/seed.sql"
printf 'seed-ok\n'

start_api
token_user ada "$WORK/ada.pass"
token_user ben "$WORK/ben.pass"
items_for ada "$WORK/ada.pass" "$WORK/ada.items"
items_for ben "$WORK/ben.pass" "$WORK/ben.items"
grep -q 'Private note' "$WORK/ada.items"
grep -q 'Shared map' "$WORK/ada.items"
grep -q 'Shared map' "$WORK/ben.items"
if grep -q 'Private note' "$WORK/ben.items"; then
  recovery_die 'the viewer can see the private item'
fi
printf 'access-ok\n'
stop_api

export MINIO_ENDPOINT=http://127.0.0.1:19010
export MINIO_ACCESS_KEY=drillminio
export MINIO_SECRET_KEY=portal-drill-minio
export GRATIS_RECOVERY_EXTERNAL_API=stopped
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
"$HERE/capture.sh" \
  --confirm-project gg-recovery-portal \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --secrets-key-file "$WORK/secrets.key" \
  --secret-file "unique-secret=$WORK/unique-secret" \
  --out "$WORK/out" \
  --status-file "$WORK/capture-status.json"
python3 - "$WORK/out/manifest-check" "$WORK/out/latest.tar.enc" "$WORK/recovery.key" "$HERE" <<'PY'
import json, subprocess, sys, tarfile, io, os, pathlib
note, bundle, key, here = sys.argv[1:]
node = os.environ.get("NODE_BIN")
# caller exports NODE
PY
NODE_BIN="$NODE" "$NODE" "$HERE/seal.mjs" dec "$WORK/recovery.key" "$WORK/out/latest.tar.enc" "$WORK/opened.tar"
mkdir -p "$WORK/opened"
tar -C "$WORK/opened" -xf "$WORK/opened.tar" manifest.json
python3 - "$WORK/opened/manifest.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
stopped = doc["quiesce"]["stoppedWriters"]
if "portal-worker" not in stopped or "minio" not in stopped:
    raise SystemExit("capture did not stop the running writers")
if "script-runner" in stopped:
    raise SystemExit("a stopped service was treated as a writer")
if "CREDENTIAL_ENCRYPTION_KEY" not in doc["notIncluded"]:
    raise SystemExit("credential key was not listed as absent")
if doc["encryption"] != "aes-256-gcm":
    raise SystemExit("bundle is not authenticated encryption")
PY
rm -rf "$WORK/opened"
worker_state="$(docker inspect -f '{{.State.Status}}' "$(docker compose -p gg-recovery-portal -f "$COMPOSE" ps -q portal-worker)")"
[[ "$worker_state" == "running" ]] || recovery_die "portal-worker was left ${worker_state}"
if docker compose -p gg-recovery-portal -f "$COMPOSE" ps -aq script-runner | grep -q .; then
  recovery_die 'capture started the stopped script-runner'
fi
printf 'quiesce-ok\n'
test -f "$WORK/out/required-separately.json"
grep -q 'sealedSecrets' "$WORK/out/required-separately.json"
"$HERE/unseal-secrets.sh" \
  --secrets-key-file "$WORK/secrets.key" \
  --sealed "$WORK/out/latest-secrets.tar.enc" \
  --out "$WORK/unsealed"
cmp -s "$WORK/unique-secret" "$WORK/unsealed/unique-secret" || recovery_die 'unsealed secret does not match'
if grep -a -F -q -f "$WORK/unique-secret" "$WORK/out/latest.tar.enc"; then
  recovery_die 'the data bundle contains the sealed secret'
fi

mkdir -p "$WORK/off"
"$HERE/offhost.sh" \
  --confirm-project gg-recovery-portal \
  --bundle "$WORK/out/latest.tar.enc" \
  --dest "file:$WORK/off" \
  --status-file "$WORK/off-status.json"
python3 - "$WORK/off-status.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["secondaryFileVerified"] is True
assert doc["sameDisk"] is True
assert doc["offsiteVerified"] is False
assert doc["immutable"] is False
PY

docker compose -p gg-recovery-portal -f "$COMPOSE" down -v
STARTED=0
up
# A rebuilt host runs the same migrations before a restore, so the
# bundle's latest migration matches the running stack.
if ! ( cd "$ROOT/apps/portal-api" && pnpm exec prisma migrate deploy >/dev/null ); then
  recovery_die 'prisma migrate deploy failed on the fresh stack'
fi
RESTORE_AT="$(date +%s)"
"$HERE/restore.sh" \
  --confirm-project gg-recovery-portal \
  --compose-file "$COMPOSE" \
  --recovery-key-file "$WORK/recovery.key" \
  --credential-key-file "$WORK/credential.key" \
  --bundle "$WORK/out/latest.tar.enc" \
  --maintenance-file "$WORK/maintenance" \
  --status-file "$WORK/restore-status.json"
[[ ! -e "$WORK/maintenance" ]] || recovery_die 'successful restore left the maintenance file'
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:18081/realms/field >/dev/null; then
    break
  fi
  sleep 2
done
curl -sf http://127.0.0.1:18081/realms/field >/dev/null || recovery_die 'realm did not return after restore'
start_api
token_user ada "$WORK/ada.pass"
token_user ben "$WORK/ben.pass"
items_for ada "$WORK/ada.pass" "$WORK/ada.items"
items_for ben "$WORK/ben.pass" "$WORK/ben.items"
grep -q 'Private note' "$WORK/ada.items"
if grep -q 'Private note' "$WORK/ben.items"; then
  recovery_die 'after restore the viewer can see the private item'
fi
grep -q 'Shared map' "$WORK/ben.items"
printf 'restored-access-ok\n'

psql_db -At -c "SELECT encrypted_payload, iv, item_id::text FROM item_credential" >"$WORK/cred.row"
cat >"$WORK/decrypt.mjs" <<JS
import { readFileSync } from 'node:fs';
import { decryptCredential } from '${ROOT}/apps/portal-api/src/items/credential-cipher.ts';
process.env.CREDENTIAL_ENCRYPTION_KEY = readFileSync(process.argv[2], 'utf8').trim();
const [payload, iv, itemId] = readFileSync(process.argv[3], 'utf8').trim().split('|');
const expected = readFileSync(process.argv[4], 'utf8');
if (decryptCredential(payload, iv, itemId) !== expected) process.exit(1);
process.stdout.write('decrypt-ok\n');
JS
"$NODE" --experimental-strip-types "$WORK/decrypt.mjs" \
  "$WORK/credential.key" "$WORK/cred.row" "$WORK/plain.txt"
MINIO_ENDPOINT=http://127.0.0.1:19010 MINIO_ACCESS_KEY=drillminio MINIO_SECRET_KEY=portal-drill-minio \
  "$WORK/venv/bin/python" - "$WORK/note.bin" <<'PY'
import os, sys
import boto3
from botocore.client import Config
expected = open(sys.argv[1], "rb").read()
c = boto3.client("s3", endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    config=Config(signature_version="s3v4"), region_name="us-east-1")
got = c.get_object(Bucket="gratisgis", Key="attachments/note.bin")["Body"].read()
if got != expected:
    raise SystemExit("object bytes do not match")
print("object-ok")
PY
psql_db -At -c "SELECT data_json->>'signatureSha256' FROM item WHERE title = 'Private note'" | grep -qx "$(cat "$WORK/note.sha")"
printf 'signature-ok\n'
RESTORE_DONE="$(date +%s)"
END="$(date +%s)"
printf 'portal-drill wall seconds: %s\n' "$((END - STARTED_AT))"
printf 'portal-drill restore-and-check seconds: %s\n' "$((RESTORE_DONE - RESTORE_AT))"
printf 'portal-drill scope: migrated schema, portal-api HTTP with restored Keycloak accounts, share check, object bytes, signature, credential decrypt. The secondary file copy is same-disk and is not off-site.\n'
