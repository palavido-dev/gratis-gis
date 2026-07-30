#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ingest demo traffic into the analytics store.

Runs on the prod host from gg-analytics.timer. Four passes:

  1. Caddy access log  -> request rows (resumable by byte offset)
  2. Keycloak events   -> login rows  (resumable by event_time)
  3. GeoLite2          -> ip_geo rows for addresses not yet resolved
  4. Sessionise        -> session rows for the recent window

Everything is idempotent. Re-running mid-window recomputes the open
sessions rather than duplicating them, so the timer can fire as often
as you like.

Environment:
  GG_ANALYTICS_DIR   store location      (default /var/lib/gg-analytics)
  GG_CADDY_LOG_DIR   access logs         (default $GG_ANALYTICS_DIR/caddy-logs)
  GG_GEOIP_DB        GeoLite2 City mmdb  (default $GG_ANALYTICS_DIR/geoip/GeoLite2-City.mmdb)
  GG_PG_CONTAINER    postgres container  (default gratis-gis-prod-postgres)
  GG_PG_USER         postgres role       (default gratisgis)
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ANALYTICS_DIR = Path(os.environ.get("GG_ANALYTICS_DIR", "/var/lib/gg-analytics"))
CADDY_LOG_DIR = Path(os.environ.get("GG_CADDY_LOG_DIR", ANALYTICS_DIR / "caddy-logs"))
GEOIP_DB = Path(
    os.environ.get("GG_GEOIP_DB", ANALYTICS_DIR / "geoip" / "GeoLite2-City.mmdb")
)
PG_CONTAINER = os.environ.get("GG_PG_CONTAINER", "gratis-gis-prod-postgres")
PG_USER = os.environ.get("GG_PG_USER", "gratisgis")
DB_PATH = ANALYTICS_DIR / "analytics.db"

# A visit ends after this much silence from the same (ip, user agent).
SESSION_GAP_MINUTES = 30
# Rebuild sessions this far back on every run. Wider than the gap so a
# visit that straddles two collector runs is recomputed whole.
SESSION_REBUILD_DAYS = 3
# Raw requests older than this are dropped; sessions keep the summary.
RAW_RETENTION_DAYS = 30

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

# Anything matching here is machinery, not a page the visitor chose to
# look at. Kept in `request` (useful for weighing how heavy a session
# was) but excluded from page-view counts and never tagged with an
# activity.
ASSET_RE = re.compile(
    r"^/(_next/|favicon|robots\.txt|sitemap|manifest|sw\.js|workbox|models/|duckdb-ext/|icons?/)"
    r"|\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|wasm|onnx|txt)$",
    re.I,
)
# Map tiles and vector data. Machinery, but the presence of a lot of
# them is the strongest signal that somebody actually panned a map.
TILE_RE = re.compile(r"/tiles?/\d+/\d+/\d+|\.(mvt|pbf)$|/tile/\d+/\d+/\d+", re.I)

BOT_UA_RE = re.compile(
    r"bot|crawl|spider|slurp|scrapy|curl|wget|python-requests|httpx|go-http|java/"
    r"|okhttp|libwww|headless|phantomjs|lighthouse|pingdom|uptime|monitor|scanner"
    r"|nmap|masscan|zgrab|censys|semrush|ahrefs|mj12|dotbot|petalbot|bytespider"
    r"|checker|securityresearch|scan|probe|preview|unfurl|axios|node-fetch"
    r"|postman|insomnia|zabbix|nagios|expanse|shodan|internet-measurement",
    re.I,
)
# Probe paths. A request for any of these is somebody rattling doorknobs.
PROBE_RE = re.compile(
    r"^/(wp-|wordpress|xmlrpc|\.env|\.git|phpmyadmin|admin\.php|vendor/|cgi-bin"
    r"|\.aws|\.ssh|config\.json|telescope|actuator|solr|boaform|hudson)"
    r"|(^|/)[a-z0-9_-]*\.env$|/credentials$|\.pem$|/id_rsa",
    re.I,
)

