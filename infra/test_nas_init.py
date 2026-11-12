# SPDX-License-Identifier: AGPL-3.0-or-later
"""Checks for the NAS bootstrap script that do not need Docker.

Run with: python3 -m unittest infra/test_nas_init.py
"""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


def load():
    path = Path(__file__).with_name("nas-init.py")
    spec = importlib.util.spec_from_file_location("nas_init", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NasInitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load()

    def test_password_is_printed_only_on_first_boot(self):
        values = {
            "PUBLIC_URL": "http://192.168.1.20:8080",
            "MINIO_PUBLIC_BASE": "http://192.168.1.20:8900",
            "INITIAL_USER_PASSWORD": "first-secret-value",
        }
        first = self.mod.banner(values, reveal_password=True)
        again = self.mod.banner(values, reveal_password=False)
        self.assertIn("first-secret-value", first)
        self.assertNotIn("first-secret-value", again)
        self.assertNotIn("volumes to generate a new one", again)
        self.assertIn("reset-portal-password.sh", again)
        self.assertIn("erases the database", again)

    def test_lan_caddy_has_security_headers_and_no_hsts(self):
        caddy = self.mod.caddy_lan("8080", "")
        self.assertIn("X-Content-Type-Options nosniff", caddy)
        self.assertIn("X-Frame-Options SAMEORIGIN", caddy)
        self.assertNotIn("Strict-Transport-Security", caddy)
        self.assertIn("auto_https off", caddy)
        self.assertIn("/auth/realms/master", caddy)
        self.assertIn("path /api/geocode /api/geocode/*", caddy)
        self.assertNotIn("handle /api/geocode/*", caddy)

    def test_sign_in_client_follows_the_current_address(self):
        old = {
            "clientId": "portal-web",
            "id": "abc",
            "redirectUris": ["http://192.168.1.20:8080/*"],
            "webOrigins": ["http://192.168.1.20:8080"],
            "attributes": {
                "pkce.code.challenge.method": "S256",
                "post.logout.redirect.uris": "http://192.168.1.20:8080/*",
            },
        }
        updated = self.mod.apply_sign_in_client(
            old, ["https://mynas.tail1234.ts.net"]
        )
        self.assertEqual(updated["id"], "abc")
        self.assertEqual(
            updated["redirectUris"], ["https://mynas.tail1234.ts.net/*"]
        )
        self.assertEqual(updated["webOrigins"], ["https://mynas.tail1234.ts.net"])
        self.assertEqual(
            updated["attributes"]["post.logout.redirect.uris"],
            "https://mynas.tail1234.ts.net/*",
        )

    def test_realm_frontend_url_tracks_one_sign_in_address(self):
        realm = {"attributes": {"frontendUrl": "http://192.168.1.20:8080/auth"}}
        updated = self.mod.apply_sign_in_realm(
            realm,
            "https://mynas.tail1234.ts.net/auth",
            ["https://mynas.tail1234.ts.net"],
        )
        self.assertEqual(updated["sslRequired"], "external")
        self.assertEqual(
            updated["attributes"]["frontendUrl"],
            "https://mynas.tail1234.ts.net/auth",
        )

    def test_lan_caddy_refuses_keycloak_on_another_host(self):
        caddy = self.mod.caddy_lan("8080", "", ["192.168.4.15"])
        self.assertIn("not host 192.168.4.15", caddy)
        self.assertIn("reverse_proxy keycloak:8080", caddy)
        self.assertIn("GRATIS_BASE_URL", caddy)

    def test_public_caddy_pins_https(self):
        caddy = self.mod.caddy_public(
            "gis.example.org",
            "auth.gis.example.org",
            "storage.gis.example.org",
            "ops@example.org",
        )
        self.assertIn("Strict-Transport-Security", caddy)
        self.assertIn("/realms/master", caddy)
        self.assertIn("path /api/geocode /api/geocode/*", caddy)



class ResolveUrlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load()

    def test_public_defaults_apply_when_compose_passes_empty_domains(self):
        import os
        from unittest import mock

        env = {
            "GRATIS_MODE": "public",
            "GRATIS_BASE_URL": "https://gis.example.org",
            # What Compose passes for ${GRATIS_AUTH_DOMAIN:-} when unset.
            "GRATIS_AUTH_DOMAIN": "",
            "GRATIS_STORAGE_DOMAIN": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            urls = self.mod.resolve_urls(None)
        self.assertEqual(urls["auth"], "https://auth.gis.example.org")
        self.assertEqual(urls["s3"], "https://storage.gis.example.org")


if __name__ == "__main__":
    unittest.main()


class DefaultOfflineAccessTests(unittest.TestCase):
    """New users need offline_access for the field app and QGIS."""

    def fake(self, composites):
        calls = []
        base = "http://kc/admin/realms/gratis-gis"

        def request(url, method, body, headers):
            calls.append((method, url, body))
            if method == "GET" and url == base:
                return 200, b'{"defaultRole": {"id": "dr-1", "name": "viewer"}}'
            if method == "GET" and url == f"{base}/roles-by-id/dr-1/composites/realm":
                return 200, json.dumps(composites).encode()
            if method == "GET" and url == f"{base}/roles/offline_access":
                return 200, b'{"id": "oa-1", "name": "offline_access"}'
            if method == "POST" and url == f"{base}/roles-by-id/dr-1/composites":
                return 204, b""
            return 404, b""

        return calls, request

    def run_with(self, composites):
        mod = load()
        calls, request = self.fake(composites)
        mod._request = request
        mod.ensure_default_offline_access("http://kc", {"Authorization": "Bearer t"})
        return [(m, u, b) for (m, u, b) in calls if m == "POST"]

    def test_adds_offline_access_to_the_default_role(self):
        posts = self.run_with([])
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0][1].endswith("/roles-by-id/dr-1/composites"))
        self.assertEqual(json.loads(posts[0][2]), [{"id": "oa-1", "name": "offline_access"}])

    def test_leaves_a_default_role_that_already_has_it(self):
        self.assertEqual(self.run_with([{"name": "offline_access"}]), [])

    def test_patch_keycloak_calls_it(self):
        source = Path(__file__).with_name("nas-init.py").read_text()
        body = source.split("def patch_keycloak", 1)[1]
        self.assertIn("ensure_default_offline_access(internal, auth)", body)


