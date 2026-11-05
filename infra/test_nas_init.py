# SPDX-License-Identifier: AGPL-3.0-or-later
"""Checks for the NAS bootstrap script that do not need Docker.

Run with: python3 -m unittest infra/test_nas_init.py
"""

from __future__ import annotations

import importlib.util
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

    def test_lan_caddy_has_security_headers_and_no_hsts(self):
        caddy = self.mod.caddy_lan("8080", "")
        self.assertIn("X-Content-Type-Options nosniff", caddy)
        self.assertIn("X-Frame-Options DENY", caddy)
        self.assertNotIn("Strict-Transport-Security", caddy)
        self.assertIn("auto_https off", caddy)
        self.assertIn("/auth/realms/master", caddy)

    def test_public_caddy_pins_https(self):
        caddy = self.mod.caddy_public(
            "gis.example.org",
            "auth.gis.example.org",
            "storage.gis.example.org",
            "ops@example.org",
        )
        self.assertIn("Strict-Transport-Security", caddy)
        self.assertIn("/realms/master", caddy)


if __name__ == "__main__":
    unittest.main()
