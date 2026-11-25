#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""First-boot init for the pasted NAS compose file.

Runs inside the bootstrap container (python:3.12-alpine). On an empty
volume it generates secrets, a Keycloak realm, and a Caddyfile, then
prints the address. The admin password is printed only when the
secrets are first created. Until the admin changes it at first
sign-in, it is also stored in the boot volume (the env file and the
realm import), which the stack's own containers mount. A second start
keeps the same secrets and does not print the password again.

No default passwords. Secrets are random per install.
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

WEAK = {"password", "devpassword", "admin", "changeme", "secret", "gratisgis"}


def boot_dir() -> Path:
    return Path(os.environ.get("BOOT_DIR", "/boot"))


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def rand(n: int = 32) -> str:
    # Letters and digits only, so the env file and the database URL
    # stay easy to source.
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(n))


def encryption_key() -> str:
    return base64.b64encode(secrets.token_bytes(32)).decode("ascii")


# Docker and TrueNAS app bridges. br0 (a LAN bridge) stays eligible.
# br- plus a hex id is a Docker network.
_SKIP_IFACE = re.compile(
    r"^(lo|docker\d*|br-[0-9a-f]+|veth.+|cni\d*|flannel.+|cali.+|"
    r"kube.*|virbr\d*|lxcbr\d*|podman\d*|weave|zt.+|"
    r"tailscale\d*|dummy\d*|tunl\d*|cni0)$",
    re.IGNORECASE,
)


def _parse_ipv4(ip: str) -> tuple[int, int, int, int] | None:
    parts = ip.split(".")
    if len(parts) != 4:
        return None
    nums: list[int] = []
    for part in parts:
        if not part.isdigit():
            return None
        value = int(part)
        if value > 255:
            return None
        nums.append(value)
    return (nums[0], nums[1], nums[2], nums[3])


def _le_hex(value: str) -> int:
    """/proc/net/route prints IPv4 addresses as little-endian hex."""
    raw = int(value, 16)
    return (
        ((raw & 0xFF) << 24)
        | ((raw & 0xFF00) << 8)
        | ((raw & 0xFF0000) >> 8)
        | ((raw >> 24) & 0xFF)
    )


def _ipv4_int(ip: str) -> int:
    nums = _parse_ipv4(ip)
    if nums is None:
        return 0
    return (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]


def _publishable_lan(ip: str) -> bool:
    """A host address another computer on the LAN can open.

    Network addresses (x.x.x.0) and broadcasts (x.x.x.255) appear in
    fib_trie next to the real host address. 127.0.0.1 and link-local
    addresses are not the NAS. 172.17/18/19 are the default Docker pools.
    """
    nums = _parse_ipv4(ip)
    if nums is None:
        return False
    if nums[0] in (0, 127) or (nums[0] == 169 and nums[1] == 254):
        return False
    if nums[3] in (0, 255):
        return False
    if nums[0] == 10 or (nums[0] == 192 and nums[1] == 168):
        return True
    if nums[0] == 172 and 16 <= nums[1] <= 31 and nums[1] not in (17, 18, 19):
        return True
    return False


def lan_ips_from_fib(text: str) -> list[str]:
    """Host addresses marked `host LOCAL` in /proc/net/fib_trie."""
    found: list[str] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})\s*$", line)
        if not match:
            continue
        window = "\n".join(lines[index : index + 3])
        if "host LOCAL" not in window:
            continue
        ip = match.group(1)
        if _publishable_lan(ip) and ip not in found:
            found.append(ip)
    return found


def routes_from_proc(text: str) -> list[tuple[str, int, int]]:
    """Interface, network, and mask from /proc/net/route."""
    routes: list[tuple[str, int, int]] = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 8:
            continue
        iface, dest, _gateway, _flags, _ref, _use, _metric, mask = parts[:8]
        try:
            network = _le_hex(dest)
            netmask = _le_hex(mask)
        except ValueError:
            continue
        if netmask == 0:
            continue
        routes.append((iface, network, netmask))
    return routes


def iface_for_ip(ip: str, routes: list[tuple[str, int, int]]) -> str | None:
    ip_int = _ipv4_int(ip)
    best: str | None = None
    best_bits = -1
    for iface, network, netmask in routes:
        if ip_int & netmask == network & netmask:
            bits = bin(netmask).count("1")
            if bits > best_bits:
                best = iface
                best_bits = bits
    return best


def choose_lan_ip(fib: str, route: str) -> str | None:
    """Pick a LAN address, or None when only bridge addresses exist."""
    routes = routes_from_proc(route) if route.strip() else []
    ranked: list[tuple[int, str]] = []
    for ip in lan_ips_from_fib(fib):
        iface = iface_for_ip(ip, routes) if routes else None
        if iface and _SKIP_IFACE.match(iface):
            continue
        nums = _parse_ipv4(ip)
        if nums is None:
            continue
        if nums[0] == 192:
            rank = 0
        elif nums[0] == 10:
            rank = 1
        else:
            rank = 2
        ranked.append((rank, ip))
    if not ranked:
        return None
    ranked.sort()
    return ranked[0][1]


def read_host_tables() -> tuple[str, str]:
    """fib_trie and route from the host network namespace when pid is host.

    GRATIS_DETECT_FIB / GRATIS_DETECT_ROUTE replace both files so tests
    do not read this machine.
    """
    if "GRATIS_DETECT_FIB" in os.environ or "GRATIS_DETECT_ROUTE" in os.environ:
        return (
            os.environ.get("GRATIS_DETECT_FIB", ""),
            os.environ.get("GRATIS_DETECT_ROUTE", ""),
        )
    fib = ""
    route = ""
    for path in ("/proc/1/net/fib_trie", "/proc/net/fib_trie"):
        try:
            fib = Path(path).read_text(encoding="utf-8", errors="replace")
            break
        except OSError:
            continue
    for path in ("/proc/1/net/route", "/proc/net/route"):
        try:
            route = Path(path).read_text(encoding="utf-8", errors="replace")
            break
        except OSError:
            continue
    return fib, route


def detect_lan_ip() -> str | None:
    fib, route = read_host_tables()
    return choose_lan_ip(fib, route)


def saved_host_is_bad(host: str) -> bool:
    """A stored address that must not be printed again.

    Hostnames and Tailscale addresses (100.64/10) are kept. IPv4 network
    and broadcast addresses, loopback, link-local, the default Docker
    pools, and the current Docker-bridge interface are not.
    """
    if not host or host == "localhost" or host.startswith("127."):
        return True
    nums = _parse_ipv4(host)
    if nums is None:
        return False
    if nums[0] == 169 and nums[1] == 254:
        return True
    if nums[3] in (0, 255):
        return True
    if nums[0] == 172 and nums[1] in (17, 18, 19):
        return True
    _fib, route = read_host_tables()
    iface = iface_for_ip(host, routes_from_proc(route)) if route.strip() else None
    if iface and _SKIP_IFACE.match(iface):
        return True
    return False


def write_env(path: Path, values: dict[str, str]) -> None:
    lines = [
        "# Generated by infra/nas-init.py. Random per install.",
        "# Do not commit this file. It lives on the Docker volume.",
    ]
    for key, value in values.items():
        lines.append(f"{key}={sh_quote(value)}")
    # Temp file and rename: other services source this file while this
    # one may be rewriting it, and an in-place rewrite could hand them
    # half a file.
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.chmod(0o644)
    os.replace(tmp, path)


# Services that handle untrusted input get only the variables they read.
# chromium renders user-authored map styles; pointcloud-worker parses
# uploaded point clouds and rasters with PDAL and GDAL.
SERVICE_ENV_KEYS = {
    "env.chromium": ("CHROMIUM_TOKEN",),
    "env.pointcloud": (
        "ANALYSIS_TIERS",
        "DATABASE_URL",
        "MINIO_ENDPOINT",
        "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
        "MINIO_BUCKET",
    ),
}


# Where each reduced file goes. Each service mounts only its own small
# volume: mounting the whole boot volume handed them /boot/env (every
# secret, mode 0644) one open() away, which defeated the reduced env.
SERVICE_ENV_DIRS = {
    "env.chromium": "CHROMIUM_ENV_DIR",
    "env.pointcloud": "POINTCLOUD_ENV_DIR",
}


def write_service_envs(boot: Path, values: dict[str, str]) -> None:
    for name, keys in SERVICE_ENV_KEYS.items():
        target_dir = os.environ.get(SERVICE_ENV_DIRS[name], "").strip()
        target = Path(target_dir) / name if target_dir else boot / name
        write_env(target, {key: values.get(key, "") for key in keys})
        if target_dir:
            # The copy an older version left on the boot volume.
            (boot / name).unlink(missing_ok=True)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            value = value[1:-1].replace("'\"'\"'", "'")
        values[key] = value
    return values


