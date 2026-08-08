# SPDX-License-Identifier: AGPL-3.0-or-later
"""The Python in the docs has to be Python, and has to call real methods.

Documentation rots quietly. A renamed argument or a method that never
existed reads perfectly well on the page and fails the first time
somebody pastes it, which is the worst moment to find out and the one
where you lose the reader for good.

So the help pages are parsed here and every fenced ``python`` block is
compiled and checked against the client's actual surface. This is not a
substitute for running the examples against a portal, and it does catch
the mistake that actually happens: writing about a parameter that was
renamed three commits ago.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

import gratisgis
from gratisgis import GratisGIS

REPO = Path(__file__).resolve().parents[3]
HELP = REPO / "apps" / "portal-web" / "content" / "help"
DOCS = [
    HELP / "reference" / "python-client.md",
    HELP / "reference" / "scripts.md",
    HELP / "reference" / "api-keys.md",
    REPO / "clients" / "python" / "README.md",
]

BLOCK = re.compile(r"```python\n(.*?)```", re.S)


def blocks():
    for doc in DOCS:
        if not doc.exists():
            # The client is installable on its own; a checkout without
            # the web app should skip rather than fail.
            continue
        for i, code in enumerate(BLOCK.findall(doc.read_text(encoding="utf-8"))):
            yield pytest.param(code, id=f"{doc.name}#{i}")


CASES = list(blocks())


@pytest.mark.skipif(not CASES, reason="docs not present in this checkout")
@pytest.mark.parametrize("code", CASES)
def test_example_is_valid_python(code: str):
    ast.parse(code)


@pytest.mark.skipif(not CASES, reason="docs not present in this checkout")
@pytest.mark.parametrize("code", CASES)
def test_example_only_calls_methods_that_exist(code: str):
    """Every ``gg.something(...)`` must be a real method on the client.

    Catches the rename. Deliberately narrow: it only looks at calls on a
    variable named ``gg``, which is the convention every example uses,
    so it cannot be fooled into checking shapely or pyproj.
    """
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute):
            continue
        if not (isinstance(func.value, ast.Name) and func.value.id == "gg"):
            continue
        assert hasattr(GratisGIS, func.attr), (
            f"The docs call gg.{func.attr}(), which GratisGIS does not have."
        )
        # Keyword arguments too: a renamed parameter is the other half
        # of the same failure.
        import inspect

        sig = inspect.signature(getattr(GratisGIS, func.attr))
        accepts_kwargs = any(
            p.kind is inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
        )
        if accepts_kwargs:
            continue
        for kw in node.keywords:
            if kw.arg is None:
                continue
            assert kw.arg in sig.parameters, (
                f"The docs pass {kw.arg}= to gg.{func.attr}(), "
                f"which takes {sorted(sig.parameters)}."
            )


@pytest.mark.skipif(not CASES, reason="docs not present in this checkout")
@pytest.mark.parametrize("code", CASES)
def test_example_imports_resolve_against_the_package(code: str):
    """``from gratisgis import X`` in the docs must actually import."""
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "gratisgis":
            for alias in node.names:
                assert hasattr(gratisgis, alias.name), (
                    f"The docs import {alias.name} from gratisgis, "
                    "which the package does not export."
                )