# Ordered: first match wins, so specific routes precede generic ones.
ACTIVITY_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"^/items/{UUID}/map"), "web map"),
    (re.compile(rf"^/items/{UUID}/(field|data-collection)"), "field app"),
    (re.compile(r"^/field"), "field app"),
    (re.compile(rf"^/items/{UUID}/(viewer|editor|custom)/run"), "web app"),
    (re.compile(rf"^/items/{UUID}/responses"), "responses"),
    (re.compile(rf"^/forms/{UUID}/respond"), "form response"),
    (re.compile(rf"^/items/{UUID}/(form|pick-list)"), "forms"),
    (
        re.compile(
            rf"^/items/{UUID}/(edit|editor|data-layer|derived-layer|tile-layer"
            rf"|point-cloud|basemap|theme|tool|app-template|print-template"
            rf"|geo-boundary|geocoding|service|ogc-service|arcgis-service|custom)"
        ),
        "authoring",
    ),
    (re.compile(r"^/(items|maps|groups)/new"), "authoring"),
    (re.compile(r"^/admin"), "admin"),
    (re.compile(r"^/help"), "help"),
    (re.compile(r"^/(signin|api/auth)"), "sign-in"),
    (re.compile(r"^/(profile|settings)"), "account"),
    (re.compile(r"^/(items/trash|recently-deleted|groups/trash)"), "trash"),
    (re.compile(rf"^/items/{UUID}/?$"), "item detail"),
    (re.compile(r"^/(items|maps|groups)/?$"), "browse"),
    (re.compile(r"^/(why|credits|feedback)"), "landing"),
    (re.compile(r"^/?$"), "landing"),
    (re.compile(r"^/api/"), "api"),
]


def classify(path: str, ua: str) -> tuple[bool, bool, str | None]:
    """Return (is_bot, is_asset, activity) for one request line."""
    is_bot = bool(BOT_UA_RE.search(ua or "")) or bool(PROBE_RE.match(path or ""))
    is_asset = bool(ASSET_RE.search(path or "")) or bool(TILE_RE.search(path or ""))
    if is_asset:
        return is_bot, True, "map tiles" if TILE_RE.search(path or "") else None
    for pattern, tag in ACTIVITY_RULES:
        if pattern.match(path or ""):
            return is_bot, False, tag
    return is_bot, False, "other"


def connect() -> sqlite3.Connection:
    ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    schema = (Path(__file__).parent / "schema.sql").read_text()
    conn.executescript(schema)
    return conn


def get_state(conn: sqlite3.Connection, source: str) -> str | None:
    row = conn.execute(
        "SELECT position FROM ingest_state WHERE source = ?", (source,)
    ).fetchone()
    return row["position"] if row else None


def set_state(conn: sqlite3.Connection, source: str, position: str) -> None:
    conn.execute(
        "INSERT INTO ingest_state (source, position, updated_at) VALUES (?, ?, ?)"
        " ON CONFLICT(source) DO UPDATE SET position = excluded.position,"
        " updated_at = excluded.updated_at",
        (source, str(position), datetime.now(timezone.utc).isoformat()),
    )


# ---------------------------------------------------------------- caddy


