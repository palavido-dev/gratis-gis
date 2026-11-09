# SPDX-License-Identifier: AGPL-3.0-or-later
"""Static checks on the VPS stack that need no Docker.

Run with: python3 -m unittest infra/test_prod_config.py
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

INFRA = Path(__file__).resolve().parent
PROD = (INFRA / "docker-compose.prod.yml").read_text(encoding="utf-8")


def service_block(name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|^[A-Za-z])", PROD, re.M | re.S)
    if not match:
        raise AssertionError(f"no service {name}")
    return match.group(1)


def uncommented(text: str) -> str:
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


class ProdComposeTests(unittest.TestCase):
    def test_pg_tileserv_is_gone(self):
        # It ran unauthenticated with the database owner role, reachable
        # from the print sidecars, and nothing called it.
        self.assertNotIn("pramsey/pg_tileserv", PROD)
        self.assertNotRegex(PROD, r"(?m)^  pg_tileserv:")

    def test_executor_ip_is_outside_the_dynamic_range(self):
        net = PROD[PROD.index("  gg-script-net:"):]
        self.assertIn("subnet: 172.19.0.0/16", net)
        self.assertIn("ip_range: 172.19.128.0/17", net)
        self.assertIn("ipv4_address: 172.19.0.10", service_block("script-executor"))

    def test_app_services_drop_capabilities(self):
        for name in ("portal-migrate", "portal-api", "portal-worker", "portal-web", "pointcloud-worker"):
            block = service_block(name)
            self.assertIn("no-new-privileges:true", block, name)
            self.assertRegex(block, r"cap_drop:\n\s+- ALL", name)

    def test_chromium_is_pinned(self):
        for name in ("chromium-1", "chromium-2"):
            self.assertIn("chromium:latest@sha256:", service_block(name), name)

    def test_api_replicas_follow_the_env_file(self):
        self.assertIn("replicas: ${GG_API_REPLICAS:-2}", service_block("portal-api"))


class CaddyTests(unittest.TestCase):
    def test_trusts_no_upstream_proxy(self):
        caddy = uncommented((INFRA / "Caddyfile").read_text(encoding="utf-8"))
        self.assertNotIn("trusted_proxies", caddy)


class BootstrapTests(unittest.TestCase):
    def run_bootstrap(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(INFRA / "bootstrap.sh"), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_refuses_flags_nothing_reads(self):
        for flag in ("--pgdata", "--minio-data", "--image-tag"):
            result = self.run_bootstrap(flag, "/tmp/x")
            self.assertNotEqual(result.returncode, 0, flag)
            self.assertIn("not supported", result.stderr, flag)

    def test_writes_no_dead_keys(self):
        text = (INFRA / "bootstrap.sh").read_text(encoding="utf-8")
        for key in ("GG_PGDATA", "GG_MINIODATA", "GG_PULL_POLICY", "GG_HTTP_PORT", "GG_HTTPS_PORT", "GG_IMAGE_TAG="):
            self.assertNotIn(key, text, key)
        self.assertNotIn("https://${AUTH_DOMAIN}/admin/", text)


if __name__ == "__main__":
    unittest.main()