class UserProfileFilterTests(unittest.TestCase):
    """deploy.sh pipes the Keycloak user-profile schema through --filter."""

    def run_filter(self, schema):
        import subprocess
        import sys

        script = Path(__file__).with_name("keycloak") / "patch-user-profile-via-docker.py"
        return subprocess.run(
            [sys.executable, str(script), "--filter"],
            input=json.dumps(schema),
            capture_output=True,
            text=True,
            check=False,
        )

    def test_adds_org_and_org_role(self):
        result = self.run_filter({"attributes": [{"name": "username"}]})
        self.assertEqual(result.returncode, 0, result.stderr)
        names = [a["name"] for a in json.loads(result.stdout)["attributes"]]
        self.assertEqual(names, ["username", "org", "org_role"])

    def test_reports_nothing_to_do(self):
        result = self.run_filter({"attributes": [{"name": "org"}, {"name": "org_role"}]})
        self.assertEqual(result.returncode, 3)

    def test_deploy_and_restore_patch_the_schema(self):
        for name in ("deploy.sh", "restore-golden.sh"):
            text = Path(__file__).with_name(name).read_text()
            self.assertIn("patch-user-profile-via-docker.py --filter", text, name)
            self.assertIn("--rname \"$GG_DEFAULT_ROLE\" --rolename offline_access", text, name)
            self.assertNotIn('--password "$KEYCLOAK_ADMIN_PASSWORD"', text, name)