def ingest_caddy(conn: sqlite3.Connection) -> int:
    """Read new lines from every access log file.

    Bookmarks are keyed by inode rather than filename: lumberjack
    renames the live file when it rolls, so a name-keyed offset would
    re-read the whole rotated file under its new name.
    """
    if not CADDY_LOG_DIR.is_dir():
        print(f"no caddy log dir at {CADDY_LOG_DIR}, skipping", file=sys.stderr)
        return 0

    inserted = 0
    for path in sorted(CADDY_LOG_DIR.iterdir()):
        if not path.is_file() or "access" not in path.name:
            continue
        gz = path.suffix == ".gz"
        key = f"caddy:{path.stat().st_ino}"
        offset = int(get_state(conn, key) or 0)
        size = path.stat().st_size
        if not gz and offset >= size:
            continue  # nothing new
        if gz and offset:
            continue  # rotated files are read once, whole

        opener = gzip.open if gz else open
        with opener(path, "rt", errors="replace") as fh:  # type: ignore[operator]
            if not gz:
                fh.seek(offset)
            for line in fh:
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Access entries carry a "request" object; everything
                # else in the file is runtime chatter (TLS maintenance,
                # config reloads). Do NOT filter on "logger" here:
                # access lines carry logger="http.log.access.log0", so
                # that test would drop every row we want.
                if "request" not in rec or "status" not in rec:
                    continue
                req = rec["request"]
                ip = (req.get("client_ip") or req.get("remote_ip") or "").split(":")[0]
                if not ip or ip.startswith(("172.", "10.", "192.168.", "127.")):
                    continue  # container-internal traffic and health checks
                headers = req.get("headers") or {}
                ua = (headers.get("User-Agent") or [""])[0]
                referer = (headers.get("Referer") or [""])[0]
                path_only = (req.get("uri") or "").split("?")[0]
                is_bot, is_asset, activity = classify(path_only, ua)
                conn.execute(
                    "INSERT INTO request (ts, ip, method, path, status, duration,"
                    " bytes, ua, referer, host, is_bot, is_asset, activity)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        rec.get("ts"),
                        ip,
                        req.get("method"),
                        path_only[:500],
                        rec.get("status"),
                        rec.get("duration"),
                        rec.get("size"),
                        ua[:400],
                        referer[:400],
                        req.get("host"),
                        int(is_bot),
                        int(is_asset),
                        activity,
                    ),
                )
                inserted += 1
            new_offset = size if gz else fh.tell()
        set_state(conn, key, str(new_offset if not gz else 1))
    conn.commit()
    return inserted


# ------------------------------------------------------------- keycloak


