#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Every environment variable the apps read must be able to reach them.

Compose only puts a variable into a container when the service lists it
under `environment:` (or, for portal-web build-time values, under
`build.args`). A value set in infra/.env.prod alone is used for
interpolation in the compose file and nothing else. On the NAS stack
every service sources /boot/env, which nas-init.py writes, plus its own
`environment:` block in the template.

This script lists the variables read in apps/portal-api and
apps/portal-web and fails when one is missing from the prod compose or
from the NAS stack, unless infra/env-passthrough.allow names it with a
reason. It found NOTIFICATIONS_ENABLED, PORTAL_LOCK_ADMIN_TIER,
NOMINATIM_URL and others documented but never passed through.

  python3 infra/check-env-passthrough.py
  python3 infra/check-env-passthrough.py --self-test
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROD = ROOT / "infra/docker-compose.prod.yml"
NAS_TEMPLATE = ROOT / "infra/docker-compose.nas.yml.tmpl"
NAS_INIT = ROOT / "infra/nas-init.py"
ALLOW = ROOT / "infra/env-passthrough.allow"

NAME = r"[A-Z][A-Z0-9_]*"
READ_PATTERNS = [
    re.compile(rf"process\.env\.({NAME})\b"),
    re.compile(rf"process\.env\[\s*['\"]({NAME})['\"]\s*\]"),
    # Nest ConfigService and the small env helpers.
    re.compile(rf"\b(?:cfg|config|configService)\.(?:get|getOrThrow)(?:<[^>()]*>)?\(\s*['\"]({NAME})['\"]"),
    re.compile(rf"\b(?:envNum|parseIntEnv|envInt|resolvePositive)\(\s*['\"]({NAME})['\"]"),
]
# Which compose services run each app's code. portal-api's image also
# runs portal-worker, script-runner and script-executor.
APPS = {
    "portal-api": {
        "dirs": ["apps/portal-api/src"],
        "prod": ["portal-api", "portal-worker", "script-runner", "script-executor"],
        "nas": ["portal-api", "portal-worker"],
    },
    "portal-web": {
        "dirs": ["apps/portal-web/src", "apps/portal-web/next.config.mjs"],
        "prod": ["portal-web"],
        "nas": ["portal-web"],
    },
}
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
SKIP_PARTS = {"node_modules", "dist", ".next", "__tests__", "__mocks__", "test", "tests"}


def is_test_file(path: Path) -> bool:
    name = path.name
    return (
        ".spec." in name
        or ".test." in name
        or ".pg.spec." in name
        or any(part in SKIP_PARTS for part in path.parts)
    )


def source_files(entry: Path):
    if entry.is_file():
        yield entry
        return
    for path in sorted(entry.rglob("*")):
        if path.suffix in SOURCE_SUFFIXES and path.is_file() and not is_test_file(path):
            yield path


def env_reads(text: str) -> set[str]:
    found: set[str] = set()
    for pattern in READ_PATTERNS:
        found.update(pattern.findall(text))
    # Helpers that take `env = process.env` as a parameter for tests.
    if re.search(r"=\s*process\.env\b", text):
        found.update(re.findall(rf"\benv\.({NAME})\b", text))
    # `process.env.NEXT_PUBLIC_` inside a template string is a prefix,
    # not a variable.
    return {name for name in found if not name.endswith("_")}


def reads_for(app: dict, root: Path) -> dict[str, str]:
    """Variable name to the first file that reads it."""
    out: dict[str, str] = {}
    for rel in app["dirs"]:
        for path in source_files(root / rel):
            for name in env_reads(path.read_text(encoding="utf-8", errors="replace")):
                out.setdefault(name, str(path.relative_to(root)))
    return out


def compose_service_env(text: str) -> dict[str, set[str]]:
    """Keys under each service's `environment:` and `build.args`.

    A small indentation reader so the check needs no YAML library.
    Handles the map form (`KEY: value`) and the list form (`- KEY=value`).
    """
    services: dict[str, set[str]] = {}
    in_services = False
    service = None
    service_indent = None
    block_indent = None
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if indent == 0:
            # Top-level keys only. The NAS template has a heredoc
            # placeholder at column 0 inside a service's command.
            if re.match(r"^[A-Za-z0-9_.-]+:", line):
                in_services = line == "services:"
                service = None
            continue
        if not in_services:
            continue
        if service_indent is None or indent == service_indent:
            m = re.match(r"^([A-Za-z0-9_.-]+):\s*$", line)
            if m and (service_indent is None or indent == service_indent):
                service_indent = indent
                service = m.group(1)
                services.setdefault(service, set())
                block_indent = None
                continue
        if service is None:
            continue
        if block_indent is not None and indent <= block_indent:
            block_indent = None
        if block_indent is None:
            if re.match(r"^(environment|args):\s*$", line):
                block_indent = indent
            continue
        m = re.match(rf"^-?\s*['\"]?({NAME})['\"]?\s*[:=]", line)
        if m:
            services[service].add(m.group(1))
    return services


def nas_env_keys(text: str) -> set[str]:
    """Keys nas-init.py writes to /boot/env (the `values` dict)."""
    return set(re.findall(rf'^\s+"({NAME})":', text, flags=re.M))


