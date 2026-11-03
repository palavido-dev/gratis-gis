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

echo "boot-nas-ci: ok"
