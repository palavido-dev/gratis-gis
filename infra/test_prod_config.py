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


def command_items(block: str) -> list[str]:
    """The `- item` lines of a service's `command:` list, comments dropped."""
    match = re.search(r"^    command:\n((?:      (?:- .*|#.*)\n)+)", block, re.M)
    if not match:
        raise AssertionError("no command list")
    return [line.strip()[2:] for line in match.group(1).splitlines() if line.strip().startswith("- ")]


class PitrOverlayTests(unittest.TestCase):
    """infra/docker-compose.pitr.yml repeats the postgres command."""

    PITR = (INFRA / "docker-compose.pitr.yml").read_text(encoding="utf-8")

    def overlay_postgres(self) -> str:
        match = re.search(r"^  postgres:\n(.*)", self.PITR, re.M | re.S)
        self.assertIsNotNone(match)
        return match.group(1)

    def test_overlay_keeps_every_base_flag(self):
        # Compose replaces `command` instead of merging it. A flag added
        # to the base file and not here would be silently dropped on a
        # server with continuous backups on.
        base = command_items(service_block("postgres"))
        overlay = command_items(self.overlay_postgres())
        self.assertEqual(overlay[: len(base)], base)

    def test_overlay_adds_archiving(self):
        extra = command_items(self.overlay_postgres())[len(command_items(service_block("postgres"))) :]
        self.assertIn("wal_level=replica", extra)
        self.assertIn("archive_mode=${GG_PITR_ARCHIVE_MODE:-on}", extra)
        self.assertIn("archive_command=pgbackrest --stanza=gratisgis archive-push %p", extra)
        self.assertIn("archive_timeout=60", extra)

    def test_base_file_does_not_archive(self):
        # Self-host without the overlay must not change.
        self.assertNotIn("archive_mode", uncommented(service_block("postgres")))

    def test_secrets_stay_out_of_the_repo(self):
        example = (INFRA / "pitr" / "pitr.env.example").read_text(encoding="utf-8")
        for line in example.splitlines():
            if line.startswith("PGBACKREST_"):
                self.assertTrue(line.endswith("=CHANGE_ME"), line)
        conf = uncommented((INFRA / "pitr" / "pgbackrest.conf").read_text(encoding="utf-8"))
        for word in ("cipher-pass", "s3-key", "s3-bucket", "s3-endpoint"):
            self.assertNotIn(word, conf)
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "infra/.env.pitr"], cwd=INFRA.parent, check=False
        )
        self.assertEqual(ignored.returncode, 0, "infra/.env.pitr must be git-ignored")

    def test_deploy_keeps_the_overlay(self):
        deploy = (INFRA / "deploy.sh").read_text(encoding="utf-8")
        self.assertIn("if [[ -f infra/.env.pitr ]]; then", deploy)
        self.assertIn("-f infra/docker-compose.pitr.yml", deploy)


if __name__ == "__main__":
    unittest.main()
