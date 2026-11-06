# SPDX-License-Identifier: AGPL-3.0-or-later
"""The dev compose file publishes ports on loopback only.

Run with: python3 -m unittest infra/test_dev_compose_bind.py
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


PORT = re.compile(r'^\s*-\s+"([^"]+)"')


class DevComposeBindTests(unittest.TestCase):
    def test_published_ports_are_loopback(self):
        text = Path(__file__).with_name("docker-compose.yml").read_text(encoding="utf-8")
        published = []
        for line in text.splitlines():
            match = PORT.match(line)
            if not match:
                continue
            value = match.group(1)
            # Image tags and comments are not port mappings. A mapping
            # has at least one colon and a trailing container port.
            if not re.search(r":\d+$", value):
                continue
            published.append(value)
            self.assertTrue(
                value.startswith("127.0.0.1:"),
                f"dev port {value} is not bound to 127.0.0.1",
            )
        self.assertGreaterEqual(len(published), 5)


if __name__ == "__main__":
    unittest.main()