def org_mappers() -> list[dict]:
    def one(name: str) -> dict:
        return {
            "name": name,
            "protocol": "openid-connect",
            "protocolMapper": "oidc-usermodel-attribute-mapper",
            "consentRequired": False,
            "config": {
                "userinfo.token.claim": "true",
                "user.attribute": name,
                "id.token.claim": "true",
                "access.token.claim": "true",
                "claim.name": name,
                "jsonType.label": "String",
            },
        }

    return [one("org"), one("org_role")]


# Same realm-management roles the dev realm and deploy.sh grant.
# manage-users is what lets the Users page list people. Without it
# Keycloak answers 403. The service account cannot grant these to
# itself, so the master admin does it after import too.
ADMIN_CLIENT_ROLES = (
    "manage-users",
    "manage-realm",
    "view-identity-providers",
    "manage-identity-providers",
)


def sign_in_origins(values: dict[str, str]) -> list[str]:
    """The one browser origin that may complete sign-in.

    Keycloak 26 only treats a trailing * as a path wildcard, so a
    redirect pattern cannot mean "any Tailscale hostname". The
    operator sets GRATIS_BASE_URL to the address they open, including
    a MagicDNS name, and a restart updates Keycloak in place.
    """
    public = values.get("PUBLIC_URL", "").strip().rstrip("/")
    return [public] if public else []


def apply_sign_in_client(client: dict, origins: list[str]) -> dict:
    """Point the portal-web client at the current sign-in origins."""
    updated = dict(client)
    updated["redirectUris"] = [f"{origin}/*" for origin in origins]
    updated["webOrigins"] = list(origins)
    attrs = dict(updated.get("attributes") or {})
    attrs["post.logout.redirect.uris"] = "##".join(f"{origin}/*" for origin in origins)
    attrs["pkce.code.challenge.method"] = attrs.get("pkce.code.challenge.method") or "S256"
    updated["attributes"] = attrs
    return updated


def apply_sign_in_realm(realm: dict, auth_url: str, origins: list[str]) -> dict:
    """Keep the realm frontend URL and SSL mode aligned with sign-in.

    One origin pins frontendUrl, which is what makes Keycloak send the
    browser to that address. Several origins leave frontendUrl unset so
    Keycloak follows the host the reverse proxy forwarded, and only
    those exact origins are registered as redirects.
    """
    updated = dict(realm)
    updated["sslRequired"] = (
        "external" if origins and all(origin.startswith("https://") for origin in origins) else "none"
    )
    attrs = dict(updated.get("attributes") or {})
    if len(origins) == 1:
        attrs["frontendUrl"] = auth_url
    else:
        attrs.pop("frontendUrl", None)
    updated["attributes"] = attrs
    return updated


def caddy_auth_hosts(origins: list[str]) -> list[str]:
    hosts: list[str] = []
    for origin in origins:
        host = urllib.parse.urlparse(origin).hostname
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def build_realm(values: dict[str, str]) -> dict:
    public = values["PUBLIC_URL"]
    auth = values["KEYCLOAK_URL"]
    origins = sign_in_origins(values) or [public]
    https = all(origin.startswith("https://") for origin in origins)
    return {
        "realm": "gratis-gis",
        "enabled": True,
        "displayName": "Portal",
        "loginTheme": "keycloak",
        "registrationAllowed": False,
        "resetPasswordAllowed": True,
        "sslRequired": "external" if https else "none",
        "accessTokenLifespan": 300,
        "ssoSessionIdleTimeout": 3600,
        "ssoSessionMaxLifespan": 36000,
        "offlineSessionIdleTimeout": 2592000,
        "bruteForceProtected": True,
        "failureFactor": 8,
        "attributes": {"frontendUrl": auth} if len(origins) == 1 else {},
        "clients": [
            {
                "clientId": "portal-web",
                "name": "GratisGIS Portal Web",
                "enabled": True,
                "publicClient": True,
                "standardFlowEnabled": True,
                "directAccessGrantsEnabled": False,
                "redirectUris": [f"{origin}/*" for origin in origins],
                "webOrigins": list(origins),
                "attributes": {
                    "pkce.code.challenge.method": "S256",
                    "post.logout.redirect.uris": "##".join(
                        f"{origin}/*" for origin in origins
                    ),
                },
                "protocolMappers": org_mappers(),
            },
            {
                "clientId": "portal-api",
                "name": "GratisGIS Portal API",
                "enabled": True,
                "bearerOnly": True,
            },
            {
                "clientId": "portal-api-admin",
                "name": "GratisGIS Portal API (admin)",
                "enabled": True,
                "publicClient": False,
                "serviceAccountsEnabled": True,
                "standardFlowEnabled": False,
                "directAccessGrantsEnabled": False,
                "clientAuthenticatorType": "client-secret",
                "secret": values["KEYCLOAK_ADMIN_CLIENT_SECRET"],
            },
            {
                "clientId": "field-app",
                "name": "GratisGIS Field App",
                "enabled": True,
                "publicClient": True,
                "standardFlowEnabled": True,
                "directAccessGrantsEnabled": False,
                "redirectUris": ["gratisgis://auth-callback"],
                "webOrigins": [],
                "attributes": {"pkce.code.challenge.method": "S256"},
                "protocolMappers": org_mappers(),
            },
            {
                "clientId": "qgis-plugin",
                "name": "GratisGIS QGIS Plugin",
                "enabled": True,
                "publicClient": True,
                "standardFlowEnabled": True,
                "directAccessGrantsEnabled": False,
                "redirectUris": ["gratisgis-qgis://auth-callback", "http://127.0.0.1:*"],
                "attributes": {"pkce.code.challenge.method": "S256"},
                "protocolMappers": org_mappers(),
            },
        ],
        "roles": {
            "realm": [
                {"name": "viewer", "description": "Default user role"},
                {"name": "contributor", "description": "Can publish items"},
                {"name": "admin", "description": "Org administrator"},
            ]
        },
        "defaultRole": {"name": "viewer"},
        "users": [
            {
                "username": "admin",
                "enabled": True,
                "email": values.get("ACME_EMAIL") or "admin@gratis.lan",
                "emailVerified": True,
                "firstName": "Site",
                "lastName": "Admin",
                "credentials": [
                    {
                        "type": "password",
                        "value": values["INITIAL_USER_PASSWORD"],
                        "temporary": True,
                    }
                ],
                "attributes": {
                    "org": [values["DEFAULT_ORG_SLUG"]],
                    "org_role": ["admin"],
                },
                "realmRoles": ["admin", "offline_access"],
            },
            {
                "username": "service-account-portal-api-admin",
                "enabled": True,
                "serviceAccountClientId": "portal-api-admin",
                "clientRoles": {
                    "realm-management": list(ADMIN_CLIENT_ROLES),
                },
            },
        ],
    }


# Same headers as the production Caddyfile, without HSTS. HSTS on a
# plain-HTTP LAN address would pin the browser to HTTPS and break
# the default install. The portal page also sends its own content
# security policy from portal-web.
LAN_SECURITY_HEADERS = """\theader {
\t\tX-Content-Type-Options nosniff
\t\tX-Frame-Options SAMEORIGIN
\t\tReferrer-Policy strict-origin-when-cross-origin
\t\tPermissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), midi=(), magnetometer=(), accelerometer=(), gyroscope=()"
\t\tCross-Origin-Opener-Policy same-origin
\t\t-Server
\t}
"""


# ---------------------------------------------------------------------
# Status page.
#
# Caddy starts before everything else (see the caddy service) and shows
# this page whenever the portal does not answer: on the first start,
# during an update, and when something fails. It reads two small files
# in the status volume: bootstrap.json (written here) and api.json
# (written by portal-api, apps/portal-api/src/startup-status.ts). A
# person who has never opened a container log can see what is going on
# and, when the address cannot be found, set it with one click.
#
# No dollar signs anywhere in this block: this file is pasted into a
# compose file, and Compose would read them as variables.
# ---------------------------------------------------------------------

STATUS_DIR = Path(os.environ.get("STATUS_DIR", "/status"))
SETUP_PORT = 8099


def ensure_status_dir() -> None:
    try:
        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        # portal-api runs as an unprivileged user and writes api.json here.
        STATUS_DIR.chmod(0o1777)
    except OSError:
        pass


