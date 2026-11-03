#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Prove the NAS / any-host compose file interpolates, pulls no build
# contexts, publishes only Caddy, and that the TrueNAS include wrapper
# resolves to the same project. Does not pull or start containers.
#
#   ./infra/check-nas-compose.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

"$SCRIPT_DIR/bootstrap.sh" \
  --domain gis.example.org \
  --acme-email ci@example.com \
  --yes --quiet \
  --env-file "$tmp/env" \
  --realm-out "$tmp/realm.json"

test -f "$tmp/truenas-include.yaml"
test -f "$tmp/realm.json"

if grep -E '^[A-Z_]+=GENERATE$' "$tmp/env" >/dev/null; then
  echo "env file still contains GENERATE" >&2
  exit 1
fi
for key in CHROMIUM_TOKEN SCRIPT_EXECUTOR_TOKEN CREDENTIAL_ENCRYPTION_KEY POSTGRES_PASSWORD NEXTAUTH_SECRET; do
  grep -E "^${key}=.{16,}$" "$tmp/env" >/dev/null || {
    echo "missing or short ${key}" >&2
    exit 1
  }
done

# The include snippet is what a person pastes. It must not carry secrets.
if grep -E 'TOKEN|PASSWORD|SECRET|ENCRYPTION' "$tmp/truenas-include.yaml" >/dev/null; then
  echo "truenas-include.yaml contains secret material" >&2
  exit 1
fi
grep -F 'services: {}' "$tmp/truenas-include.yaml" >/dev/null
grep -F "$REPO_ROOT/infra/docker-compose.nas.yml" "$tmp/truenas-include.yaml" >/dev/null

python3 - "$tmp/realm.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc["realm"] == "gratis-gis"
blob = json.dumps(doc)
assert "${" not in blob
assert "https://gis.example.org" in blob
assert "https://auth.gis.example.org" in blob
PY

mode="$(stat -c %a "$tmp/realm.json")"
case "$mode" in
  640|644) ;;
  *) echo "realm mode is ${mode}, want 640 or 644" >&2; exit 1 ;;
esac

docker compose -f "$SCRIPT_DIR/docker-compose.nas.yml" --env-file "$tmp/env" \
  config --format json > "$tmp/direct.json"
docker compose -f "$SCRIPT_DIR/docker-compose.nas.yml" --env-file "$tmp/env" \
  --profile scripts config --format json > "$tmp/direct-scripts.json"
# Same shape TrueNAS uses: a wrapper outside the checkout, include +
# env_file, empty services map. Compose must not drop the real services.
docker compose -f "$tmp/truenas-include.yaml" config --format json > "$tmp/wrap.json"

python3 - "$tmp/direct.json" "$tmp/wrap.json" "$tmp/direct-scripts.json" "$REPO_ROOT" <<'PY'
import json, sys
direct = json.load(open(sys.argv[1], encoding="utf-8"))
wrap = json.load(open(sys.argv[2], encoding="utf-8"))
with_scripts = json.load(open(sys.argv[3], encoding="utf-8"))
root = sys.argv[4]

def fail(msg):
    sys.exit(msg)

ours = {
    "postgres": "ghcr.io/palavido-dev/gratis-gis/postgres:",
    "portal-migrate": "ghcr.io/palavido-dev/gratis-gis/portal-api:",
    "portal-api": "ghcr.io/palavido-dev/gratis-gis/portal-api:",
    "portal-worker": "ghcr.io/palavido-dev/gratis-gis/portal-api:",
    "portal-web": "ghcr.io/palavido-dev/gratis-gis/portal-web:",
    "pointcloud-worker": "ghcr.io/palavido-dev/gratis-gis/pointcloud-worker:",
}
profiled = {
    "script-runner": "ghcr.io/palavido-dev/gratis-gis/portal-api:",
    "script-executor": "ghcr.io/palavido-dev/gratis-gis/script-runner:",
}

def env_token(svc):
    env = svc.get("environment") or {}
    if isinstance(env, dict):
        return env.get("TOKEN") or env.get("CHROMIUM_TOKEN") or ""
    for item in env:
        if item.startswith("TOKEN="):
            return item.split("=", 1)[1]
    return ""

