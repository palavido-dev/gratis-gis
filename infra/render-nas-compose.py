#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Embed infra/nas-init.py into infra/docker-compose.nas.yml.

The pasted file has to be one document. The script stays editable on
its own; this renderer copies it into the compose command.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "docker-compose.nas.yml.tmpl"
SCRIPT = ROOT / "nas-init.py"
OUTPUT = ROOT / "docker-compose.nas.yml"
MARKER = "__NAS_INIT_BODY__"


def render() -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    if MARKER not in template:
        raise SystemExit(f"{TEMPLATE.name} is missing {MARKER}")
    body = SCRIPT.read_text(encoding="utf-8")
    if "END_NAS_INIT" in body:
        raise SystemExit("nas-init.py must not contain the heredoc marker END_NAS_INIT")
    indented = []
    for line in body.splitlines():
        indented.append(("        " + line) if line else "")
    rendered = template.replace(MARKER, "\n".join(indented))
    if MARKER in rendered:
        raise SystemExit("marker survived rendering")
    return rendered


def main() -> None:
    rendered = render()
    check = "--check" in sys.argv[1:]
    if check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != rendered:
            raise SystemExit(
                "infra/docker-compose.nas.yml is stale. "
                "Run: python3 infra/render-nas-compose.py"
            )
        print("docker-compose.nas.yml matches nas-init.py")
        return
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