def write_boot_status(phase: str, **extra: str) -> None:
    """Best effort: a status write never stops the bootstrap."""
    try:
        body = {"phase": phase, "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        body.update({k: v for k, v in extra.items() if v})
        tmp = STATUS_DIR / "bootstrap.json.tmp"
        tmp.write_text(json.dumps(body) + "\n", encoding="utf-8")
        tmp.chmod(0o644)
        os.replace(tmp, STATUS_DIR / "bootstrap.json")
    except OSError:
        pass


def write_status_page(boot: Path) -> None:
    page_dir = boot / "status-page"
    page_dir.mkdir(parents=True, exist_ok=True)
    page_dir.chmod(0o755)
    page = page_dir / "index.html"
    page.write_text(STATUS_PAGE_HTML, encoding="utf-8")
    page.chmod(0o644)


# Added to every generated site block. handle_errors catches the 502
# Caddy returns while portal-web or portal-api is not answering.
STATUS_ROUTES = """\
\t# Status page (nas-init.py, STATUS_PAGE_HTML). Shown while the portal
\t# is starting, updating, or failed to start.
\thandle /__gg_ping {
\t\trespond "ok" 200
\t}
\thandle_path /__gg_status/* {
\t\troot * /status
\t\theader Cache-Control no-store
\t\tfile_server
\t}
\thandle_errors 502 503 504 {
\t\t@api path /api/*
\t\thandle @api {
\t\t\theader Retry-After 30
\t\t\trespond `{"error":"GratisGIS is starting. Try again in a minute."}` 503
\t\t}
\t\thandle {
\t\t\troot * /boot/status-page
\t\t\trewrite * /index.html
\t\t\theader Cache-Control no-store
\t\t\theader X-GG-Status 1
\t\t\tfile_server
\t\t}
\t}
"""


def check_browser_address(url: str) -> str:
    """The error to show, or '' when the address can be used."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return "The address must start with http:// or https://."
    if not parsed.hostname:
        return "The address is missing the computer's name or number."
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return "Use only the address, without anything after the port number."
    return ""


def _ask_in_browser(path: str, phase: str, accept, **status_extra: str) -> str:
    """Wait for the status page to answer one setup question.

    Serves POST <path> on SETUP_PORT (Caddy forwards /__gg_setup/* here
    on the compose network; the port is not published). accept(data)
    returns (problem, value): a problem goes back to the page, a value
    ends the wait and is returned. The answer stays in memory.
    """
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    chosen: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802 - http.server API
            if self.path.rstrip("/") != path:
                self._send(404, {"error": "This question was already answered. Refresh the page."})
                return
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                self._send(415, {"error": "send JSON"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 4096:
                self._send(400, {"error": "bad request"})
                return
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError
            except (ValueError, UnicodeDecodeError):
                self._send(400, {"error": "bad request"})
                return
            problem, value = accept(data)
            if problem:
                self._send(400, {"error": problem})
                return
            if not chosen:
                chosen["value"] = value
            self._send(200, {"ok": True})
            threading.Thread(target=server.shutdown, daemon=True).start()

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    server = ThreadingHTTPServer(("0.0.0.0", SETUP_PORT), Handler)
    write_boot_status(phase, **status_extra)
    server.serve_forever()
    server.server_close()
    return chosen["value"]


def ask_address_in_browser(port: str) -> str:
    """The address from the browser's address bar, confirmed on the page.

    Used only when no address could be detected or was set.
    """
    print(
        "\n========== GratisGIS ==========\n"
        "Open this app's web page in a browser to finish setup.\n"
        f"From another computer or phone: http://<this computer's address>:{port}\n"
        "Click the button there to use that address.\n"
        "===============================\n",
        flush=True,
    )

    def accept(data: dict) -> tuple[str, str]:
        url = str(data.get("url", "")).strip().rstrip("/")
        problem = check_browser_address(url)
        return problem, url

    return _ask_in_browser("/__gg_setup/address", "need-address", accept, port=port)


ADMIN_PASSWORD_MIN = 10


def check_admin_password(password: str, confirm: str) -> str:
    """The problem to show, or '' when the password can be used."""
    if len(password) < ADMIN_PASSWORD_MIN:
        return f"Use at least {ADMIN_PASSWORD_MIN} characters. A short sentence is easy to remember."
    if len(password) > 256:
        return "That password is too long."
    if password != confirm:
        return "The two passwords are not the same. Type them again."
    if password.strip().lower() in ("admin12345", "password12", "1234567890", "qwertyuiop"):
        return "That password is too easy to guess. Pick another one."
    return ""


def ask_admin_password_in_browser() -> str:
    """The admin password, chosen on the status page on the first start.

    Kept in memory only, then set in Keycloak by set_admin_password()
    once sign-in is running. The boot volume only ever holds the random
    first-start password, which this replaces.
    """
    print(
        "\n========== GratisGIS ==========\n"
        "Open this app's web page in a browser and choose the admin\n"
        "password there to finish setup.\n"
        "===============================\n",
        flush=True,
    )

    def accept(data: dict) -> tuple[str, str]:
        password = str(data.get("password", ""))
        confirm = str(data.get("confirm", ""))
        return check_admin_password(password, confirm), password

    return _ask_in_browser("/__gg_setup/admin", "need-admin", accept)


def wants_setup_questions(values: dict[str, str]) -> bool:
    """Ask on the status page only for an interactive LAN install.

    A public install is reachable from the internet before anyone has
    signed in, so its first password stays in the bootstrap log.
    GRATIS_UNATTENDED=1 (CI, scripted installs) skips the questions too.
    """
    if os.environ.get("GRATIS_UNATTENDED", "").strip() in ("1", "true", "yes"):
        return False
    if os.environ.get("GRATIS_SKIP_PATCH") == "1":
        return False
    return values.get("GRATIS_MODE", "lan") != "public"


def set_admin_password(values: dict[str, str], password: str, wait_seconds: int = 600) -> bool:
    """Make `password` the admin's permanent password in Keycloak."""
    internal = values["KEYCLOAK_INTERNAL_URL"].rstrip("/")
    deadline = time.time() + wait_seconds
    while True:
        try:
            form = urllib.parse.urlencode(
                {
                    "client_id": "admin-cli",
                    "username": "admin",
                    "password": values["KEYCLOAK_ADMIN_PASSWORD"],
                    "grant_type": "password",
                }
            ).encode()
            status, raw = _request(
                f"{internal}/realms/master/protocol/openid-connect/token",
                "POST",
                form,
                {"Content-Type": "application/x-www-form-urlencoded"},
            )
            if status == 200:
                token = json.loads(raw).get("access_token") or ""
                auth = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
                status, raw = _request(
                    f"{internal}/admin/realms/gratis-gis/users?username=admin&exact=true",
                    "GET",
                    None,
                    auth,
                )
                users = json.loads(raw) if status == 200 else []
                if users:
                    user_url = f"{internal}/admin/realms/gratis-gis/users/{users[0]['id']}"
                    put = {**auth, "Content-Type": "application/json"}
                    body = json.dumps({"type": "password", "value": password, "temporary": False}).encode()
                    status, _ = _request(f"{user_url}/reset-password", "PUT", body, put)
                    if status in (200, 204):
                        # The first-start password was temporary, which left
                        # a forced password change on the account. Clear it.
                        _request(user_url, "PUT", json.dumps({"requiredActions": []}).encode(), put)
                        return True
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError):
            pass
        if time.time() > deadline:
            return False
        time.sleep(5)


STATUS_PAGE_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>GratisGIS</title>
<style>
  :root { color-scheme: light dark; --accent: #0f766e; --ink: #1c1917; --muted: #57534e; --bg: #f5f5f4; --card: #ffffff; --line: #d6d3d1; --bad: #b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f5f5f4; --muted: #c4c0bc; --bg: #1c1917; --card: #292524; --line: #44403c; --accent: #2dd4bf; --bad: #f97066; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         background: var(--bg); color: var(--ink); font: 19px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 560px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px; }
  .brand { font-weight: 700; font-size: 18px; color: var(--accent); letter-spacing: .01em; margin: 0 0 20px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
  p { margin: 0 0 14px; }
  .muted { color: var(--muted); font-size: 16px; }
  .spinner { width: 40px; height: 40px; border: 4px solid var(--line); border-top-color: var(--accent); border-radius: 50%;
             animation: spin 1s linear infinite; margin: 8px 0 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .address { display: block; font: 600 20px/1.4 ui-monospace, Menlo, Consolas, monospace; background: var(--bg);
             border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 8px 0 16px; word-break: break-all; }
  button { font: 600 19px/1 system-ui, sans-serif; background: var(--accent); color: #fff; border: 0; border-radius: 10px;
           padding: 16px 22px; cursor: pointer; min-height: 52px; }
  button.secondary { background: transparent; color: var(--accent); border: 2px solid var(--accent); }
  button:disabled { opacity: .6; cursor: default; }
  .bad { color: var(--bad); font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; font: 13px/1.45 ui-monospace, Menlo, Consolas, monospace;
        background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; max-height: 320px; overflow: auto; }
  details { margin: 14px 0; }
  summary { cursor: pointer; font-weight: 600; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
  a { color: var(--accent); }
  form { display: grid; gap: 8px; }
  label { font-weight: 600; margin-top: 6px; }
  label.check { font-weight: 400; display: flex; align-items: center; gap: 8px; }
  input[type=password], input[type=text] { font: 19px/1.3 system-ui, sans-serif; padding: 12px 14px; border: 1px solid var(--line);
    border-radius: 10px; background: var(--bg); color: var(--ink); width: 100%; }
  input[type=checkbox] { width: 22px; height: 22px; }
  form button { margin-top: 10px; }
</style>
</head>
<body>
<main aria-live="polite">
  <p class="brand">GratisGIS</p>
  <div id="view">
    <div class="spinner" role="img" aria-label="Working"></div>
    <h1>Starting GratisGIS</h1>
    <p>This page will change by itself when it is ready.</p>
  </div>
  <noscript><p>Turn on JavaScript to see progress here, or refresh this page in a minute.</p></noscript>
</main>
<script>
(function () {
  var view = document.getElementById('view');
  var STEPS = {
    'setting-up': ['Setting up GratisGIS', 'This is the first start. GratisGIS is creating its database and sign-in. This takes a few minutes.'],
    'starting': ['Starting GratisGIS', 'This usually takes about a minute.'],
    'database-check': ['Checking the database', 'GratisGIS checks its database at every start. This is usually quick.'],
    'database-rebuild': ['Updating the database', 'An update changed how the database sorts text, so GratisGIS is rebuilding its indexes. With a lot of data this can take several minutes. Leave the computer on.'],
    'database-update': ['Applying updates', 'GratisGIS is updating its database to the new version. Leave the computer on.'],
    'app-starting': ['Almost ready', 'The database is ready. GratisGIS is starting.'],
    'ready': ['Almost ready', 'GratisGIS is starting its web pages.']
  };

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) { for (var k in attrs) { node.setAttribute(k, attrs[k]); } }
    if (text) { node.textContent = text; }
    return node;
  }

  function minutesSince(iso) {
    var t = Date.parse(iso || '');
    if (!t) { return null; }
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  }

  function getJson(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; });
  }

  function issueLink(log) {
    var body = 'GratisGIS did not start. The status page showed:\\n\\n```\\n' + (log || '') + '\\n```\\n';
    return 'https://github.com/palavido-dev/gratis-gis/issues/new?title=' +
      encodeURIComponent('GratisGIS did not start') + '&body=' + encodeURIComponent(body.slice(0, 6000));
  }

  function showWorking(title, text, since, extra) {
    view.replaceChildren();
    view.appendChild(el('div', { 'class': 'spinner', role: 'img', 'aria-label': 'Working' }));
    view.appendChild(el('h1', null, title));
    if (text) { view.appendChild(el('p', null, text)); }
    if (extra) { view.appendChild(extra); }
    var mins = minutesSince(since);
    var note = 'This page will change by itself when it is ready.';
    if (mins !== null && mins >= 1) { note = 'Started ' + mins + (mins === 1 ? ' minute' : ' minutes') + ' ago. ' + note; }
    view.appendChild(el('p', { 'class': 'muted' }, note));
  }

  // Plain words for the failures people hit most. The details below
  // still carry the full error.
  var HINTS = [
    [/No space left on device|ENOSPC/i, 'The disk is full. Free up space on this computer, then restart the GratisGIS app.'],
    [/ENOMEM|out of memory|heap out of memory|Killed/i, 'The computer ran out of memory. Close other apps or give GratisGIS more memory, then restart it.'],
    [/ENOTFOUND postgres|ECONNREFUSED|Can.t reach database server|P1001/i, 'GratisGIS could not reach its database. It may still be starting. If this stays for more than a few minutes, restart the GratisGIS app.'],
    [/collation/i, 'GratisGIS could not finish updating its database after an upgrade.'],
    [/P3009|migrate found failed migrations|P3018/i, 'An update to the database did not finish.']
  ];
  function hintFor(log) {
    for (var i = 0; i < HINTS.length; i++) { if (HINTS[i][0].test(log || '')) { return HINTS[i][1]; } }
    return '';
  }

  function failureDetails(log, label) {
    var box = el('details');
    box.appendChild(el('summary', null, label));
    var pre = el('pre', null, log || 'No details were recorded.');
    box.appendChild(pre);
    // The error is at the end. Show that part first.
    box.addEventListener('toggle', function () { pre.scrollTop = pre.scrollHeight; });
    setTimeout(function () { pre.scrollTop = pre.scrollHeight; }, 0);
    var row = el('div', { 'class': 'row' });
    var copy = el('button', { type: 'button', 'class': 'secondary' }, 'Copy the details');
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; };
      if (navigator.clipboard) { navigator.clipboard.writeText(log || '').then(done, done); } else { done(); }
    });
    var report = el('a', { href: issueLink(log), target: '_blank', rel: 'noopener' }, 'Report it on GitHub');
    row.appendChild(copy);
    row.appendChild(report);
    box.appendChild(row);
    return box;
  }

  function showFailed(api) {
    view.replaceChildren();
    view.appendChild(el('h1', null, 'GratisGIS could not start'));
    var hint = hintFor(api.log);
    if (hint) { view.appendChild(el('p', { 'class': 'bad' }, hint)); }
    view.appendChild(el('p', null, 'GratisGIS tries again by itself, and this page will update if that works.'));
    view.appendChild(el('p', null, 'If this page stays here, copy the details below and send them to whoever helps you with GratisGIS, or report them on GitHub.'));
    var box = failureDetails(api.log, 'Show the details');
    box.open = true;
    view.appendChild(box);
  }

  function showSlow(since) {
    var box = el('div');
    box.appendChild(el('p', null, 'This is taking longer than usual. If the computer is busy or the database is large, give it a few more minutes.'));
    box.appendChild(el('p', null, 'If nothing changes after 15 minutes, restart the GratisGIS app (in TrueNAS: Apps, then GratisGIS, then Restart; in Dockge: Restart). Your maps and data stay where they are.'));
    showWorking('Still starting', '', since, box);
  }

  function showAddress(boot) {
    var url = window.location.origin;
    view.replaceChildren();
    view.appendChild(el('h1', null, 'One question before setup'));
    view.appendChild(el('p', null, 'Is this the address you will use to open GratisGIS?'));
    view.appendChild(el('code', { 'class': 'address' }, url));
    var local = /^(localhost|127\\.|\\[::1\\])/.test(window.location.hostname);
    if (local) {
      view.appendChild(el('p', { 'class': 'muted' }, 'This address only works on this computer. To use GratisGIS from other computers or phones, open this page from one of them, using this computer\\'s network address, and choose it there instead.'));
    } else {
      view.appendChild(el('p', { 'class': 'muted' }, 'Other computers and phones on your network will use this same address.'));
    }
    var msg = el('p', { 'class': 'bad', role: 'alert' });
    var btn = el('button', { type: 'button' }, 'Yes, use this address');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Saving';
      msg.textContent = '';
      fetch('/__gg_setup/address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) { throw new Error(body.error || 'Setup did not answer. Wait a moment and try again.'); }
          showWorking(STEPS['setting-up'][0], STEPS['setting-up'][1], null);
          timer = setTimeout(tick, 3000);
        });
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Yes, use this address';
        msg.textContent = err.message;
      });
    });
    view.appendChild(btn);
    view.appendChild(msg);
  }

  function render(boot, api) {
    if (boot.phase === 'failed') { showFailed({ log: boot.detail }); return; }
    if (boot.phase === 'setting-up') {
      showWorking(STEPS['setting-up'][0], STEPS['setting-up'][1], boot.updated);
      return;
    }
    if (api && api.phase === 'failed') { showFailed(api); return; }
    var phase = api ? api.phase : 'starting';
    var step = STEPS[phase] || STEPS.starting;
    var since = api ? api.since : boot.updated;
    var extra = null;
    var text = step[1];
    if (api && api.lastFailure) {
      text = 'The last start did not work, so GratisGIS is trying again. ' + text;
      extra = failureDetails(api.lastFailure.log, 'Why the last start failed');
    }
    // No progress for a while outside the slow database steps. A crash
    // before the portal could write any status lands here too.
    var quiet = phase !== 'database-rebuild' && phase !== 'database-update';
    if (quiet && minutesSince(api ? api.updated : boot.updated) >= 6) {
      showSlow(since);
      if (extra) { view.insertBefore(extra, view.lastChild); }
      return;
    }
    showWorking(step[0], text, since, extra);
  }

  function showAdmin() {
    view.replaceChildren();
    view.appendChild(el('h1', null, 'Choose your admin password'));
    view.appendChild(el('p', null, 'You will sign in to GratisGIS with the user name admin and this password. Write it down somewhere safe.'));
    var form = el('form');
    var label1 = el('label', { 'for': 'gg-pw' }, 'Password');
    var pw = el('input', { id: 'gg-pw', type: 'password', autocomplete: 'new-password', minlength: '10', required: 'required' });
    var label2 = el('label', { 'for': 'gg-pw2' }, 'Type it again');
    var pw2 = el('input', { id: 'gg-pw2', type: 'password', autocomplete: 'new-password', required: 'required' });
    var showRow = el('label', { 'class': 'check' });
    var show = el('input', { type: 'checkbox' });
    show.addEventListener('change', function () { pw.type = pw2.type = show.checked ? 'text' : 'password'; });
    showRow.appendChild(show);
    showRow.appendChild(document.createTextNode(' Show the password'));
    var tip = el('p', { 'class': 'muted' }, 'At least 10 characters. A short sentence works well, for example: my garden map 2026');
    var msg = el('p', { 'class': 'bad', role: 'alert' });
    var btn = el('button', { type: 'submit' }, 'Save and finish setup');
    [label1, pw, label2, pw2, showRow, tip, btn, msg].forEach(function (n) { form.appendChild(n); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      msg.textContent = '';
      if (pw.value.length < 10) { msg.textContent = 'Use at least 10 characters.'; pw.focus(); return; }
      if (pw.value !== pw2.value) { msg.textContent = 'The two passwords are not the same. Type them again.'; pw2.focus(); return; }
      btn.disabled = true;
      btn.textContent = 'Saving';
      fetch('/__gg_setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value, confirm: pw2.value })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) { throw new Error(body.error || 'Setup did not answer. Wait a moment and try again.'); }
          showWorking(STEPS['setting-up'][0], STEPS['setting-up'][1] + ' Then sign in as admin with the password you chose.', null);
          timer = setTimeout(tick, 3000);
        });
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save and finish setup';
        msg.textContent = err.message;
      });
    });
    view.appendChild(form);
    pw.focus();
  }

  var timer = null;
  function tick() {
    // When the portal answers, this request gets the real page: reload.
    fetch('/', { method: 'HEAD', cache: 'no-store', redirect: 'manual' }).then(function (r) {
      if (!r.headers.get('X-GG-Status') && (r.type === 'opaqueredirect' || r.status < 500)) {
        window.location.reload();
        return true;
      }
      return false;
    }).catch(function () { return false; }).then(function (up) {
      if (up) { return; }
      return Promise.all([getJson('/__gg_status/bootstrap.json'), getJson('/__gg_status/api.json')]).then(function (res) {
        var boot = res[0] || {};
        var api = res[1];
        if (boot.phase === 'need-address') { showAddress(boot); return; }
        if (boot.phase === 'need-admin') { showAdmin(); return; }
        render(boot, api);
        timer = setTimeout(tick, 4000);
      });
    });
  }
  tick();
})();
</script>
</body>
</html>
"""


def caddy_lan(port: str, tls: str, hosts: list[str] | None = None) -> str:
    tls_line = "\ttls internal\n" if tls == "internal" else ""
    site = f":{port}"
    host_line = " ".join(hosts or [])
    return f"""{{
	auto_https off
	admin off
}}

{site} {{
{tls_line}	encode gzip zstd
	# Import uploads go straight to storage in parts. This cap is
	# for the older multipart import path, a little above the
	# API's 50 GiB ceiling. Caddy reads GB as 10^9, so use GiB.
	request_body {{
		max_size 51GiB
	}}
{LAN_SECURITY_HEADERS}
{STATUS_ROUTES}
	# Keycloak lives under /auth on this same address. The admin
	# API and the master realm stay closed from the browser. The
	# bootstrap container talks to Keycloak on the docker network.
	# Caddy 2.10 accepts one path on `handle`. Several paths use a
	# named matcher.
	@blocked path /auth/admin /auth/admin/* /auth/realms/master /auth/realms/master/*
	handle @blocked {{
		respond 404
	}}
	# Keycloak answers only for the configured sign-in host. Another
	# host (a Tailscale name that is not GRATIS_BASE_URL yet) must
	# not be redirected to the LAN address stored at first boot.
	@auth_other_host {{
		path /auth /auth/*
		not host {host_line if host_line else "localhost"}
	}}
	handle @auth_other_host {{
		respond "Sign-in is not configured for this address. Set GRATIS_BASE_URL to the address you open, then restart. Keep the volumes." 403
	}}
	handle /auth/* {{
		reverse_proxy keycloak:8080
	}}

	# portal-api's /metrics is scraped on the docker network only.
	@metrics path /metrics /metrics/*
	handle @metrics {{
		respond 404
	}}
	handle /api/auth/* {{
		reverse_proxy portal-web:3000
	}}
	handle /api/portal/* {{
		reverse_proxy portal-web:3000
	}}
	# /api/geocode?q= is the address search. A trailing-slash wildcard
	# does not match that path, and /api/* would send it to portal-api
	# ("Cannot GET /api/geocode").
	@geocode path /api/geocode /api/geocode/*
	handle @geocode {{
		reverse_proxy portal-web:3000
	}}
	handle /api/locale {{
		reverse_proxy portal-web:3000
	}}
	handle /api/* {{
		reverse_proxy portal-api:4000
	}}
	@docs path /docs /docs/* /health
	handle @docs {{
		reverse_proxy portal-api:4000
	}}
	handle {{
		reverse_proxy portal-web:3000
	}}
}}
"""


def caddy_public(portal: str, auth: str, storage: str, email: str) -> str:
    return f"""{{
	email {email}
	admin off
}}

{portal} {{
	encode gzip zstd
	# Import uploads go straight to storage in parts. This cap is
	# for the older multipart import path, a little above the
	# API's 50 GiB ceiling. Caddy reads GB as 10^9, so use GiB.
	request_body {{
		max_size 51GiB
	}}
{STATUS_ROUTES}	# portal-api's /metrics is scraped on the docker network only.
	@metrics path /metrics /metrics/*
	handle @metrics {{
		respond 404
	}}
	handle /api/auth/* {{
		reverse_proxy portal-web:3000
	}}
	handle /api/portal/* {{
		reverse_proxy portal-web:3000
	}}
	# /api/geocode?q= is the address search. A trailing-slash wildcard
	# does not match that path, and /api/* would send it to portal-api
	# ("Cannot GET /api/geocode").
	@geocode path /api/geocode /api/geocode/*
	handle @geocode {{
		reverse_proxy portal-web:3000
	}}
	handle /api/locale {{
		reverse_proxy portal-web:3000
	}}
	handle /api/* {{
		reverse_proxy portal-api:4000
	}}
	@docs path /docs /docs/* /health
	handle @docs {{
		reverse_proxy portal-api:4000
	}}
	handle {{
		reverse_proxy portal-web:3000
	}}
	header {{
		X-Content-Type-Options nosniff
		X-Frame-Options SAMEORIGIN
		Referrer-Policy strict-origin-when-cross-origin
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		# Same as infra/Caddyfile.
		Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), midi=(), magnetometer=(), accelerometer=(), gyroscope=()"
		Cross-Origin-Opener-Policy same-origin
		-Server
	}}
}}

{auth} {{
	@blocked path /admin /admin/* /realms/master /realms/master/*
	handle @blocked {{
		respond 404
	}}
	reverse_proxy keycloak:8080
	# As infra/Caddyfile. No X-Frame-Options: the login screen is
	# sometimes framed during account linking.
	header {{
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		-Server
	}}
}}

{storage} {{
	reverse_proxy minio:9000
	header {{
		X-Content-Type-Options nosniff
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		-Server
	}}
}}
"""


class NeedAddress(Exception):
    def __init__(self, port: str) -> None:
        self.port = port


def resolve_urls(previous: dict[str, str] | None) -> dict[str, str]:
    mode = os.environ.get("GRATIS_MODE", "lan").strip().lower() or "lan"
    port = os.environ.get("GRATIS_HTTP_PORT", "8080").strip() or "8080"
    s3_port = os.environ.get("GRATIS_S3_PORT", "8900").strip() or "8900"
    tls = os.environ.get("GRATIS_TLS", "").strip().lower()
    requested = os.environ.get("GRATIS_BASE_URL", "").strip().rstrip("/")
    s3_requested = os.environ.get("GRATIS_S3_URL", "").strip().rstrip("/")

    if mode == "public":
        if not requested:
            raise SystemExit("GRATIS_MODE=public needs GRATIS_BASE_URL=https://your.domain")
        parsed = urllib.parse.urlparse(requested)
        host = parsed.hostname or ""
        if not host or "." not in host:
            raise SystemExit("GRATIS_BASE_URL must be a full https URL with a domain name")
        scheme = "https"
        public = f"{scheme}://{host}"
        # `or`, not a get() default: Compose passes both keys as empty
        # strings when the operator did not set them, and get() only
        # falls back when the key is missing. That gave "https://".
        auth_host = os.environ.get("GRATIS_AUTH_DOMAIN", "").strip() or f"auth.{host}"
        storage_host = os.environ.get("GRATIS_STORAGE_DOMAIN", "").strip() or f"storage.{host}"
        auth = f"https://{auth_host}"
        s3 = s3_requested or f"https://{storage_host}"
        return {"mode": "public", "public": public, "auth": auth, "s3": s3, "tls": "acme"}

    scheme = "https" if tls == "internal" else "http"
    if requested:
        public = requested
    else:
        host = ""
        if previous:
            prev = urllib.parse.urlparse(previous.get("PUBLIC_URL", ""))
            prev_host = prev.hostname or ""
            if prev_host and not saved_host_is_bad(prev_host):
                host = prev_host
                if not tls and previous.get("GRATIS_TLS") == "internal":
                    # Carry the whole setting: an https address with a
                    # plain-HTTP Caddy (tls left empty) broke sign-in
                    # for one boot and then flipped to http.
                    scheme = "https"
                    tls = "internal"
        if not host:
            detected = detect_lan_ip()
            if not detected:
                raise NeedAddress(port)
            host = detected
        public = f"{scheme}://{host}:{port}"
    parsed = urllib.parse.urlparse(public)
    host = parsed.hostname or ""
    if not host:
        raise NeedAddress(port)
    if s3_requested:
        s3 = s3_requested
    else:
        s3_scheme = parsed.scheme or scheme
        s3 = f"{s3_scheme}://{host}:{s3_port}"
        if s3_scheme == "https":
            # The upload port is MinIO's own plain HTTP listener. With an
            # https portal address (Tailscale Serve, GRATIS_TLS=internal)
            # nothing terminates TLS on it, so browser uploads fail.
            print(
                f"WARN: uploads will go to {s3}, but port {s3_port} serves plain HTTP. "
                "Set GRATIS_S3_URL to an https address that forwards to it "
                "(for example a second Tailscale Serve listener on another port, such as 8443). "
                "See docs/truenas.md.",
                flush=True,
            )
    auth = public.rstrip("/") + "/auth"
    return {"mode": "lan", "public": public, "auth": auth, "s3": s3, "tls": tls}


def analysis_enabled() -> bool:
    """GRATIS_ANALYSIS=on is the default. off skips lidar processing."""
    raw = os.environ.get("GRATIS_ANALYSIS", "on").strip().lower() or "on"
    return raw != "off"


def image_channel() -> str:
    """edge, latest, or a stable vX.Y.Z tag. Anything else is edge."""
    tag = os.environ.get("GG_IMAGE_TAG", "edge").strip() or "edge"
    if tag == "latest" or re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        return tag
    return "edge"


def fresh_secrets() -> dict[str, str]:
    return {
        "POSTGRES_PASSWORD": rand(),
        "KEYCLOAK_DB_PASSWORD": rand(),
        "MINIO_ROOT_PASSWORD": rand(),
        "KEYCLOAK_ADMIN_PASSWORD": rand(),
        "KEYCLOAK_ADMIN_CLIENT_SECRET": rand(),
        "NEXTAUTH_SECRET": rand(),
        "CHROMIUM_TOKEN": rand(),
        "INITIAL_USER_PASSWORD": rand(16),
        "CREDENTIAL_ENCRYPTION_KEY": encryption_key(),
    }


def assemble(urls: dict[str, str], secret: dict[str, str]) -> dict[str, str]:
    public = urls["public"]
    auth = urls["auth"]
    s3 = urls["s3"]
    parsed_public = urllib.parse.urlparse(public)
    origin = f"{parsed_public.scheme}://{parsed_public.netloc}"
    db_pass = secret["POSTGRES_PASSWORD"]
    kc_db = secret["KEYCLOAK_DB_PASSWORD"]
    minio_pass = secret["MINIO_ROOT_PASSWORD"]
    token = secret["CHROMIUM_TOKEN"]
    email = os.environ.get("GRATIS_ACME_EMAIL", "").strip() or "admin@gratis.lan"
    relative = "/auth" if urls["mode"] == "lan" else ""
    internal_auth = "http://keycloak:8080" + relative
    values = {
        "GRATIS_MODE": urls["mode"],
        "GRATIS_TLS": urls.get("tls") or "",
        "PUBLIC_URL": public,
        "NEXTAUTH_URL": public,
        "NEXTAUTH_SECRET": secret["NEXTAUTH_SECRET"],
        "KEYCLOAK_URL": auth,
        "KEYCLOAK_INTERNAL_URL": internal_auth,
        "KEYCLOAK_REALM": "gratis-gis",
        "KEYCLOAK_ISSUER": f"{auth}/realms/gratis-gis",
        "KEYCLOAK_CLIENT_ID_WEB": "portal-web",
        "KEYCLOAK_CLIENT_SECRET_WEB": "",
        "KEYCLOAK_ADMIN_CLIENT_ID": "portal-api-admin",
        "KEYCLOAK_ADMIN_CLIENT_SECRET": secret["KEYCLOAK_ADMIN_CLIENT_SECRET"],
        "KEYCLOAK_ADMIN": "admin",
        "KEYCLOAK_ADMIN_PASSWORD": secret["KEYCLOAK_ADMIN_PASSWORD"],
        "POSTGRES_DB": "gratisgis",
        "POSTGRES_USER": "gratisgis",
        "POSTGRES_PASSWORD": db_pass,
        "KEYCLOAK_DB_PASSWORD": kc_db,
        "DATABASE_URL": f"postgresql://gratisgis:{db_pass}@postgres:5432/gratisgis",
        "KC_DB": "postgres",
        "KC_DB_URL": "jdbc:postgresql://postgres:5432/keycloak",
        "KC_DB_USERNAME": "keycloak",
        "KC_DB_PASSWORD": kc_db,
        # LAN: hostname is the site origin; /auth is the relative path.
        # Public: Keycloak has its own hostname and no path prefix.
        "KC_HOSTNAME": origin if urls["mode"] == "lan" else auth,
        "KC_HTTP_ENABLED": "true",
        "KC_HOSTNAME_STRICT": "false",
        "KC_PROXY_HEADERS": "xforwarded",
        "KC_BOOTSTRAP_ADMIN_USERNAME": "admin",
        "KC_BOOTSTRAP_ADMIN_PASSWORD": secret["KEYCLOAK_ADMIN_PASSWORD"],
        "KC_HEALTH_ENABLED": "true",
        "MINIO_ROOT_USER": "gratisgis",
        "MINIO_ROOT_PASSWORD": minio_pass,
        # Browser uploads hit the upload port from the web port.
        # Silo reads this when the NAS service sources /boot/env.
        "MINIO_API_CORS_ALLOW_ORIGIN": public,
        "MINIO_ENDPOINT": "http://minio:9000",
        "MINIO_PUBLIC_BASE": s3,
        "MINIO_ACCESS_KEY": "gratisgis",
        "MINIO_SECRET_KEY": minio_pass,
        "MINIO_BUCKET": "gratisgis",
        "S3_BUCKET": "gratisgis",
        # The point-cloud worker reads these four names. They match
        # the portal's own MinIO settings above.
        "ANALYSIS_TIERS": "server-heavy" if analysis_enabled() else "",
        "BACKUP_DIR": "/app/backups",
        "STORAGE_ALLOWED_ORIGINS": public,
        "CREDENTIAL_ENCRYPTION_KEY": secret["CREDENTIAL_ENCRYPTION_KEY"],
        "INITIAL_USER_PASSWORD": secret["INITIAL_USER_PASSWORD"],
        "DEFAULT_ORG_SLUG": "gratis-gis",
        "ACME_EMAIL": email,
        "CHROMIUM_TOKEN": token,
        "CHROMIUM_WS_ENDPOINTS": f"ws://chromium:3000?token={token}",
        "PORTAL_API_URL": "http://portal-api:4000",
        # Links in notification and feedback email. The code default
        # is http://localhost:3000.
        "PORTAL_BASE_URL": public,
        "NEXT_PUBLIC_API_URL": public,
        "NODE_ENV": "production",
        "PORT": "4000",
        # The image bakes GG_VERSION and GIT_SHA. Do not override them
        # with the pull tag. GG_CHANNEL is the update track.
        "GG_CHANNEL": image_channel(),
        "GRATIS_COMPOSE_REV": os.environ.get("GRATIS_COMPOSE_REV", "1").strip() or "1",
        "INSTALL_TYPE": "nas",
        "UPDATE_CHECK": os.environ.get("UPDATE_CHECK", "on").strip() or "on",
    }
    if relative:
        values["KC_HTTP_RELATIVE_PATH"] = relative
    secret_keys = (
        "POSTGRES_PASSWORD",
        "KEYCLOAK_DB_PASSWORD",
        "MINIO_ROOT_PASSWORD",
        "MINIO_SECRET_KEY",
        "KEYCLOAK_ADMIN_PASSWORD",
        "KEYCLOAK_ADMIN_CLIENT_SECRET",
        "KC_BOOTSTRAP_ADMIN_PASSWORD",
        "NEXTAUTH_SECRET",
        "CHROMIUM_TOKEN",
        "INITIAL_USER_PASSWORD",
        "CREDENTIAL_ENCRYPTION_KEY",
    )
    for key in secret_keys:
        if values[key] in WEAK or (key != "CREDENTIAL_ENCRYPTION_KEY" and len(values[key]) < 16):
            raise SystemExit(f"refusing weak value for {key}")
    return values


def ensure_org_attributes(schema: dict) -> bool:
    attributes = schema.setdefault("attributes", [])
    names = {item.get("name") for item in attributes if isinstance(item, dict)}
    changed = False
    specs = [
        ("org", "Organization"),
        ("org_role", "Org role"),
    ]
    for name, label in specs:
        if name in names:
            continue
        attributes.append(
            {
                "name": name,
                "displayName": label,
                "permissions": {"view": ["admin", "user"], "edit": ["admin"]},
                "multivalued": False,
            }
        )
        changed = True
    return changed


def _request(url: str, method: str, body: bytes | None, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def grant_service_account_roles(internal: str, auth: dict[str, str]) -> None:
    """Give portal-api-admin the roles the Users page and sign-in settings need.

    Realm import grants them on a first boot. An install that already
    imported the realm, including one that is only restarted, does not
    import again, so this runs on every start and is safe to repeat.
    """
    status, raw = _request(
        f"{internal}/admin/realms/gratis-gis/clients?clientId=realm-management",
        "GET",
        None,
        auth,
    )
    if status != 200:
        print(f"WARN: could not find realm-management (HTTP {status}).")
        return
    found = json.loads(raw)
    if not found:
        print("WARN: realm-management client is missing.")
        return
    realm_mgmt = found[0]["id"]
    roles = []
    for name in ADMIN_CLIENT_ROLES:
        status, raw = _request(
            f"{internal}/admin/realms/gratis-gis/clients/{realm_mgmt}/roles/{name}",
            "GET",
            None,
            auth,
        )
        if status != 200:
            print(f"WARN: realm-management role {name} is missing (HTTP {status}).")
            continue
        role = json.loads(raw)
        roles.append({"id": role["id"], "name": role["name"]})
    if not roles:
        return
    status, raw = _request(
        f"{internal}/admin/realms/gratis-gis/clients?clientId=portal-api-admin",
        "GET",
        None,
        auth,
    )
    clients = json.loads(raw) if status == 200 else []
    if not clients:
        print(f"WARN: portal-api-admin client is missing (HTTP {status}).")
        return
    status, raw = _request(
        f"{internal}/admin/realms/gratis-gis/clients/{clients[0]['id']}/service-account-user",
        "GET",
        None,
        auth,
    )
    if status != 200:
        print(f"WARN: could not read the admin service account (HTTP {status}).")
        return
    sa_id = json.loads(raw)["id"]
    status, _ = _request(
        f"{internal}/admin/realms/gratis-gis/users/{sa_id}/role-mappings/clients/{realm_mgmt}",
        "POST",
        json.dumps(roles).encode(),
        {**auth, "Content-Type": "application/json"},
    )
    if status not in (200, 204):
        print(f"WARN: could not grant realm-management roles (HTTP {status}).", flush=True)
        return
    print("Keycloak admin service account can list and manage users.", flush=True)


def ensure_default_offline_access(internal: str, auth: dict[str, str]) -> None:
    """Make offline_access part of the realm's default role.

    The realm names `viewer` as its default role, and viewer does not
    carry offline_access. Every user created after the import then
    failed field-app and QGIS sign-in with "Offline tokens not allowed
    for the user or client". A composite on the default role covers
    every user who holds it. Runs on every start and is safe to repeat.
    """
    base = f"{internal}/admin/realms/gratis-gis"
    status, raw = _request(base, "GET", None, auth)
    if status != 200:
        print(f"WARN: could not read the gratis-gis realm (HTTP {status}).")
        return
    default_role = (json.loads(raw).get("defaultRole") or {}).get("id")
    if not default_role:
        print("WARN: the gratis-gis realm has no default role.")
        return
    status, raw = _request(f"{base}/roles-by-id/{default_role}/composites/realm", "GET", None, auth)
    if status != 200:
        print(f"WARN: could not read the default role (HTTP {status}).")
        return
    if any(role.get("name") == "offline_access" for role in json.loads(raw)):
        return
    status, raw = _request(f"{base}/roles/offline_access", "GET", None, auth)
    if status != 200:
        print(f"WARN: the offline_access role is missing (HTTP {status}).")
        return
    role = json.loads(raw)
    status, _ = _request(
        f"{base}/roles-by-id/{default_role}/composites",
        "POST",
        json.dumps([{"id": role["id"], "name": role["name"]}]).encode(),
        {**auth, "Content-Type": "application/json"},
    )
    if status not in (200, 204):
        print(f"WARN: could not add offline_access to the default role (HTTP {status}).")
        return
    print("New users can sign in to the field app and QGIS (offline_access).", flush=True)


def sync_sign_in_address(internal: str, auth: dict[str, str], values: dict[str, str]) -> None:
    """Rewrite the imported realm when the public URL changes.

    `--import-realm` does not update a realm that already exists, so a
    later GRATIS_BASE_URL used to leave Keycloak sending browsers to
    the first LAN address unless the volumes were deleted.
    """
    origins = sign_in_origins(values)
    if not origins:
        return
    headers = {**auth, "Content-Type": "application/json"}
    status, raw = _request(f"{internal}/admin/realms/gratis-gis", "GET", None, auth)
    if status != 200:
        print(f"WARN: could not read the gratis-gis realm (HTTP {status}).")
        return
    realm = apply_sign_in_realm(json.loads(raw), values["KEYCLOAK_URL"], origins)
    status, _ = _request(
        f"{internal}/admin/realms/gratis-gis",
        "PUT",
        json.dumps(realm).encode(),
        headers,
    )
    if status not in (200, 204):
        print(f"WARN: could not update the realm sign-in address (HTTP {status}).")
        return
    status, raw = _request(
        f"{internal}/admin/realms/gratis-gis/clients?clientId=portal-web",
        "GET",
        None,
        auth,
    )
    clients = json.loads(raw) if status == 200 else []
    if not clients:
        print(f"WARN: portal-web client is missing (HTTP {status}).")
        return
    client = apply_sign_in_client(clients[0], origins)
    status, _ = _request(
        f"{internal}/admin/realms/gratis-gis/clients/{client['id']}",
        "PUT",
        json.dumps(client).encode(),
        headers,
    )
    if status not in (200, 204):
        print(f"WARN: could not update portal-web redirect URIs (HTTP {status}).")
        return
    print(f"Keycloak sign-in address is {origins[0]}.", flush=True)


def patch_keycloak(values: dict[str, str]) -> None:
    internal = values["KEYCLOAK_INTERNAL_URL"].rstrip("/")
    # KC_HTTP_RELATIVE_PATH is /auth. Keycloak 26 serves health on the
    # management port under that same prefix, not at /health/ready.
    relative = (values.get("KC_HTTP_RELATIVE_PATH") or "").rstrip("/")
    if relative and not relative.startswith("/"):
        relative = "/" + relative
    health_url = f"http://keycloak:9000{relative}/health/ready"
    deadline = time.time() + 180
    ready = False
    while time.time() < deadline:
        try:
            status, _ = _request(health_url, "GET", None, {})
            if status == 200:
                ready = True
                break
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(3)
    if not ready:
        print("WARN: Keycloak did not become ready. Sign-in may fail until the next restart.")
        return
    form = urllib.parse.urlencode(
        {
            "client_id": "admin-cli",
            "username": "admin",
            "password": values["KEYCLOAK_ADMIN_PASSWORD"],
            "grant_type": "password",
        }
    ).encode()
    status, raw = _request(
        f"{internal}/realms/master/protocol/openid-connect/token",
        "POST",
        form,
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if status != 200:
        print(f"WARN: could not sign in to Keycloak admin API (HTTP {status}).")
        return
    token = json.loads(raw).get("access_token") or ""
    auth = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    grant_service_account_roles(internal, auth)
    ensure_default_offline_access(internal, auth)
    sync_sign_in_address(internal, auth, values)
    status, raw = _request(f"{internal}/admin/realms/gratis-gis/users/profile", "GET", None, auth)
    if status != 200:
        print(f"WARN: could not read the user-profile schema (HTTP {status}).")
        return
    schema = json.loads(raw)
    if ensure_org_attributes(schema):
        body = json.dumps(schema).encode()
        put_headers = {**auth, "Content-Type": "application/json"}
        status, _ = _request(
            f"{internal}/admin/realms/gratis-gis/users/profile",
            "PUT",
            body,
            put_headers,
        )
        if status not in (200, 204):
            print(f"WARN: could not update the user-profile schema (HTTP {status}).")
            return
        print("Keycloak user-profile schema now includes org and org_role.")
    # The realm import may have dropped those attributes. Put them back
    # on the admin user so the first sign-in has an org claim.
    status, raw = _request(
        f"{internal}/admin/realms/gratis-gis/users?username=admin&exact=true",
        "GET",
        None,
        auth,
    )
    if status != 200:
        return
    users = json.loads(raw)
    if not users:
        return
    user = users[0]
    attrs = user.get("attributes") or {}
    # Only when the import dropped them, as restore-golden.sh does. An
    # operator who demoted `admin` or moved it to another org must not
    # see that undone on every restart.
    if attrs.get("org"):
        return
    attrs["org"] = ["gratis-gis"]
    attrs["org_role"] = ["admin"]
    user["attributes"] = attrs
    _request(
        f"{internal}/admin/realms/gratis-gis/users/{user['id']}",
        "PUT",
        json.dumps(user).encode(),
        {**auth, "Content-Type": "application/json"},
    )


def _url_port(url: str, default: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.port:
        return str(parsed.port)
    return default


def banner(values: dict[str, str], *, reveal_password: bool) -> str:
    http_port = _url_port(values["PUBLIC_URL"], "8080")
    s3_port = _url_port(values["MINIO_PUBLIC_BASE"], "8900")
    if reveal_password:
        password = (
            f"Password:           {values['INITIAL_USER_PASSWORD']}\n"
            "Keycloak will ask you to change this password.\n"
            "This password is printed only on the first start. Copy it\n"
            "now and change it at first sign-in, before you share this\n"
            "log. Do not post it publicly.\n"
        )
    else:
        password = (
            "The first-start admin password is not printed again.\n"
            "Sign in with the password you chose. If you forgot it, reset\n"
            "that user from the host. The steps are in docs/truenas.md\n"
            "and infra/reset-portal-password.sh. Do not delete this app's\n"
            "volumes to get a new password. That erases the database and\n"
            "the uploaded files.\n"
        )
    return (
        "\n========== GratisGIS ==========\n"
        f"Open this address:  {values['PUBLIC_URL']}\n"
        "Sign-in uses this address. Another name, such as a Tailscale\n"
        "hostname, needs GRATIS_BASE_URL set to that name. Restart\n"
        "and keep the volumes. Keycloak is updated in place.\n"
        "User:               admin\n"
        f"{password}"
        "Uploads use:        "
        f"{values['MINIO_PUBLIC_BASE']}\n"
        f"Do not forward ports {http_port} or {s3_port} on your router.\n"
        "===============================\n"
    )


def address_help(port: str) -> str:
    return (
        "\n========== GratisGIS ==========\n"
        "Could not find a LAN address that opens from another computer.\n"
        "Network addresses, broadcast addresses, and Docker or TrueNAS\n"
        "bridge addresses are skipped.\n"
        "\n"
        "Set GRATIS_BASE_URL in the compose file to the address you open\n"
        "in a browser, then start this app again. Example:\n"
        f"\n    GRATIS_BASE_URL: http://192.168.1.20:{port}\n"
        "\n"
        "When port 8080 is already in use, change GRATIS_HTTP_PORT at the\n"
        "top of the file and use that same port in GRATIS_BASE_URL.\n"
        "\n"
        "The first-start admin password is printed once, only when\n"
        "startup succeeds on an empty volume.\n"
        "Do not post it publicly.\n"
        "===============================\n"
    )


def _pause_or_return() -> None:
    if os.environ.get("GRATIS_SKIP_PATCH") == "1":
        return
    os.execvp("sleep", ["sleep", "infinity"])


def main() -> None:
    boot = boot_dir()
    boot.mkdir(parents=True, exist_ok=True)
    ready = boot / "ready"
    # Hold every other service until this process has an address.
    # A previous boot may have published a bridge address.
    if ready.exists():
        ready.unlink()
    env_path = boot / "env"
    previous = read_env(env_path) if env_path.exists() else None
    # The status page goes up first, so Caddy has something to show
    # from the very first second (see STATUS_PAGE_HTML).
    ensure_status_dir()
    write_status_page(boot)
    write_boot_status("setting-up" if previous is None else "starting")
    # An address chosen on the status page counts as GRATIS_BASE_URL.
    # A GRATIS_BASE_URL set in the compose file still wins.
    saved_address = boot / "base-url"
    if not os.environ.get("GRATIS_BASE_URL", "").strip() and saved_address.exists():
        os.environ["GRATIS_BASE_URL"] = saved_address.read_text(encoding="utf-8").strip()
    if previous:
        secret = {key: previous[key] for key in (
            "POSTGRES_PASSWORD",
            "KEYCLOAK_DB_PASSWORD",
            "MINIO_ROOT_PASSWORD",
            "KEYCLOAK_ADMIN_PASSWORD",
            "KEYCLOAK_ADMIN_CLIENT_SECRET",
            "NEXTAUTH_SECRET",
            "CHROMIUM_TOKEN",
            "INITIAL_USER_PASSWORD",
            "CREDENTIAL_ENCRYPTION_KEY",
        )}
    else:
        secret = fresh_secrets()
    # An explicit GRATIS_BASE_URL always wins, including on a restart.
    # A stored network or bridge address does not.
    prior = None if os.environ.get("GRATIS_BASE_URL", "").strip() else previous
    try:
        urls = resolve_urls(prior)
    except NeedAddress as exc:
        if os.environ.get("GRATIS_SKIP_PATCH") == "1":
            print(address_help(exc.port), flush=True)
            return
        # Ask on the status page instead of in the compose file.
        chosen = ask_address_in_browser(exc.port)
        saved_address.write_text(chosen + "\n", encoding="utf-8")
        saved_address.chmod(0o644)
        os.environ["GRATIS_BASE_URL"] = chosen
        write_boot_status("setting-up" if previous is None else "starting")
        urls = resolve_urls(None)
    values = assemble(urls, secret)
    # First start only: let the person choose the admin password on the
    # status page instead of copying a random one out of a log.
    chosen_password = ""
    if previous is None and wants_setup_questions(values):
        chosen_password = ask_admin_password_in_browser()
        write_boot_status("setting-up")
    write_env(env_path, values)
    write_service_envs(boot, values)
    realm = build_realm(values)
    realm_path = boot / "realm-gratis-gis.json"
    realm_path.write_text(json.dumps(realm, indent=2) + "\n", encoding="utf-8")
    realm_path.chmod(0o644)
    if values["GRATIS_MODE"] == "public":
        host = urllib.parse.urlparse(values["PUBLIC_URL"]).hostname or ""
        auth_host = urllib.parse.urlparse(values["KEYCLOAK_URL"]).hostname or ""
        storage_host = urllib.parse.urlparse(values["MINIO_PUBLIC_BASE"]).hostname or ""
        caddy = caddy_public(host, auth_host, storage_host, values["ACME_EMAIL"])
    else:
        # Caddy always listens on 8080 inside the container. The
        # published host port is GRATIS_HTTP_PORT (mapped to 8080).
        caddy = caddy_lan(
            "8080",
            values.get("GRATIS_TLS") or "",
            caddy_auth_hosts(sign_in_origins(values)),
        )
    caddy_path = boot / "Caddyfile"
    caddy_path.write_text(caddy, encoding="utf-8")
    caddy_path.chmod(0o644)
    first_boot = previous is None
    text = banner(values, reveal_password=first_boot and not chosen_password)
    if chosen_password:
        text += "Admin password: the one chosen on the setup page.\n"
    if previous and previous.get("PUBLIC_URL") not in (None, values["PUBLIC_URL"]):
        text += (
            "WARN: the sign-in address changed after the first start.\n"
            "WARN: Keycloak is updated in place. Keep the volumes.\n"
            "WARN: Open the new address and sign in again.\n"
        )
    # Older installs wrote the admin password to LOGIN.txt on this
    # volume, which every container can read. Remove it. The password
    # is not written again.
    login_txt = boot / "LOGIN.txt"
    if login_txt.exists():
        login_txt.unlink()
    # ready is last so Keycloak and Silo never read a half-written boot.
    # It carries this boot's stamp: every service waits for a marker
    # that matches its own GRATIS_BOOT_STAMP, so a marker left by an
    # older version or other settings does not let it start early.
    # Written to a temp name and renamed so a reader never sees half.
    stamp = os.environ.get("GRATIS_BOOT_STAMP", "").strip() or "ok"
    tmp_ready = boot / "ready.tmp"
    tmp_ready.write_text(stamp + "\n", encoding="utf-8")
    os.replace(tmp_ready, ready)
    write_boot_status("ready")
    print(text, flush=True)
    if os.environ.get("GRATIS_SKIP_PATCH") == "1":
        return
    try:
        patch_keycloak(values)
    except Exception as exc:  # noqa: BLE001 - keep the stack up
        print(f"WARN: Keycloak setup did not finish: {exc}")
    if chosen_password:
        if set_admin_password(values, chosen_password):
            print("The admin password chosen on the setup page is set.", flush=True)
        else:
            # Fall back to the first-start password so nobody is locked out.
            print(
                "WARN: could not set the admin password chosen on the setup page.\n"
                "WARN: Sign in with this first-start password instead:\n"
                f"Password:           {values['INITIAL_USER_PASSWORD']}\n",
                flush=True,
            )
        chosen_password = ""
    # Stay up so TrueNAS shows this container as running and the
    # password remains in `docker logs`.
    _pause_or_return()


def run() -> None:
    """main(), with any failure shown on the status page too."""
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (None, 0):
            write_boot_status("failed", detail=str(exc.code))
        raise
    except Exception as exc:  # noqa: BLE001 - shown, then re-raised
        write_boot_status("failed", detail=f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    run()