def load_allow(text: str) -> dict[tuple[str, str], str]:
    """`NAME target reason`. target is prod, nas, or both."""
    allow: dict[tuple[str, str], str] = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(None, 2)
        if len(parts) < 3 or parts[1] not in {"prod", "nas", "both"}:
            raise SystemExit(f"env-passthrough.allow:{number}: want NAME prod|nas|both reason")
        name, target, reason = parts
        targets = ("prod", "nas") if target == "both" else (target,)
        for t in targets:
            allow[(name, t)] = reason
    return allow


def check(root: Path, prod_text: str, nas_tmpl: str, nas_init: str, allow_text: str) -> list[str]:
    prod = compose_service_env(prod_text)
    nas = compose_service_env(nas_tmpl)
    boot_env = nas_env_keys(nas_init)
    allow = load_allow(allow_text)
    used_allow: set[tuple[str, str]] = set()
    problems: list[str] = []
    for app_name, app in APPS.items():
        reads = reads_for(app, root)
        prod_keys = set().union(*(prod.get(s, set()) for s in app["prod"]))
        nas_keys = boot_env.union(*(nas.get(s, set()) for s in app["nas"]))
        for name in sorted(reads):
            for target, keys, where in (
                ("prod", prod_keys, "infra/docker-compose.prod.yml " + "/".join(app["prod"])),
                ("nas", nas_keys, "infra/nas-init.py or the NAS template " + "/".join(app["nas"])),
            ):
                if name in keys:
                    continue
                if (name, target) in allow:
                    used_allow.add((name, target))
                    continue
                problems.append(
                    f"{name} is read by {app_name} ({reads[name]}) but is not in {where}"
                )
    all_reads = set()
    for app in APPS.values():
        all_reads.update(reads_for(app, root))
    for (name, target) in sorted(set(allow) - used_allow):
        if name not in all_reads:
            problems.append(f"env-passthrough.allow lists {name} ({target}), which no app reads any more")
    return problems


def self_test() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "apps/portal-api/src").mkdir(parents=True)
        (root / "apps/portal-web/src").mkdir(parents=True)
        (root / "apps/portal-api/src/a.ts").write_text(
            "const a = process.env.WIRED;\n"
            "const b = process.env['MISSING_PROD'];\n"
            "cfg.get<string>('ALLOWED');\n"
            "envNum('KNOB', 3);\n"
        )
        (root / "apps/portal-web/src/helper.ts").write_text(
            "export function f(env = process.env) { return env.WEB_HELPER; }\n"
        )
        (root / "apps/portal-api/src/a.spec.ts").write_text("process.env.ONLY_IN_TESTS\n")
        (root / "apps/portal-web/next.config.mjs").write_text("process.env.WEB_BUILD\n")
        prod = (
            "services:\n"
            "  portal-api:\n"
            "    environment:\n"
            "      WIRED: x\n"
            "      KNOB: ${KNOB:-}\n"
            "  portal-worker:\n"
            "    environment:\n"
            "      - OTHER=1\n"
            "  portal-web:\n"
            "    build:\n"
            "      args:\n"
            "        WEB_BUILD: ${WEB_BUILD:-}\n"
            "    environment:\n"
            "      NODE_ENV: production\n"
            "      WEB_HELPER: ${WEB_HELPER:-}\n"
        )
        nas = (
            "services:\n"
            "  portal-api:\n"
            "    environment:\n"
            "      MISSING_PROD: x\n"
        )
        nas_init = (
            '    values = {\n        "WIRED": "1",\n        "KNOB": "",\n'
            '        "WEB_BUILD": "",\n        "WEB_HELPER": "",\n    }\n'
        )
        allow = "ALLOWED both read from a file mounted by the operator\n"
        problems = check(root, prod, nas, nas_init, allow)
        assert problems == [
            "MISSING_PROD is read by portal-api (apps/portal-api/src/a.ts) but is not in "
            "infra/docker-compose.prod.yml portal-api/portal-worker/script-runner/script-executor"
        ], problems
        stale = check(root, prod, nas, nas_init, allow + "GONE prod not read\n")
        assert any("GONE" in p for p in stale), stale
        unwired = check(root, prod.replace("WEB_HELPER", "OTHER_HELPER"), nas, nas_init, allow)
        assert any(p.startswith("WEB_HELPER is read by portal-web") for p in unwired), unwired
    print("check-env-passthrough self-test ok")


def main() -> None:
    if "--self-test" in sys.argv[1:]:
        self_test()
        return
    problems = check(
        ROOT,
        PROD.read_text(encoding="utf-8"),
        NAS_TEMPLATE.read_text(encoding="utf-8"),
        NAS_INIT.read_text(encoding="utf-8"),
        ALLOW.read_text(encoding="utf-8") if ALLOW.exists() else "",
    )
    if problems:
        print("Environment variables the apps read but Compose never passes:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(
            "Pass each one through with a safe default (KEY: ${KEY:-}) on the services "
            "that read it, in both infra/docker-compose.prod.yml and the NAS stack, or "
            "add it to infra/env-passthrough.allow with a reason.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    print("env passthrough ok")


if __name__ == "__main__":
    main()
