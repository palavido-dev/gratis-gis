#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Boot the pasted NAS compose file and prove the stack is actually up.
#
#   ./infra/boot-nas-ci.sh
#
# Publishes the web UI on 127.0.0.1:18080 and uploads on 127.0.0.1:18900
# so a machine that already uses 8080 can run this. Tears the project
# down, including volumes, on the way out.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$SCRIPT_DIR/docker-compose.nas.yml"
PROJECT="gratis-gis-nas-ci"
WEB_PORT=18080
S3_PORT=18900
export GRATIS_HTTP_PORT="$WEB_PORT"
export GRATIS_S3_PORT="$S3_PORT"
export GRATIS_BASE_URL="http://127.0.0.1:${WEB_PORT}"
export GRATIS_S3_URL="http://127.0.0.1:${S3_PORT}"
# The boot must not call GitHub. The endpoint still reports this install.
export UPDATE_CHECK=off

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    mkdir -p /opt/cursor/artifacts
    docker compose -p "$PROJECT" -f "$COMPOSE" ps -a > /opt/cursor/artifacts/nas-boot-ps.txt 2>&1 || true
    # Tail only. The bootstrap log contains the admin password.
    docker compose -p "$PROJECT" -f "$COMPOSE" logs --no-color --tail 60 \
      > /opt/cursor/artifacts/nas-boot.log 2>&1 || true
  fi
  docker compose -p "$PROJECT" -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "${PROJECT}-off" -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

# A previous run may have left the fixed bootstrap container name.
docker rm -f gratis-gis-bootstrap >/dev/null 2>&1 || true

docker compose -p "$PROJECT" -f "$COMPOSE" up -d --remove-orphans

python3 - "$PROJECT" "$COMPOSE" <<'PY'
import json, subprocess, sys, time

project, compose = sys.argv[1], sys.argv[2]
deadline = time.time() + 900


def rows():
    ids = subprocess.check_output(
        ["docker", "compose", "-p", project, "-f", compose, "ps", "-aq"],
        text=True,
    ).split()
    found = []
    for cid in ids:
        data = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
        state = data["State"]
        health = (state.get("Health") or {}).get("Status") or "none"
        found.append(
            (
                data["Name"].lstrip("/"),
                state["Status"],
                state.get("ExitCode"),
                health,
            )
        )
    return found


def dump(found):
    for name, status, code, health in found:
        print(f"  {name} status={status} exit={code} health={health}")


last = []
while time.time() < deadline:
    last = rows()
    if not last:
        time.sleep(3)
        continue
    crashed = [
        row
        for row in last
        if row[1] in {"exited", "dead"} or (row[1] == "restarting" and row[2] not in (0, None))
    ]
    if crashed:
        print("a container exited")
        dump(crashed)
        sys.exit(1)
    if all(row[1] == "running" and row[3] == "healthy" for row in last):
        print(f"all {len(last)} services healthy")
        dump(last)
        sys.exit(0)
    time.sleep(5)

print("timed out waiting for every service to be healthy")
dump(last)
sys.exit(1)
PY

curl -fsS "http://127.0.0.1:${WEB_PORT}/" -o /dev/null
curl -fsS "http://127.0.0.1:${WEB_PORT}/auth/realms/gratis-gis" -o /tmp/gratis-realm.json
python3 -c 'import json,sys; realm=json.load(open(sys.argv[1])); assert realm["realm"]=="gratis-gis", realm' /tmp/gratis-realm.json
curl -fsS "http://127.0.0.1:${S3_PORT}/minio/health/live" -o /dev/null

# The generated password stays inside the container. This uploads a
# small object with it and reads the object back.
docker compose -p "$PROJECT" -f "$COMPOSE" exec -T minio \
  /bin/sh -c 'set -a; . /boot/env; set +a; mcli alias set ci http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mcli mb --ignore-existing ci/ci-probe >/dev/null; printf probe-ok | mcli pipe ci/ci-probe/probe.txt >/dev/null; mcli cat ci/ci-probe/probe.txt' \
  | grep -qx 'probe-ok'

# Browser uploads come from the web origin onto the upload port.
curl -fsS -D - -o /dev/null -X OPTIONS "http://127.0.0.1:${S3_PORT}/ci-probe/probe.txt" \
  -H "Origin: ${GRATIS_BASE_URL}" \
  -H "Access-Control-Request-Method: PUT" \
  | grep -qi "access-control-allow-origin: ${GRATIS_BASE_URL}"