def check(cfg, label):
    if cfg.get("name") != "gratis-gis-prod":
        fail(f"{label}: project name is {cfg.get('name')!r}, want gratis-gis-prod")
    services = cfg["services"]
    published = {}
    for name, svc in services.items():
        if svc.get("build"):
            fail(f"{label}: {name} still has a build key")
        ports = []
        for port in svc.get("ports") or []:
            if isinstance(port, dict):
                ports.append(str(port.get("published")))
            else:
                ports.append(str(port))
        if ports:
            published[name] = sorted(ports)
    if set(published) != {"caddy"}:
        fail(f"{label}: published ports {published}")
    if published["caddy"] != ["443", "80"]:
        fail(f"{label}: caddy ports {published['caddy']}")
    for name, prefix in ours.items():
        image = services[name]["image"]
        if not image.startswith(prefix):
            fail(f"{label}: {name} image {image}")
    replicas = services["portal-api"].get("deploy", {}).get("replicas")
    if int(replicas) != 1:
        fail(f"{label}: portal-api replicas {replicas}")
    token = env_token(services["chromium-1"])
    if len(token) < 16 or token in {"GENERATE", "password", "changeme"}:
        fail(f"{label}: chromium token missing or weak")
    if env_token(services["chromium-1"]) != env_token(services["chromium-2"]):
        fail(f"{label}: chromium tokens differ")
    joined = json.dumps(services["postgres"].get("volumes"))
    if "init-prod-db.sql" not in joined or root not in joined:
        fail(f"{label}: postgres init script is not an absolute checkout path")
    caddy_vols = json.dumps(services["caddy"].get("volumes"))
    if "/var/lib/gg-analytics" in caddy_vols:
        fail(f"{label}: caddy still mounts /var/lib/gg-analytics")
    if "Caddyfile" not in caddy_vols:
        fail(f"{label}: caddy file missing")
    hosts = json.dumps(services["portal-api"].get("extra_hosts"))
    if "host-gateway" not in hosts or "auth.gis.example.org" not in hosts:
        fail(f"{label}: portal-api extra_hosts {hosts}")
    # Internal datastores stay off the host network.
    for internal in ("postgres", "keycloak", "minio", "pg_tileserv", "chromium-1", "chromium-2", "portal-api"):
        if services[internal].get("ports"):
            fail(f"{label}: {internal} publishes ports")

check(direct, "direct")
check(wrap, "wrapper")
for name in profiled:
    if name in direct["services"]:
        fail(f"default config started profiled service {name}")
for name, prefix in profiled.items():
    svc = with_scripts["services"].get(name)
    if not svc:
        fail(f"scripts profile is missing {name}")
    if svc.get("build"):
        fail(f"scripts profile {name} still has a build key")
    if not svc["image"].startswith(prefix):
        fail(f"scripts profile {name} image {svc['image']}")
    if svc.get("ports"):
        fail(f"scripts profile {name} publishes ports")
direct_images = {k: direct["services"][k]["image"] for k in ours}
wrap_images = {k: wrap["services"][k]["image"] for k in ours}
if direct_images != wrap_images:
    fail(f"wrapper images differ from direct: {wrap_images}")
print("nas compose config ok")
print("services", len(direct["services"]))
print("caddy is the only published service")
PY

token1="$(grep '^CHROMIUM_TOKEN=' "$tmp/env" | cut -d= -f2-)"
"$SCRIPT_DIR/bootstrap.sh" --rerender --quiet \
  --env-file "$tmp/env" \
  --realm-out "$tmp/realm.json"
token2="$(grep '^CHROMIUM_TOKEN=' "$tmp/env" | cut -d= -f2-)"
if [ "$token1" != "$token2" ]; then
  echo "--rerender changed CHROMIUM_TOKEN" >&2
  exit 1
fi

sed '/^CHROMIUM_TOKEN=/d' "$tmp/env" > "$tmp/broken"
if "$SCRIPT_DIR/bootstrap.sh" --rerender --quiet \
  --env-file "$tmp/broken" \
  --realm-out "$tmp/realm-broken.json" \
  >"$tmp/rerender.out" 2>"$tmp/rerender.err"
then
  echo "rerender without CHROMIUM_TOKEN should have failed" >&2
  exit 1
fi
if ! grep -q 'CHROMIUM_TOKEN' "$tmp/rerender.err"; then
  echo "missing-token error did not name CHROMIUM_TOKEN" >&2
  cat "$tmp/rerender.err" >&2
  exit 1
fi

# A second generate without --force must refuse, so a re-run cannot
# rotate CREDENTIAL_ENCRYPTION_KEY by accident.
if "$SCRIPT_DIR/bootstrap.sh" \
  --domain gis.example.org --acme-email ci@example.com --yes --quiet \
  --env-file "$tmp/env" --realm-out "$tmp/realm.json" \
  >"$tmp/again.out" 2>"$tmp/again.err"
then
  echo "second bootstrap without --force should have failed" >&2
  exit 1
fi
grep -q 'already exists' "$tmp/again.err"

"$SCRIPT_DIR/bootstrap.sh" --quiet \
  --domain gis.example.org --acme-email ci@example.com --yes \
  --org-name 'Town GIS' \
  --env-file "$tmp/env-space" --realm-out "$tmp/realm-space.json"
grep -q '^DEFAULT_ORG_NAME=Town GIS$' "$tmp/env-space"

if "$SCRIPT_DIR/bootstrap.sh" --quiet \
  --domain gis.example.org --acme-email ci@example.com --yes \
  --org-name 'bad$name' \
  --env-file "$tmp/env-bad" --realm-out "$tmp/realm-bad.json" \
  >"$tmp/bad.out" 2>"$tmp/bad.err"
then
  echo "a dollar sign in the organization name should have been rejected" >&2
  exit 1
fi

python3 - "$REPO_ROOT/infra/keycloak/patch-user-profile-via-docker.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("patch", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
schema = {"attributes": [{"name": "username"}]}
assert mod.ensure_org_attributes(schema) is True
names = {item["name"] for item in schema["attributes"]}
assert names == {"username", "org", "org_role"}
assert mod.ensure_org_attributes(schema) is False
print("user-profile patch ok")
PY

echo "check-nas-compose: ok"
