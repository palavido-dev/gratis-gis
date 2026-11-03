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

assert mod.lan_ips_from_fib("    |-- 172.17.0.1\n    |-- 192.168.4.15\n") == ["192.168.4.15"]
assert "10.1.2.3" in mod.lan_ips_from_fib("| -- 10.1.2.3")

boot = Path(sys.argv[2])
boot.mkdir(parents=True, exist_ok=True)
os.environ["BOOT_DIR"] = str(boot)
os.environ["GRATIS_BASE_URL"] = "http://192.168.4.15:8080"
os.environ["GRATIS_S3_PORT"] = "8900"
os.environ["GRATIS_SKIP_PATCH"] = "1"
os.environ.pop("GRATIS_MODE", None)
os.environ.pop("GRATIS_TLS", None)
text = run(mod)
assert "Open this address:  http://192.168.4.15:8080" in text
assert "Password:" in text

vals = mod.read_env(boot / "env")
assert vals["PUBLIC_URL"] == "http://192.168.4.15:8080"
assert vals["NEXTAUTH_URL"] == vals["PUBLIC_URL"]
assert vals["KEYCLOAK_URL"] == "http://192.168.4.15:8080/auth"
assert vals["KEYCLOAK_INTERNAL_URL"] == "http://keycloak:8080/auth"
assert vals["KC_HOSTNAME"] == "http://192.168.4.15:8080"
assert vals["KC_HTTP_RELATIVE_PATH"] == "/auth"
assert vals["MINIO_ENDPOINT"] == "http://minio:9000"
assert vals["MINIO_PUBLIC_BASE"] == "http://192.168.4.15:8900"
assert vals["STORAGE_ALLOWED_ORIGINS"] == vals["PUBLIC_URL"]
assert len(vals["INITIAL_USER_PASSWORD"]) >= 16
assert vals["INITIAL_USER_PASSWORD"] not in {"admin", "password", "gratisgis"}
assert len(base64.b64decode(vals["CREDENTIAL_ENCRYPTION_KEY"], validate=True)) == 32
assert "GENERATE" not in (boot / "env").read_text()

realm = json.loads((boot / "realm-gratis-gis.json").read_text())
web = next(client for client in realm["clients"] if client["clientId"] == "portal-web")
assert web["redirectUris"] == ["http://192.168.4.15:8080/*"]
assert web["webOrigins"] == ["http://192.168.4.15:8080"]
assert realm["sslRequired"] == "none"
assert realm["attributes"]["frontendUrl"] == "http://192.168.4.15:8080/auth"
assert "portal-api-admin" in {client["clientId"] for client in realm["clients"]}

caddy = (boot / "Caddyfile").read_text()
assert ":8080" in caddy
assert "/auth/*" in caddy
assert "/auth/admin" in caddy
assert "443" not in caddy

password = vals["INITIAL_USER_PASSWORD"]
run(mod)
assert mod.read_env(boot / "env")["INITIAL_USER_PASSWORD"] == password

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

python3 - "$tmp/config.json" <<'PY'
import json, sys
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
for internal in ("postgres", "keycloak", "portal-api", "portal-web", "portal-worker", "chromium", "bootstrap"):
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
if cfg["services"]["bootstrap"]["image"] != "python:3.12-alpine":
    raise SystemExit("bootstrap image changed")
print("compose config ok")
print("services", len(cfg["services"]))
PY

# The VPS generator still has to emit the tokens Compose requires.
"$SCRIPT_DIR/bootstrap.sh" --quiet \
  --domain gis.example.org --acme-email ci@example.com --yes \
  --env-file "$tmp/vps.env" --realm-out "$tmp/realm.json"
grep -E '^CHROMIUM_TOKEN=.{16,}$' "$tmp/vps.env" >/dev/null
grep -E '^SCRIPT_EXECUTOR_TOKEN=.{16,}$' "$tmp/vps.env" >/dev/null
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/realm.json"

echo "check-nas-compose: ok"