docker compose -p "$PROJECT" -f "$COMPOSE" logs bootstrap 2>&1 \
  | grep -q "Do not post it publicly."

docker compose -p "$PROJECT" -f "$COMPOSE" logs pointcloud-worker 2>&1 \
  | grep -q "pointcloud-worker starting"

# A file on the backup volume has to survive recreating the API.
docker compose -p "$PROJECT" -f "$COMPOSE" exec -T portal-api \
  /bin/sh -c 'echo ci-backup-probe > /app/backups/ci-probe.txt'
docker compose -p "$PROJECT" -f "$COMPOSE" up -d --force-recreate --no-deps portal-api
for _ in $(seq 1 40); do
  cid="$(docker compose -p "$PROJECT" -f "$COMPOSE" ps -q portal-api)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
  if [ "$health" = "healthy" ]; then
    break
  fi
  sleep 3
done
docker compose -p "$PROJECT" -f "$COMPOSE" exec -T portal-api \
  cat /app/backups/ci-probe.txt | grep -qx 'ci-backup-probe'

# UPDATE_CHECK=off is written to /boot/env, which portal-api sources.
# The published edge image answers 404 for this route until
# publish-images runs. After that the route is admin-only and must
# describe this install without fetching a release.
compose_rev="$(docker compose -p "$PROJECT" -f "$COMPOSE" config --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["bootstrap"]["environment"]["GRATIS_COMPOSE_REV"])')"
docker compose -p "$PROJECT" -f "$COMPOSE" exec -T -e WANT_REV="$compose_rev" bootstrap \
  /bin/sh -c 'grep -q "^INSTALL_TYPE=.nas.$" /boot/env && grep -q "^GG_CHANNEL=.edge.$" /boot/env && grep -q "^UPDATE_CHECK=.off.$" /boot/env && grep -q "^GRATIS_COMPOSE_REV=.${WANT_REV}.$" /boot/env'
echo "boot env has nas update identity"
# The published edge image may predate a compose rev bump in this
# commit. The Updates page must flag exactly that mismatch.
image_rev="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T portal-api printenv REQUIRED_COMPOSE_REV || true)"
image_rev="$(printf '%s' "$image_rev" | tr -d '[:space:]')"
if [ -n "$image_rev" ] && [ "$image_rev" != "$compose_rev" ]; then
  want_outdated=true
else
  want_outdated=false
fi
route="$(docker compose -p "$PROJECT" -f "$COMPOSE" exec -T portal-api \
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/admin/updates || true)"
if [ "$route" = "404" ]; then
  echo "published edge image has no /api/admin/updates yet"
else
  if [ "$route" != "401" ]; then
    echo "updates route returned HTTP ${route}" >&2
    exit 1
  fi
  docker compose -p "$PROJECT" -f "$COMPOSE" exec -T -e WANT_OUTDATED="$want_outdated" bootstrap python - <<'PY'
import json, os, urllib.parse, urllib.request
import urllib.error
from pathlib import Path

def env():
    values = {}
    for raw in Path("/boot/env").read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            value = value[1:-1]
        values[key] = value
    return values