def ingest_keycloak(conn: sqlite3.Connection) -> int:
    """Copy new Keycloak auth events out of the keycloak database."""
    last = int(get_state(conn, "keycloak") or 0)
    sql = (
        "SELECT e.id, e.event_time, coalesce(e.ip_address,''),"
        " coalesce(u.username, coalesce(e.user_id,'')), e.type,"
        " coalesce(e.client_id,''), coalesce(e.error,'')"
        " FROM event_entity e LEFT JOIN user_entity u ON u.id = e.user_id"
        f" WHERE e.event_time > {last} ORDER BY e.event_time"
    )
    try:
        out = subprocess.run(
            [
                "docker", "exec", PG_CONTAINER,
                "psql", "-U", PG_USER, "-d", "keycloak",
                "-At", "-F", "\x1f", "-c", sql,
            ],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as err:
        print(f"keycloak ingest failed: {err}", file=sys.stderr)
        return 0

    count, high_water = 0, last
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 7:
            continue
        event_id, event_time, ip, username, etype, client, error = parts
        ms = int(event_time)
        high_water = max(high_water, ms)
        conn.execute(
            "INSERT OR IGNORE INTO login (event_id, ts, ip, username, type, client, error)"
            " VALUES (?,?,?,?,?,?,?)",
            (event_id, ms / 1000.0, ip or None, username or None, etype,
             client or None, error or None),
        )
        count += 1
    if high_water > last:
        set_state(conn, "keycloak", str(high_water))
    conn.commit()
    return count


# ------------------------------------------------------------------ geo


def resolve_geo(conn: sqlite3.Connection) -> int:
    """Fill ip_geo for addresses seen but not yet located."""
    if not GEOIP_DB.exists():
        return 0
    try:
        import geoip2.database  # type: ignore
    except ImportError:
        print("geoip2 not installed, skipping geo", file=sys.stderr)
        return 0

    rows = conn.execute(
        "SELECT DISTINCT ip FROM ("
        "  SELECT ip FROM request UNION SELECT ip FROM login WHERE ip IS NOT NULL"
        ") WHERE ip NOT IN (SELECT ip FROM ip_geo)"
    ).fetchall()
    if not rows:
        return 0

    now = datetime.now(timezone.utc).isoformat()
    done = 0
    with geoip2.database.Reader(str(GEOIP_DB)) as reader:
        for row in rows:
            ip = row["ip"]
            country = cc = region = city = None
            lat = lon = None
            try:
                r = reader.city(ip)
                country = r.country.name
                cc = r.country.iso_code
                region = r.subdivisions.most_specific.name
                city = r.city.name
                lat, lon = r.location.latitude, r.location.longitude
            except Exception:
                pass  # private, reserved, or simply not in the database
            conn.execute(
                "INSERT OR REPLACE INTO ip_geo"
                " (ip, country, country_cc, region, city, lat, lon, looked_up)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (ip, country, cc, region, city, lat, lon, now),
            )
            done += 1
    conn.commit()
    return done


# ------------------------------------------------------------- sessions


# Machinery tags. Useful on individual requests for weighing how busy a
# visit was, noise in the per-visit feature list.
MACHINERY_TAGS = {"map tiles", "api", "other"}


def sessionise(conn: sqlite3.Connection) -> int:
    """Rebuild sessions for the recent window from raw requests.

    Normally that window is the last few days. On a first run, or after
    a gap where the timer wasn't firing, there are older requests with
    no session rows yet, so the window opens back to the last session
    that was built (minus one gap, so a visit straddling the boundary
    is recomputed whole) or to the beginning if there are none at all.
    """
    gap = SESSION_GAP_MINUTES * 60
    recent = time.time() - SESSION_REBUILD_DAYS * 86400
    last_end = conn.execute("SELECT MAX(ended) e FROM session").fetchone()["e"]
    cutoff = min(recent, last_end - gap) if last_end else 0.0
    conn.execute("DELETE FROM session WHERE ended >= ?", (cutoff,))

    rows = conn.execute(
        "SELECT ts, ip, ua, is_bot, is_asset, activity, path FROM request"
        " WHERE ts >= ? ORDER BY ip, ua, ts",
        (cutoff,),
    ).fetchall()

    current: dict | None = None
    written = 0

    def flush(s: dict | None) -> int:
        if not s:
            return 0
        tags = [
            t
            for t, _ in Counter(s["tags"]).most_common()
            if t not in MACHINERY_TAGS
        ][:8]
        conn.execute(
            "INSERT OR REPLACE INTO session (ip, ua_hash, ua, started, ended,"
            " duration, hits, page_views, api_calls, activities, is_bot)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                s["ip"], s["ua_hash"], s["ua"], s["start"], s["end"],
                round(s["end"] - s["start"], 1), s["hits"], s["pages"],
                s["api"], json.dumps(tags), int(s["bot"]),
            ),
        )
        return 1

    for row in rows:
        ua_hash = hashlib.sha1((row["ua"] or "").encode()).hexdigest()[:12]
        same = (
            current
            and current["ip"] == row["ip"]
            and current["ua_hash"] == ua_hash
            and row["ts"] - current["end"] <= gap
        )
        if not same:
            written += flush(current)
            current = {
                "ip": row["ip"], "ua_hash": ua_hash, "ua": row["ua"],
                "start": row["ts"], "end": row["ts"], "hits": 0,
                "pages": 0, "api": 0, "tags": [], "bot": bool(row["is_bot"]),
            }
        assert current is not None
        current["end"] = row["ts"]
        current["hits"] += 1
        if not row["is_asset"]:
            if (row["path"] or "").startswith("/api/"):
                current["api"] += 1
            else:
                current["pages"] += 1
        if row["activity"]:
            current["tags"].append(row["activity"])
        current["bot"] = current["bot"] or bool(row["is_bot"])
    written += flush(current)
    conn.commit()
    return written


def prune(conn: sqlite3.Connection) -> int:
    cutoff = time.time() - RAW_RETENTION_DAYS * 86400
    n = conn.execute("DELETE FROM request WHERE ts < ?", (cutoff,)).rowcount
    conn.commit()
    return n


def main() -> int:
    conn = connect()
    reqs = ingest_caddy(conn)
    logins = ingest_keycloak(conn)
    geo = resolve_geo(conn)
    sessions = sessionise(conn)
    pruned = prune(conn)
    conn.execute("PRAGMA optimize")
    conn.close()
    print(
        f"requests +{reqs}  logins +{logins}  geo +{geo}  "
        f"sessions {sessions}  pruned {pruned}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
