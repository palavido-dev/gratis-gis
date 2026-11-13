#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The pasted NAS compose file interpolates with no env file, publishes
# only the web port and the upload port, and the init script writes a
# realm and an env file whose secrets are random.
#
#   ./infra/check-nas-compose.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

python3 "$SCRIPT_DIR/render-nas-compose.py" --check

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 - "$SCRIPT_DIR/nas-init.py" "$tmp/boot" <<'PY'
import base64, contextlib, importlib.util, io, json, os, shutil, sys
from pathlib import Path

def run(mod):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod.main()
    return buf.getvalue()

spec = importlib.util.spec_from_file_location("nas", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# 10.9.92.0 is the network address of a Docker bridge (TrueNAS/Dockge).
# 10.9.92.1 is that bridge's host address. 192.168.4.15 is the LAN.
fib = """
           |-- 10.9.92.0
              /24 link UNICAST
           |-- 10.9.92.1
              /32 host LOCAL
           |-- 10.9.92.255
              /32 link BROADCAST
           |-- 192.168.4.15
              /32 host LOCAL
           |-- 192.168.4.0
              /24 link UNICAST
           |-- 192.168.4.255
              /32 link BROADCAST
           |-- 127.0.0.1
              /32 host LOCAL
           |-- 172.17.0.1
              /32 host LOCAL
           |-- 172.30.0.2
              /32 host LOCAL
"""
# little-endian hex: 10.9.92.0, 192.168.4.0, 172.17.0.0, 172.30.0.0
route = (
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n"
    "br-ed9d03cda5a1\t005C090A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"
    "eth0\t0004A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"
    "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
    "enp0s3\t00001EAC\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"
)
assert mod.lan_ips_from_fib(fib) == ["10.9.92.1", "192.168.4.15", "172.30.0.2"]
assert "10.9.92.0" not in mod.lan_ips_from_fib(fib)
assert "192.168.4.255" not in mod.lan_ips_from_fib(fib)
assert mod.choose_lan_ip(fib, route) == "192.168.4.15"
docker_only = """
           |-- 10.9.92.0
              /24 link UNICAST
           |-- 10.9.92.1
              /32 host LOCAL
           |-- 172.17.0.1
              /32 host LOCAL
"""
docker_route = (
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n"
    "br-ed9d03cda5a1\t005C090A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"
    "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
)
assert mod.choose_lan_ip(docker_only, docker_route) is None
# 172.30.0.2 is a real LAN on this kind of host when no 192.168 address exists.
assert mod.choose_lan_ip(
    "           |-- 172.30.0.2\n              /32 host LOCAL\n"
    "           |-- 172.17.0.1\n              /32 host LOCAL\n",
    route,
) == "172.30.0.2"

boot = Path(sys.argv[2])
boot.mkdir(parents=True, exist_ok=True)
os.environ["BOOT_DIR"] = str(boot)
os.environ["GRATIS_BASE_URL"] = "http://192.168.4.15:8080"
os.environ["GRATIS_S3_PORT"] = "8900"
os.environ["GRATIS_SKIP_PATCH"] = "1"
os.environ.pop("GRATIS_MODE", None)
os.environ.pop("GRATIS_TLS", None)
os.environ["GRATIS_BOOT_STAMP"] = "tag=edge;mode=lan;base=http://192.168.4.15:8080"
text = run(mod)
# 58-4: the marker carries this boot's stamp, which services compare.
assert (boot / "ready").read_text() == "tag=edge;mode=lan;base=http://192.168.4.15:8080\n"
assert not (boot / "ready.tmp").exists()
os.environ.pop("GRATIS_BOOT_STAMP", None)
assert "Open this address:  http://192.168.4.15:8080" in text
assert "Password:" in text
assert "Do not post it publicly." in text

vals = mod.read_env(boot / "env")
assert vals["PUBLIC_URL"] == "http://192.168.4.15:8080"
assert vals["NEXTAUTH_URL"] == vals["PUBLIC_URL"]
assert vals["KEYCLOAK_URL"] == "http://192.168.4.15:8080/auth"
assert vals["KEYCLOAK_INTERNAL_URL"] == "http://keycloak:8080/auth"
assert vals["KC_HOSTNAME"] == "http://192.168.4.15:8080"
assert vals["KC_HTTP_RELATIVE_PATH"] == "/auth"
assert vals["MINIO_ENDPOINT"] == "http://minio:9000"
assert vals["MINIO_ACCESS_KEY"]
assert vals["MINIO_SECRET_KEY"]
assert vals["MINIO_BUCKET"] == "gratisgis"
assert vals["ANALYSIS_TIERS"] == "server-heavy"
assert vals["BACKUP_DIR"] == "/app/backups"
assert vals["GG_CHANNEL"] == "edge"
assert vals["INSTALL_TYPE"] == "nas"
assert vals["GRATIS_COMPOSE_REV"] == "1"
assert "GG_VERSION" not in vals
assert vals["MINIO_PUBLIC_BASE"] == "http://192.168.4.15:8900"
assert vals["STORAGE_ALLOWED_ORIGINS"] == vals["PUBLIC_URL"]
assert vals["PORTAL_BASE_URL"] == vals["PUBLIC_URL"]
assert len(vals["INITIAL_USER_PASSWORD"]) >= 16
assert vals["INITIAL_USER_PASSWORD"] not in {"admin", "password", "gratisgis"}
assert len(base64.b64decode(vals["CREDENTIAL_ENCRYPTION_KEY"], validate=True)) == 32
assert "GENERATE" not in (boot / "env").read_text()
chromium_env = mod.read_env(boot / "env.chromium")
assert chromium_env == {"CHROMIUM_TOKEN": vals["CHROMIUM_TOKEN"]}, chromium_env
pointcloud_env = mod.read_env(boot / "env.pointcloud")
assert set(pointcloud_env) == {"ANALYSIS_TIERS", "DATABASE_URL", "MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET"}, pointcloud_env
assert "INITIAL_USER_PASSWORD" not in (boot / "env.pointcloud").read_text()

realm = json.loads((boot / "realm-gratis-gis.json").read_text())
web = next(client for client in realm["clients"] if client["clientId"] == "portal-web")
assert web["redirectUris"] == ["http://192.168.4.15:8080/*"]
assert web["webOrigins"] == ["http://192.168.4.15:8080"]
assert realm["sslRequired"] == "none"
assert realm["attributes"]["frontendUrl"] == "http://192.168.4.15:8080/auth"
assert "portal-api-admin" in {client["clientId"] for client in realm["clients"]}
sa = next(
    user for user in realm["users"]
    if user["username"] == "service-account-portal-api-admin"
)
assert sa["serviceAccountClientId"] == "portal-api-admin"
assert set(sa["clientRoles"]["realm-management"]) == {
    "manage-users",
    "manage-realm",
    "view-identity-providers",
    "manage-identity-providers",
}

caddy = (boot / "Caddyfile").read_text()
assert ":8080" in caddy
assert "/auth/*" in caddy
assert "/auth/admin" in caddy
assert "443" not in caddy

password = vals["INITIAL_USER_PASSWORD"]
run(mod)
assert mod.read_env(boot / "env")["INITIAL_USER_PASSWORD"] == password

os.environ["GRATIS_ANALYSIS"] = "off"
run(mod)
assert mod.read_env(boot / "env")["INITIAL_USER_PASSWORD"] == password
assert mod.read_env(boot / "env")["ANALYSIS_TIERS"] == ""
assert mod.read_env(boot / "env")["MINIO_ACCESS_KEY"]
os.environ.pop("GRATIS_ANALYSIS", None)
run(mod)
assert mod.read_env(boot / "env")["ANALYSIS_TIERS"] == "server-heavy"
os.environ["GG_IMAGE_TAG"] = "latest"
run(mod)
assert mod.read_env(boot / "env")["GG_CHANNEL"] == "latest"
os.environ["GG_IMAGE_TAG"] = "v1.2.3"
run(mod)
assert mod.read_env(boot / "env")["GG_CHANNEL"] == "v1.2.3"
os.environ["GG_IMAGE_TAG"] = "sha-abcdef"
run(mod)
assert mod.read_env(boot / "env")["GG_CHANNEL"] == "edge"
os.environ.pop("GG_IMAGE_TAG", None)

# A stored network address (the TrueNAS report was http://10.9.92.0:8080)
# is replaced. Secrets stay. The published port follows GRATIS_HTTP_PORT.
# Caddy inside the container still listens on 8080.
shutil.rmtree(boot)
boot.mkdir()
os.environ["GRATIS_BASE_URL"] = "http://10.9.92.0:8080"
os.environ["GRATIS_HTTP_PORT"] = "8080"
text = run(mod)
assert "http://10.9.92.0:8080" in text
bad_password = mod.read_env(boot / "env")["INITIAL_USER_PASSWORD"]
os.environ.pop("GRATIS_BASE_URL")
os.environ["GRATIS_HTTP_PORT"] = "8085"
os.environ["GRATIS_S3_PORT"] = "8901"
os.environ["GRATIS_DETECT_FIB"] = fib
os.environ["GRATIS_DETECT_ROUTE"] = route
text = run(mod)
assert "Open this address:  http://192.168.4.15:8085" in text
assert "Do not forward ports 8085 or 8901" in text
assert "keep the volumes" in text
vals = mod.read_env(boot / "env")
assert vals["INITIAL_USER_PASSWORD"] == bad_password
assert vals["PUBLIC_URL"] == "http://192.168.4.15:8085"
assert vals["NEXTAUTH_URL"] == vals["PUBLIC_URL"]
assert vals["KEYCLOAK_URL"] == "http://192.168.4.15:8085/auth"
assert vals["KC_HOSTNAME"] == "http://192.168.4.15:8085"
assert vals["MINIO_PUBLIC_BASE"] == "http://192.168.4.15:8901"
assert vals["MINIO_API_CORS_ALLOW_ORIGIN"] == vals["PUBLIC_URL"]
assert vals["STORAGE_ALLOWED_ORIGINS"] == vals["PUBLIC_URL"]
assert vals["PORTAL_BASE_URL"] == vals["PUBLIC_URL"]
realm = json.loads((boot / "realm-gratis-gis.json").read_text())
web = next(client for client in realm["clients"] if client["clientId"] == "portal-web")
assert web["redirectUris"] == ["http://192.168.4.15:8085/*"]
assert web["webOrigins"] == ["http://192.168.4.15:8085"]
assert realm["attributes"]["frontendUrl"] == "http://192.168.4.15:8085/auth"
caddy = (boot / "Caddyfile").read_text()
assert ":8080" in caddy
assert "8085" not in caddy

# Nothing but bridge addresses: instructions, and no realm is published.
shutil.rmtree(boot)
boot.mkdir()
os.environ.pop("GRATIS_HTTP_PORT", None)
os.environ["GRATIS_DETECT_FIB"] = docker_only
os.environ["GRATIS_DETECT_ROUTE"] = docker_route
text = run(mod)
assert "GRATIS_BASE_URL" in text
assert "Do not post it publicly." in text
assert "Password:" not in text
assert not (boot / "ready").exists()
assert not (boot / "realm-gratis-gis.json").exists()
os.environ.pop("GRATIS_DETECT_FIB", None)
os.environ.pop("GRATIS_DETECT_ROUTE", None)
os.environ.pop("GRATIS_S3_PORT", None)

shutil.rmtree(boot)
boot.mkdir()
os.environ["GRATIS_MODE"] = "public"
os.environ["GRATIS_BASE_URL"] = "https://gis.example.org"
os.environ["GRATIS_ACME_EMAIL"] = "you@example.org"
run(mod)
vals = mod.read_env(boot / "env")
assert vals["PUBLIC_URL"] == "https://gis.example.org"
assert vals["KEYCLOAK_URL"] == "https://auth.gis.example.org"
assert vals["MINIO_PUBLIC_BASE"] == "https://storage.gis.example.org"
assert "KC_HTTP_RELATIVE_PATH" not in vals
caddy = (boot / "Caddyfile").read_text()
assert "gis.example.org" in caddy
assert "auth.gis.example.org" in caddy
assert "storage.gis.example.org" in caddy
print("nas-init smoke ok")
PY

docker compose -f "$SCRIPT_DIR/docker-compose.nas.yml" config --format json > "$tmp/config.json"

python3 - "$tmp/config.json" "$REPO_ROOT" <<'PY'
import json, re, sys
from pathlib import Path
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
ports = {}
for name, svc in cfg["services"].items():
    if svc.get("build"):
        raise SystemExit(f"{name} still has a build key")
    published = []
    for port in svc.get("ports") or []:
        if isinstance(port, dict):
            published.append(str(port.get("published")))
        else:
            published.append(str(port))
    if published:
        ports[name] = sorted(published)
if set(ports) != {"caddy", "minio"}:
    raise SystemExit(f"unexpected published ports: {ports}")
if ports["caddy"] != ["8080"] or ports["minio"] != ["8900"]:
    raise SystemExit(f"port map {ports}")


def targets(svc):
    found = []
    for vol in svc.get("volumes") or []:
        if isinstance(vol, dict):
            found.append(vol.get("target"))
        else:
            found.append(str(vol).split(":")[-1])
    return found


kc_targets = targets(cfg["services"]["keycloak"])
if "/boot" not in kc_targets or "/opt/keycloak/data/import" not in kc_targets:
    raise SystemExit(f"keycloak volumes {kc_targets}")
minio_cmd = cfg["services"]["minio"].get("command") or ""
if isinstance(minio_cmd, list):
    minio_cmd = "\n".join(str(part) for part in minio_cmd)
if "/usr/bin/silo" not in minio_cmd:
    raise SystemExit("minio command does not exec silo")
if re.search(r"exec minio( |$)", minio_cmd):
    raise SystemExit("minio command still execs the missing minio binary")
boot_env = cfg["services"]["bootstrap"].get("environment") or {}
if isinstance(boot_env, list):
    boot_env = dict(item.split("=", 1) for item in boot_env)
# 58-4: every service that waits on /boot/ready compares the marker to
# the same stamp bootstrap writes.
stamp = boot_env.get("GRATIS_BOOT_STAMP")
if not stamp or "tag=" not in stamp:
    raise SystemExit("bootstrap has no GRATIS_BOOT_STAMP")
for name, svc in cfg["services"].items():
    cmd = svc.get("command") or ""
    if isinstance(cmd, list):
        cmd = "\n".join(str(part) for part in cmd)
    if "/boot/ready" not in cmd:
        continue
    env = svc.get("environment") or {}
    if isinstance(env, list):
        env = dict(item.split("=", 1) for item in env)
    if env.get("GRATIS_BOOT_STAMP") != stamp:
        raise SystemExit(f"{name} waits on /boot/ready without the boot stamp")
    if "-f /boot/ready" in cmd:
        raise SystemExit(f"{name} still waits on the bare marker")
if str(boot_env.get("GRATIS_HTTP_PORT")) != "8080":
    raise SystemExit(f"bootstrap port {boot_env.get('GRATIS_HTTP_PORT')}")
compose_rev = str(boot_env.get("GRATIS_COMPOSE_REV") or "")
if not compose_rev:
    raise SystemExit("GRATIS_COMPOSE_REV is missing from bootstrap env")
root = Path(sys.argv[2])
dockerfiles = [
    root / "apps/portal-api/Dockerfile",
    root / "apps/portal-web/Dockerfile",
    root / "infra/postgres/Dockerfile",
    root / "tools/pointcloud-worker/Dockerfile",
    root / "infra/script-runner/Dockerfile",
]
for dockerfile in dockerfiles:
    text = dockerfile.read_text(encoding="utf-8")
    marker = f"ARG REQUIRED_COMPOSE_REV={compose_rev}"
    if marker not in text:
        raise SystemExit(f"{dockerfile} does not declare {marker}")
# A build arg in a workflow would override the Dockerfile default this
# check just read, and published images would report a stale rev.
for workflow in sorted((root / ".github/workflows").glob("*.y*ml")):
    if re.search(r"REQUIRED_COMPOSE_REV\s*=", workflow.read_text(encoding="utf-8")):
        raise SystemExit(f"{workflow} sets REQUIRED_COMPOSE_REV; let the Dockerfile default apply")
for name, svc in cfg["services"].items():
    if not svc.get("healthcheck"):
        raise SystemExit(f"{name} has no healthcheck")
caddy_ports = cfg["services"]["caddy"]["ports"]
if not any(str(item.get("target")) == "8080" and str(item.get("published")) == "8080" for item in caddy_ports):
    raise SystemExit(f"caddy ports {caddy_ports}")
minio_ports = cfg["services"]["minio"]["ports"]
if not any(str(item.get("target")) == "9000" and str(item.get("published")) == "8900" for item in minio_ports):
    raise SystemExit(f"minio ports {minio_ports}")
worker = cfg["services"]["pointcloud-worker"]
if not str(worker.get("image", "")).startswith("ghcr.io/palavido-dev/gratis-gis/pointcloud-worker:"):
    raise SystemExit(worker.get("image"))
if worker.get("ports"):
    raise SystemExit("pointcloud-worker publishes a port")
cmd = worker.get("command") or ""
if isinstance(cmd, list):
    cmd = "\n".join(str(part) for part in cmd)
if "pointcloud-worker starting" not in cmd or "/app/runner.py" not in cmd or "sleep infinity" not in cmd:
    raise SystemExit("pointcloud-worker command is missing the on/off switch")
env = worker.get("environment") or {}
if isinstance(env, list):
    env = dict(item.split("=", 1) for item in env)
if env.get("SCRATCH_DIR") != "/scratch":
    raise SystemExit(f"scratch {env.get('SCRATCH_DIR')}")
if env.get("GDAL_DISABLE_READDIR_ON_OPEN") != "EMPTY_DIR":
    raise SystemExit("GDAL lockdown missing")
wt = targets(worker)
# /svc holds only the worker's reduced env; /boot must not be mounted.
if "/svc" not in wt or "/scratch" not in wt or "/boot" in wt:
    raise SystemExit(f"worker volumes {wt}")
api_targets = targets(cfg["services"]["portal-api"])
if "/app/backups" not in api_targets:
    raise SystemExit(f"portal-api volumes {api_targets}")


def env_of(svc):
    found = svc.get("environment") or {}
    if isinstance(found, list):
        found = dict(item.split("=", 1) for item in found)
    return found


def volume_source(svc, target):
    for vol in svc.get("volumes") or []:
        if isinstance(vol, dict) and vol.get("target") == target:
            return vol.get("source")
        if isinstance(vol, str) and vol.split(":")[1:2] == [target]:
            return vol.split(":")[0]
    return None


# portal-api stages uploads and portal-worker imports them. They must
# point STAGING_DIR at one path backed by the same named volume, or
# every queued import fails with "Source file expired".
staging = {}
for name in ("portal-api", "portal-worker"):
    svc = cfg["services"][name]
    path = env_of(svc).get("STAGING_DIR")
    if not path:
        raise SystemExit(f"{name} has no STAGING_DIR")
    source = volume_source(svc, path)
    if not source:
        raise SystemExit(f"{name} does not mount a volume at STAGING_DIR {path}")
    staging[name] = (path, source)
if staging["portal-api"] != staging["portal-worker"]:
    raise SystemExit(f"portal-api and portal-worker staging differ: {staging}")
limit = worker.get("mem_limit")
# Compose reports the byte cap. 2560m is 2560 * 1024 * 1024.
if str(limit) not in {"2560m", "2684354560", "2560M"}:
    raise SystemExit(f"pointcloud mem_limit {limit}")
for internal in ("postgres", "keycloak", "portal-api", "portal-web", "portal-worker", "pointcloud-worker", "chromium", "bootstrap"):
    if cfg["services"][internal].get("ports"):
        raise SystemExit(f"{internal} publishes a port")
api = cfg["services"]["portal-api"]["image"]
web = cfg["services"]["portal-web"]["image"]
pg = cfg["services"]["postgres"]["image"]
if not api.startswith("ghcr.io/palavido-dev/gratis-gis/portal-api:"):
    raise SystemExit(api)
if not web.startswith("ghcr.io/palavido-dev/gratis-gis/portal-web:"):
    raise SystemExit(web)
if not pg.startswith("ghcr.io/palavido-dev/gratis-gis/postgres:"):
    raise SystemExit(pg)
if not cfg["services"]["bootstrap"]["image"].startswith("python:3.12-alpine@sha256:"):
    raise SystemExit("bootstrap image must stay python:3.12-alpine pinned by digest")
if "@sha256:" not in cfg["services"]["chromium"]["image"]:
    raise SystemExit("chromium image must be pinned by digest")


def command_text(svc):
    cmd = svc.get("command") or ""
    return "\n".join(str(part) for part in cmd) if isinstance(cmd, list) else str(cmd)


# Services that handle untrusted input source only their own env file.
for name, env_file in (("chromium", "/svc/env.chromium"), ("pointcloud-worker", "/svc/env.pointcloud")):
    text = command_text(cfg["services"][name])
    if env_file not in text or re.search(r"\. /boot/env\s*$", text, re.M):
        raise SystemExit(f"{name} must source {env_file}, not /boot/env")
    # The boot volume holds every secret; these services must not mount it.
    for vol in cfg["services"][name].get("volumes") or []:
        if (vol.get("source") if isinstance(vol, dict) else str(vol).split(":")[0]) == "boot":
            raise SystemExit(f"{name} must not mount the boot volume")
for name in ("portal-api", "portal-worker", "portal-web", "pointcloud-worker"):
    svc = cfg["services"][name]
    if "ALL" not in (svc.get("cap_drop") or []):
        raise SystemExit(f"{name} must drop all capabilities")
    if "no-new-privileges:true" not in (svc.get("security_opt") or []):
        raise SystemExit(f"{name} must set no-new-privileges")
print("compose config ok")
print("services", len(cfg["services"]))
PY

GRATIS_HTTP_PORT=8085 GRATIS_S3_PORT=8910 \
  docker compose -f "$SCRIPT_DIR/docker-compose.nas.yml" config --format json > "$tmp/config-8085.json"

python3 - "$tmp/config-8085.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
caddy = cfg["services"]["caddy"]["ports"][0]
minio = cfg["services"]["minio"]["ports"][0]
if str(caddy.get("published")) != "8085" or str(caddy.get("target")) != "8080":
    raise SystemExit(f"caddy {caddy}")
if str(minio.get("published")) != "8910" or str(minio.get("target")) != "9000":
    raise SystemExit(f"minio {minio}")
env = cfg["services"]["bootstrap"]["environment"]
if str(env.get("GRATIS_HTTP_PORT")) != "8085" or str(env.get("GRATIS_S3_PORT")) != "8910":
    raise SystemExit(env)
print("compose port override ok")
PY

# The VPS generator still has to emit the tokens Compose requires.
"$SCRIPT_DIR/bootstrap.sh" --quiet \
  --domain gis.example.org --acme-email ci@example.com --yes \
  --env-file "$tmp/vps.env" --realm-out "$tmp/realm.json"
grep -E '^CHROMIUM_TOKEN=.{16,}$' "$tmp/vps.env" >/dev/null
grep -E '^SCRIPT_EXECUTOR_TOKEN=.{16,}$' "$tmp/vps.env" >/dev/null
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/realm.json"

echo "check-nas-compose: ok"