def post(url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()

vals = env()
status, raw = post(
    "http://keycloak:8080/auth/realms/master/protocol/openid-connect/token",
    urllib.parse.urlencode({
        "client_id": "admin-cli",
        "username": "admin",
        "password": vals["KEYCLOAK_ADMIN_PASSWORD"],
        "grant_type": "password",
    }).encode(),
    {"Content-Type": "application/x-www-form-urlencoded"},
)
if status != 200:
    raise SystemExit(f"master token HTTP {status}")
admin = json.loads(raw)["access_token"]
req = urllib.request.Request(
    "http://keycloak:8080/auth/admin/realms/gratis-gis/clients?clientId=portal-web",
    headers={"Authorization": f"Bearer {admin}"},
)
with urllib.request.urlopen(req, timeout=30) as resp:
    client = json.loads(resp.read())[0]
client["directAccessGrantsEnabled"] = True
put = urllib.request.Request(
    f"http://keycloak:8080/auth/admin/realms/gratis-gis/clients/{client['id']}",
    data=json.dumps(client).encode(),
    headers={"Authorization": f"Bearer {admin}", "Content-Type": "application/json"},
    method="PUT",
)
try:
    with urllib.request.urlopen(put, timeout=30) as resp:
        put_status = resp.status
except urllib.error.HTTPError as exc:
    put_status = exc.code
if put_status not in (200, 204):
    raise SystemExit(f"enable password grant HTTP {put_status}")
status, raw = post(
    "http://keycloak:8080/auth/realms/gratis-gis/protocol/openid-connect/token",
    urllib.parse.urlencode({
        "client_id": "portal-web",
        "username": "admin",
        "password": vals["INITIAL_USER_PASSWORD"],
        "grant_type": "password",
    }).encode(),
    {"Content-Type": "application/x-www-form-urlencoded"},
)
if status != 200:
    raise SystemExit(f"user token HTTP {status}")
token = json.loads(raw)["access_token"]
req = urllib.request.Request(
    "http://portal-api:4000/api/admin/updates",
    headers={"Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(req, timeout=30) as resp:
    body = json.loads(resp.read())
if body.get("installType") != "nas" or body.get("channel") != "edge":
    raise SystemExit(f"unexpected update identity {body}")
if body.get("latest") is not None:
    raise SystemExit("UPDATE_CHECK=off still fetched a latest release")
if not body.get("current", {}).get("version"):
    raise SystemExit(f"missing current version {body}")
want_outdated = os.environ.get("WANT_OUTDATED") == "true"
if body.get("composeOutdated") is not want_outdated:
    raise SystemExit(f"composeOutdated should be {want_outdated}: {body}")
print("updates endpoint ok", body["current"]["version"])
PY
fi

docker compose -p "$PROJECT" -f "$COMPOSE" exec -T portal-api \
  curl -fsS http://127.0.0.1:4000/api/portal-info \
  | python3 -c 'import json,sys; info=json.load(sys.stdin); assert info["features"]["analysis"] is True, info'

# The Users page calls Keycloak as portal-api-admin. That service
# account must be able to list users, and an admin must be able to
# create a data layer. Both failed on a real NAS install.
docker compose -p "$PROJECT" -f "$COMPOSE" exec -T bootstrap python - <<'PY'
import json, urllib.parse, urllib.request, urllib.error
from pathlib import Path

def env():
    values = {}
    for raw in Path("/boot/env").read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            value = value[1:-1]
        values[key] = value
    return values

def call(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()

vals = env()
base = vals["KEYCLOAK_INTERNAL_URL"].rstrip("/")
status, raw = call(
    f"{base}/realms/gratis-gis/protocol/openid-connect/token",
    urllib.parse.urlencode({
        "client_id": "portal-api-admin",
        "client_secret": vals["KEYCLOAK_ADMIN_CLIENT_SECRET"],
        "grant_type": "client_credentials",
    }).encode(),
    {"Content-Type": "application/x-www-form-urlencoded"},
    "POST",
)
if status != 200:
    raise SystemExit(f"admin client token HTTP {status}")
sa = json.loads(raw)["access_token"]
status, raw = call(
    f"{base}/admin/realms/gratis-gis/users?max=20",
    headers={"Authorization": f"Bearer {sa}", "Accept": "application/json"},
)
if status != 200:
    raise SystemExit(f"list users HTTP {status}: {raw[:200]!r}")
users = json.loads(raw)
if not any(user.get("username") == "admin" for user in users):
    raise SystemExit(f"admin user missing from {users}")

status, raw = call(
    f"{base}/realms/master/protocol/openid-connect/token",
    urllib.parse.urlencode({
        "client_id": "admin-cli",
        "username": "admin",
        "password": vals["KEYCLOAK_ADMIN_PASSWORD"],
        "grant_type": "password",
    }).encode(),
    {"Content-Type": "application/x-www-form-urlencoded"},
    "POST",
)
if status != 200:
    raise SystemExit(f"master token HTTP {status}")
admin = json.loads(raw)["access_token"]
auth = {"Authorization": f"Bearer {admin}", "Accept": "application/json"}
status, raw = call(
    f"{base}/admin/realms/gratis-gis/clients?clientId=portal-web",
    headers=auth,
)
client = json.loads(raw)[0]
client["directAccessGrantsEnabled"] = True
status, _ = call(
    f"{base}/admin/realms/gratis-gis/clients/{client['id']}",
    json.dumps(client).encode(),
    {**auth, "Content-Type": "application/json"},
    "PUT",
)
if status not in (200, 204):
    raise SystemExit(f"enable password grant HTTP {status}")

# A user created after the realm import (an admin invite) must get
# offline_access through the default role, or field-app and QGIS
# sign-in fail with "Offline tokens not allowed".
status, _ = call(
    f"{base}/admin/realms/gratis-gis/users",
    json.dumps({"username": "ci-field", "enabled": True}).encode(),
    {**auth, "Content-Type": "application/json"},
    "POST",
)
if status not in (201, 409):
    raise SystemExit(f"create ci-field HTTP {status}")
status, raw = call(f"{base}/admin/realms/gratis-gis/users?username=ci-field&exact=true", headers=auth)
field_id = json.loads(raw)[0]["id"]
status, raw = call(
    f"{base}/admin/realms/gratis-gis/users/{field_id}/role-mappings/realm/composite",
    headers=auth,
)
if "offline_access" not in {role.get("name") for role in json.loads(raw)}:
    raise SystemExit(f"a new user lacks offline_access: {raw[:300]!r}")
print("new users get offline_access")
status, raw = call(
    f"{base}/realms/gratis-gis/protocol/openid-connect/token",
    urllib.parse.urlencode({
        "client_id": "portal-web",
        "username": "admin",
        "password": vals["INITIAL_USER_PASSWORD"],
        "grant_type": "password",
    }).encode(),
    {"Content-Type": "application/x-www-form-urlencoded"},
    "POST",
)
if status != 200:
    raise SystemExit(f"user token HTTP {status}")
token = json.loads(raw)["access_token"]
body = {
    "type": "data_layer",
    "title": "ci probe layer",
    "data": {
        "version": 3,
        "storageType": "postgis",
        "layers": [{
            "id": "11111111-1111-4111-8111-111111111111",
            "label": "ci probe layer",
            "name": "ci-probe-layer",
            "geometryType": "point",
            "fields": [{
                "name": "name",
                "type": "string",
                "label": "Name",
                "nullable": True,
            }],
            "editingEnabled": True,
            "attachmentsEnabled": False,
        }],
    },
}
status, raw = call(
    "http://portal-api:4000/api/items",
    json.dumps(body).encode(),
    {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    "POST",
)
if status != 201:
    raise SystemExit(f"create layer HTTP {status}: {raw[:400]!r}")
item_id = json.loads(raw)["id"]
layer_id = body["data"]["layers"][0]["id"]
print("users list and data layer ok")

# The create wizard stages a file on portal-api, then portal-worker
# imports it from the shared staging volume. A NAS stack without that
# shared volume fails here with "Source file expired".
import time, uuid
geojson = json.dumps({
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"name": "ci probe"},
        "geometry": {"type": "Point", "coordinates": [-117.0, 33.9]},
    }],
}).encode()
boundary = uuid.uuid4().hex
multipart = (
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="file"; filename="ci-probe.geojson"\r\n'
    "Content-Type: application/geo+json\r\n\r\n"
).encode() + geojson + f"\r\n--{boundary}--\r\n".encode()
user_auth = {"Authorization": f"Bearer {token}"}
status, raw = call(
    "http://portal-api:4000/api/ingest/stage",
    multipart,
    {**user_auth, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    "POST",
)
if status not in (200, 201):
    raise SystemExit(f"stage HTTP {status}: {raw[:400]!r}")
staged = json.loads(raw)
status, raw = call(
    f"http://portal-api:4000/api/items/{item_id}/layers/{layer_id}/import-jobs",
    json.dumps({
        "stagingId": staged["stagingId"],
        "sourceLayerName": staged["layers"][0]["name"],
        "mode": "replace",
    }).encode(),
    {**user_auth, "Content-Type": "application/json"},
    "POST",
)
if status not in (200, 201):
    raise SystemExit(f"import job HTTP {status}: {raw[:400]!r}")
job = json.loads(raw)
deadline = time.time() + 180
while job.get("status") in ("queued", "running") and time.time() < deadline:
    time.sleep(2)
    status, raw = call(f"http://portal-api:4000/api/import-jobs/{job['id']}", headers=user_auth)
    if status != 200:
        raise SystemExit(f"job poll HTTP {status}: {raw[:400]!r}")
    job = json.loads(raw)
if job.get("status") != "succeeded" or job.get("insertedFeatures") != 1:
    raise SystemExit(f"staged import did not finish: {job}")
print("staged import through portal-worker ok")
PY

# Analysis off: the worker stays up without running jobs, and the API
# refuses a derive call with 503. Different host ports so this can
# follow the first boot after that project is removed.
docker compose -p "$PROJECT" -f "$COMPOSE" down -v --remove-orphans >/dev/null
docker rm -f gratis-gis-bootstrap >/dev/null 2>&1 || true

export GRATIS_ANALYSIS=off
export GRATIS_HTTP_PORT=18081
export GRATIS_S3_PORT=18901
export GRATIS_BASE_URL="http://127.0.0.1:18081"
export GRATIS_S3_URL="http://127.0.0.1:18901"
OFF="${PROJECT}-off"
docker compose -p "$OFF" -f "$COMPOSE" up -d --remove-orphans
python3 - "$OFF" "$COMPOSE" <<'PY'
import json, subprocess, sys, time
project, compose = sys.argv[1], sys.argv[2]
deadline = time.time() + 900

def rows():
    ids = subprocess.check_output(
        ["docker", "compose", "-p", project, "-f", compose, "ps", "-aq"],
        text=True,
    ).split()
    found = []
    for cid in ids:
        data = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
        state = data["State"]
        health = (state.get("Health") or {}).get("Status") or "none"
        found.append((data["Name"].lstrip("/"), state["Status"], state.get("ExitCode"), health))
    return found

last = []
while time.time() < deadline:
    last = rows()
    crashed = [row for row in last if row[1] in {"exited", "dead"} or (row[1] == "restarting" and row[2] not in (0, None))]
    if crashed:
        print("off stack container exited", crashed)
        sys.exit(1)
    if last and all(row[1] == "running" and row[3] == "healthy" for row in last):
        print(f"off stack {len(last)} services healthy")
        sys.exit(0)
    time.sleep(5)
print("off stack timed out", last)
sys.exit(1)
PY

docker compose -p "$OFF" -f "$COMPOSE" exec -T portal-api \
  curl -fsS http://127.0.0.1:4000/api/portal-info \
  | python3 -c 'import json,sys; info=json.load(sys.stdin); assert info["features"]["analysis"] is False, info'

# A signed-in derive call is the 503. portal-web does not allow the
# password grant until the test turns it on, and the stack is thrown
# away at the end of this script.
docker compose -p "$OFF" -f "$COMPOSE" exec -T bootstrap python - <<'PY'
import json, urllib.parse, urllib.request
from pathlib import Path

def env():
    values = {}
    for raw in Path("/boot/env").read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            value = value[1:-1]
        values[key] = value
    return values

def post(url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()

import urllib.error
vals = env()
token_body = urllib.parse.urlencode({
    "client_id": "admin-cli",
    "username": "admin",
    "password": vals["KEYCLOAK_ADMIN_PASSWORD"],
    "grant_type": "password",
}).encode()
status, raw = post(
    "http://keycloak:8080/auth/realms/master/protocol/openid-connect/token",
    token_body,
    {"Content-Type": "application/x-www-form-urlencoded"},
)
if status != 200:
    raise SystemExit(f"master token HTTP {status}")
admin = json.loads(raw)["access_token"]
auth = {"Authorization": f"Bearer {admin}", "Content-Type": "application/json"}
req = urllib.request.Request(
    "http://keycloak:8080/auth/admin/realms/gratis-gis/clients?clientId=portal-web",
    headers={"Authorization": f"Bearer {admin}"},
)
with urllib.request.urlopen(req, timeout=30) as resp:
    clients = json.loads(resp.read())
client = clients[0]
client["directAccessGrantsEnabled"] = True
put = urllib.request.Request(
    f"http://keycloak:8080/auth/admin/realms/gratis-gis/clients/{client['id']}",
    data=json.dumps(client).encode(),
    headers=auth,
    method="PUT",
)
try:
    with urllib.request.urlopen(put, timeout=30) as resp:
        put_status = resp.status
except urllib.error.HTTPError as exc:
    put_status = exc.code
if put_status not in (200, 204):
    raise SystemExit(f"enable password grant HTTP {put_status}")
user_body = urllib.parse.urlencode({
    "client_id": "portal-web",
    "username": "admin",
    "password": vals["INITIAL_USER_PASSWORD"],
    "grant_type": "password",
}).encode()
status, raw = post(
    "http://keycloak:8080/auth/realms/gratis-gis/protocol/openid-connect/token",
    user_body,
    {"Content-Type": "application/x-www-form-urlencoded"},
)
if status != 200:
    raise SystemExit(f"user token HTTP {status} {raw[:200]!r}")
user = json.loads(raw)["access_token"]
status, raw = post(
    "http://portal-api:4000/api/items/00000000-0000-4000-8000-000000000001/analysis/hillshade",
    json.dumps({"mode": "dtm", "resolution": 1}).encode(),
    {"Authorization": f"Bearer {user}", "Content-Type": "application/json"},
)
if status != 503:
    raise SystemExit(f"expected 503, got {status} {raw[:300]!r}")
print("analysis off returns 503")
PY

echo "boot-nas-ci: ok"
