#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Declare org and org_role on the Keycloak user-profile schema.

Same change as patch-user-profile-schema.sh. This one uses only the
Python standard library and talks to Keycloak over the Docker bridge,
because Caddy blocks /admin and the master realm on the public name.
TrueNAS's shell often has no jq, which the shell script requires.

    KC_ADMIN_PASS='...' python3 infra/keycloak/patch-user-profile-via-docker.py

KC_URL overrides container discovery. The password is an environment
variable, never a command-line argument.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ORG_ATTRIBUTE = {
    "name": "org",
    "displayName": "Organization",
    "permissions": {"view": ["admin", "user"], "edit": ["admin"]},
    "multivalued": False,
}
ORG_ROLE_ATTRIBUTE = {
    "name": "org_role",
    "displayName": "Org role",
    "permissions": {"view": ["admin", "user"], "edit": ["admin"]},
    "multivalued": False,
}


def ensure_org_attributes(schema: dict) -> bool:
    """Add org and org_role when missing. Returns True if schema changed."""
    attributes = schema.setdefault("attributes", [])
    if not isinstance(attributes, list):
        raise SystemExit("Keycloak user-profile schema has no attributes list")
    names = {item.get("name") for item in attributes if isinstance(item, dict)}
    changed = False
    if "org" not in names:
        attributes.append(dict(ORG_ATTRIBUTE))
        changed = True
    if "org_role" not in names:
        attributes.append(dict(ORG_ROLE_ATTRIBUTE))
        changed = True
    return changed


def _keycloak_base_url() -> str:
    explicit = os.environ.get("KC_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    ids = subprocess.check_output(
        [
            "docker",
            "ps",
            "-q",
            "--filter",
            "name=gratis-gis-prod-keycloak",
        ],
        text=True,
    ).split()
    if len(ids) != 1:
        raise SystemExit(
            "expected one running container named gratis-gis-prod-keycloak, "
            f"found {len(ids)}. Start the stack first, or set KC_URL."
        )
    info = json.loads(
        subprocess.check_output(["docker", "inspect", ids[0]], text=True)
    )
    for net in info[0]["NetworkSettings"]["Networks"].values():
        ip = net.get("IPAddress") or ""
        if ip:
            return f"http://{ip}:8080"
    raise SystemExit("keycloak container has no Docker network address")


def _request(url: str, method: str, body: dict | None, token: str | None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            parsed = json.loads(raw) if raw else {}
            return resp.status, parsed
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"{method} {url} returned HTTP {exc.code}: {detail}") from exc


def main() -> None:
    password = os.environ.get("KC_ADMIN_PASS", "")
    if not password:
        raise SystemExit("KC_ADMIN_PASS is required (Keycloak admin password)")
    user = os.environ.get("KC_ADMIN_USER", "admin")
    realm = os.environ.get("KC_REALM", "gratis-gis")
    base = _keycloak_base_url()
    form = urllib.parse.urlencode(
        {
            "client_id": "admin-cli",
            "username": user,
            "password": password,
            "grant_type": "password",
        }
    ).encode()
    token_req = urllib.request.Request(
        f"{base}/realms/master/protocol/openid-connect/token",
        data=form,
        method="POST",
    )
    try:
        with urllib.request.urlopen(token_req, timeout=30) as resp:
            token = json.loads(resp.read()).get("access_token") or ""
    except urllib.error.URLError as exc:
        raise SystemExit(f"could not reach Keycloak at {base}: {exc}") from exc
    if not token:
        raise SystemExit("Keycloak did not return an admin token")
    status, schema = _request(
        f"{base}/admin/realms/{realm}/users/profile", "GET", None, token
    )
    if status != 200:
        raise SystemExit(f"reading the user-profile schema returned HTTP {status}")
    if not ensure_org_attributes(schema):
        print("user-profile schema already declares org and org_role; nothing to do.")
        return
    put_status, _ = _request(
        f"{base}/admin/realms/{realm}/users/profile", "PUT", schema, token
    )
    if put_status not in (200, 204):
        raise SystemExit(f"updating the user-profile schema returned HTTP {put_status}")
    print("user-profile schema now declares org and org_role.")


if __name__ == "__main__":
    main()
