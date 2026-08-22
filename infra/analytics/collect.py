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
import ipaddress
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
# Optional second database, same download script. Present means the
# hosting-network rule works; absent means it sits out.
ASN_DB = Path(
    os.environ.get("GG_ASN_DB", ANALYTICS_DIR / "geoip" / "GeoLite2-ASN.mmdb")
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
    r"|postman|insomnia|zabbix|nagios|expanse|shodan|internet-measurement"
    # Link-preview fetchers. A person pasted the URL somewhere and the
    # chat app went and got the card; the visit is real but nobody was
    # looking at it, and counting it as a visitor overstates reach.
    r"|facebookexternalhit|networkingextension|whatsapp|telegram|viber"
    r"|skypeuripreview|embedly|iframely|vkshare|pinterest|tumblr|discord",
    re.I,
)
# Probe paths. A request for any of these is somebody rattling
# doorknobs. The build-tooling entries (vite, webpack, firebase, source
# maps of a framework we do not run) matter more than they look: a
# scanner that rotates user agents shows up as several innocent-looking
# sessions, and these paths are what give it away. GratisGIS serves
# none of them, so a match is never a real visitor following a link.
PROBE_RE = re.compile(
    r"^/(wp-|wordpress|xmlrpc|\.env|\.git|phpmyadmin|admin\.php|vendor/|cgi-bin"
    r"|\.aws|\.ssh|config\.json|telescope|actuator|solr|boaform|hudson"
    r"|__/|\.vite|build/manifest|webpack-stats|server-status|server-info"
    r"|autodiscover|owa/|ecp/|jenkins|druid|_ignition|laravel|\.DS_Store"
    r"|\.svn|\.hg|backup|dump\.sql|db\.sql|adminer|eval-stdin|stalker_portal"
    r"|geoserver|struts|jmx-console|hnap1|goform|actuator/env)"
    r"|(^|/)[a-z0-9_-]*\.env$|/credentials$|\.pem$|/id_rsa|\.sql(\.gz)?$"
    r"|debug-trigger|/\.well-known/security\.txt$",
    re.I,
)
# A rendering engine fetches JavaScript and stylesheets. A fetcher that
# only pulls the HTML (and maybe favicon, robots.txt or the manifest,
# which are cheap guesses) does not. A successful fetch of one of these
# is the strongest cheap evidence that a real browser was involved;
# their absence is what unmasks the one-hit visits from hosting
# networks that otherwise look like a person who bounced instantly.
SCRIPT_RE = re.compile(r"^/_next/static/|\.(js|mjs|css)$", re.I)
# Browsers do not ask for this. Crawlers do, first thing.
ROBOTS_RE = re.compile(r"^/robots\.txt$", re.I)

# Networks that sell servers, not home internet. A visit from one of
# these that shows no browser evidence is machinery even when the user
# agent claims otherwise. Matched against the GeoLite2 ASN
# organisation string, which is why these are substrings rather than
# AS numbers: the numbers change hands, the names are stable enough
# and a miss only means the behavioural rules have to carry it.
HOSTING_ORG_RE = re.compile(
    r"digitalocean|amazon|aws|google|microsoft|azure|oracle|linode|akamai"
    r"|ovh|hetzner|vultr|scaleway|contabo|leaseweb|choopa|m247|datacamp"
    r"|alibaba|tencent|huawei cloud|ucloud|kamatera|hostinger|namecheap"
    r"|godaddy|cloudflare|fastly|censys|shodan|internet measurement"
    r"|palo alto|recyber|driftnet|stretchoid|binaryedge|bitsight",
    re.I,
)

# How far either side of a visit we look for probe behaviour from the
# same address. A scanner that rotates user agents produces several
# session rows; one of them rattling doorknobs condemns the rest.
PROBE_HALO_HOURS = 6
# A visit this short with no browser evidence is machinery. Wide enough
# to cover "GET /, GET /favicon.ico, GET /manifest.json"; narrow enough
# that a person who actually looked at a page clears it.
THIN_SESSION_HITS = 5
# A visit where most responses were 404 was guessing at URLs.
NOTFOUND_SHARE = 0.5
NOTFOUND_MIN_HITS = 3

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
    # request_dedupe_idx is UNIQUE, so it cannot be built over a table
    # that already holds duplicates, and the whole executescript below
    # would raise. Clear them first. This only ever fires once: the
    # rows exist because the pre-fingerprint bookmark re-read a log it
    # had already stored, and the index it unblocks is what stops that
    # from happening again.
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    indexes = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
    }
    if "request" in tables and "request_dedupe_idx" not in indexes:
        removed = conn.execute(
            "DELETE FROM request WHERE id NOT IN ("
            " SELECT min(id) FROM request GROUP BY ts, ip, coalesce(method,''),"
            " coalesce(path,''), coalesce(status,-1), coalesce(bytes,-1))"
        ).rowcount
        conn.commit()
        if removed:
            print(f"deduped {removed} repeated request rows", file=sys.stderr)
    schema = (Path(__file__).parent / "schema.sql").read_text()
    conn.executescript(schema)
    # schema.sql only creates what is missing, so a column added to an
    # existing table needs its own step. Cheap enough to check on every
    # run and it keeps upgrades to "pull and let the timer fire".
    have = {r["name"] for r in conn.execute("PRAGMA table_info(session)")}
    if "bot_reason" not in have:
        conn.execute("ALTER TABLE session ADD COLUMN bot_reason TEXT")
        conn.commit()
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


def client_address(req: dict) -> str | None:
    """The visitor's address from a Caddy request object, or None for
    traffic that should not be recorded (internal, or unparseable).

    The previous version did `.split(":")[0]`, which reads a bare IPv6
    address as its first hextet ("2a02:1210::1" became "2a02"), and
    filtered private ranges with string prefixes, which threw away
    every public address starting "172." (172.16/12 is private;
    172.217.x.x is Google, 172.58.x.x is T-Mobile). Real visitors were
    silently dropped at ingest. Parse properly instead and let the
    ipaddress module decide what is private.
    """
    raw = (req.get("client_ip") or req.get("remote_ip") or "").strip()
    if not raw:
        return None
    if raw.startswith("["):  # "[v6]:port"
        raw = raw[1:].split("]", 1)[0]
    elif raw.count(":") == 1 and "." in raw.partition(":")[0]:  # "v4:port"
        raw = raw.partition(":")[0]
    # Bare v4 and bare v6 fall through untouched: a bare v6 has more
    # than one colon (or none it could be confused with) and no
    # bracket, and must not be split.
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if addr.is_private or addr.is_loopback or addr.is_link_local:
        return None  # container-internal traffic and health checks
    return addr.compressed


def head_fingerprint(path: Path, gz: bool) -> str:
    """Hash the first bytes of a log file, as its identity.

    The first access line carries a microsecond `ts`, so two different
    files effectively never share a fingerprint, and a file that is
    merely appended to keeps its own across runs.
    """
    opener = gzip.open if gz else open
    try:
        with opener(path, "rb") as fh:  # type: ignore[operator]
            head = fh.read(512)
    except OSError:
        return ""
    return hashlib.sha1(head).hexdigest()[:16]


def ingest_caddy(conn: sqlite3.Connection) -> int:
    """Read new lines from every access log file.

    Bookmarks are keyed by inode, because lumberjack renames the live
    file when it rolls and a name-keyed offset would re-read the whole
    rotated file under its new name. The inode alone is not enough
    though: lumberjack unlinks the renamed file once it has gzipped a
    copy, so the freed inodes get handed straight back out to the next
    access.log and the next .gz. A recycled inode arrives carrying its
    predecessor's bookmark, which silently breaks ingestion in both
    directions. It skipped the live log for three days (a ~20MB offset
    against a fresh, smaller file, so `offset >= size` held forever)
    and separately re-read one whole file it had already stored.

    So the offset is stored against a fingerprint of the file's head
    and only honoured when that still matches. A mismatch means this
    inode now holds a different file, and it is read from the start.
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
        fingerprint = head_fingerprint(path, gz)
        # Stored as "<fingerprint>:<offset>". A bare integer is the old
        # inode-only format, which is exactly the state we cannot trust.
        stored = get_state(conn, key) or ""
        seen_fp, _, seen_off = stored.rpartition(":")
        offset = int(seen_off) if seen_fp and seen_fp == fingerprint else 0
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
                ip = client_address(req)
                if not ip:
                    continue
                headers = req.get("headers") or {}
                ua = (headers.get("User-Agent") or [""])[0]
                referer = (headers.get("Referer") or [""])[0]
                path_only = (req.get("uri") or "").split("?")[0]
                is_bot, is_asset, activity = classify(path_only, ua)
                # OR IGNORE against request_dedupe_idx. Re-reading a log
                # is then free, which is what lets a bookmark reset
                # backfill a gap without inflating the counts.
                cur = conn.execute(
                    "INSERT OR IGNORE INTO request (ts, ip, method, path, status,"
                    " duration, bytes, ua, referer, host, is_bot, is_asset, activity)"
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
                inserted += cur.rowcount
            new_offset = size if gz else fh.tell()
        set_state(conn, key, f"{fingerprint}:{new_offset if not gz else 1}")
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
        # >= rather than >: two events can share a millisecond across a
        # run boundary, and strictly-greater would skip the later one
        # forever. Re-reading the boundary event is free because the
        # insert is OR IGNORE on the event id. `last` is int()-cast on
        # read, so inlining it is not an injection surface.
        f" WHERE e.event_time >= {last} ORDER BY e.event_time"
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
        cur = conn.execute(
            "INSERT OR IGNORE INTO login (event_id, ts, ip, username, type, client, error)"
            " VALUES (?,?,?,?,?,?,?)",
            (event_id, ms / 1000.0, ip or None, username or None, etype,
             client or None, error or None),
        )
        # Boundary re-reads are ignored by the PK; only count real rows
        # so the log line stays honest.
        count += max(cur.rowcount, 0)
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


def resolve_asn(conn: sqlite3.Connection) -> int:
    """Fill ip_asn for addresses seen but not yet looked up.

    Optional: the ASN database is a separate MaxMind download. Without
    it every address stays unknown and the hosting-network rule in
    sessionise simply never fires, which is why nothing here is fatal.
    """
    if not ASN_DB.exists():
        return 0
    try:
        import geoip2.database  # type: ignore
    except ImportError:
        return 0

    rows = conn.execute(
        "SELECT DISTINCT ip FROM request WHERE ip NOT IN (SELECT ip FROM ip_asn)"
    ).fetchall()
    if not rows:
        return 0

    now = datetime.now(timezone.utc).isoformat()
    done = 0
    with geoip2.database.Reader(str(ASN_DB)) as reader:
        for row in rows:
            ip = row["ip"]
            asn = org = None
            try:
                r = reader.asn(ip)
                asn = r.autonomous_system_number
                org = r.autonomous_system_organization
            except Exception:
                pass
            conn.execute(
                "INSERT OR REPLACE INTO ip_asn (ip, asn, org, is_hosting, looked_up)"
                " VALUES (?,?,?,?,?)",
                (ip, asn, org, int(bool(org and HOSTING_ORG_RE.search(org))), now),
            )
            done += 1
    conn.commit()
    return done


# ------------------------------------------------------------- sessions


# Machinery tags. Useful on individual requests for weighing how busy a
# visit was, noise in the per-visit feature list.
MACHINERY_TAGS = {"map tiles", "api", "other"}


def bot_verdict(s: dict, probe_ts: dict[str, list[float]], hosting: set[str]) -> str | None:
    """Why this visit is machinery, or None if it looks like a person.

    Every rule is evidence about behaviour rather than a claim about
    identity, and the reason is stored so the dashboard can show its
    work. Ordered most specific first: the reason a reader sees should
    be the most informative one that applies.
    """
    if BOT_UA_RE.search(s["ua"] or ""):
        return "user agent"
    if s["probe"]:
        return "probe path"
    if s["robots"]:
        return "fetched robots.txt"
    # Everything below needs the absence of browser evidence, so stop
    # here for anything that actually loaded the application. The
    # 404-share rule in particular has to sit on this side of the gate:
    # a real visitor whose browser asked for /favicon.ico and
    # /apple-touch-icon.png on a site that serves neither racks up a
    # majority of 404s while doing nothing wrong.
    if s["scripts"]:
        return None
    if s["hits"] >= NOTFOUND_MIN_HITS and s["n404"] / s["hits"] >= NOTFOUND_SHARE:
        return "mostly 404s"
    halo = PROBE_HALO_HOURS * 3600
    near = probe_ts.get(s["ip"], ())
    if any(s["start"] - halo <= t <= s["end"] + halo for t in near):
        return "same address probed"
    if s["ip"] in hosting:
        return "hosting network"
    if s["hits"] <= THIN_SESSION_HITS:
        return "no browser assets"
    return None


def sessionise(conn: sqlite3.Connection, full: bool = False) -> int:
    """Rebuild sessions for the recent window from raw requests.

    Normally that window is the last few days. On a first run, or after
    a gap where the timer wasn't firing, there are older requests with
    no session rows yet, so the window opens back to the last session
    that was built (minus one gap, so a visit straddling the boundary
    is recomputed whole) or to the beginning if there are none at all.
    `full` rebuilds everything the raw table still holds, which is what
    --reclassify uses after the rules change.
    """
    gap = SESSION_GAP_MINUTES * 60
    recent = time.time() - SESSION_REBUILD_DAYS * 86400
    last_end = conn.execute("SELECT MAX(ended) e FROM session").fetchone()["e"]
    cutoff = 0.0 if full else (min(recent, last_end - gap) if last_end else 0.0)
    conn.execute("DELETE FROM session WHERE ended >= ?", (cutoff,))

    # Addresses that rattled a doorknob, and when. A scanner that
    # rotates user agents lands in several session rows; this is what
    # ties them back together.
    probe_ts: dict[str, list[float]] = {}
    for r in conn.execute(
        "SELECT ip, ts FROM request WHERE is_bot = 1 AND ts >= ?",
        (cutoff - PROBE_HALO_HOURS * 3600,),
    ):
        probe_ts.setdefault(r["ip"], []).append(r["ts"])
    hosting = {
        r["ip"] for r in conn.execute("SELECT ip FROM ip_asn WHERE is_hosting = 1")
    }

    rows = conn.execute(
        "SELECT ts, ip, ua, is_bot, is_asset, activity, path, status FROM request"
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
        reason = bot_verdict(s, probe_ts, hosting)
        conn.execute(
            "INSERT OR REPLACE INTO session (ip, ua_hash, ua, started, ended,"
            " duration, hits, page_views, api_calls, activities, is_bot, bot_reason)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                s["ip"], s["ua_hash"], s["ua"], s["start"], s["end"],
                round(s["end"] - s["start"], 1), s["hits"], s["pages"],
                s["api"], json.dumps(tags), int(bool(reason)), reason,
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
                "pages": 0, "api": 0, "tags": [], "probe": False,
                "n404": 0, "scripts": 0, "robots": False,
            }
        assert current is not None
        path = row["path"] or ""
        current["end"] = row["ts"]
        current["hits"] += 1
        if not row["is_asset"]:
            if path.startswith("/api/"):
                current["api"] += 1
            else:
                current["pages"] += 1
        if row["activity"]:
            current["tags"].append(row["activity"])
        current["probe"] = current["probe"] or bool(row["is_bot"])
        if row["status"] == 404:
            current["n404"] += 1
        # 304 counts: a returning browser revalidating its cache is
        # still a browser, and treating only 200 as evidence would put
        # every repeat visitor in the bot column.
        if row["status"] in (200, 304) and SCRIPT_RE.search(path):
            current["scripts"] += 1
        current["robots"] = current["robots"] or bool(ROBOTS_RE.match(path))
    written += flush(current)
    conn.commit()
    return written


def reclassify(conn: sqlite3.Connection) -> tuple[int, int]:
    """Re-run request classification over the retained raw window.

    The rules get sharper as new evasions turn up, and a rule that only
    applies going forward leaves the dashboard disagreeing with itself
    across the seam. Raw requests are kept for RAW_RETENTION_DAYS, so
    everything inside that window can be re-tagged and re-sessionised
    from source. Sessions older than the raw window keep whatever
    verdict they were given when their requests still existed.
    """
    changed = 0
    for row in conn.execute("SELECT id, path, ua, is_bot FROM request").fetchall():
        is_bot, _, _ = classify(row["path"] or "", row["ua"] or "")
        if int(is_bot) != int(row["is_bot"]):
            conn.execute(
                "UPDATE request SET is_bot = ? WHERE id = ?", (int(is_bot), row["id"])
            )
            changed += 1
    conn.commit()
    return changed, sessionise(conn, full=True)


def prune(conn: sqlite3.Connection) -> int:
    cutoff = time.time() - RAW_RETENTION_DAYS * 86400
    n = conn.execute("DELETE FROM request WHERE ts < ?", (cutoff,)).rowcount
    conn.commit()
    return n


def main() -> int:
    conn = connect()
    if "--reclassify" in sys.argv:
        # Ordering matters: ASN lookups first so the hosting-network
        # rule has data to work with on this pass rather than the next.
        asn = resolve_asn(conn)
        retagged, sessions = reclassify(conn)
        conn.execute("PRAGMA optimize")
        conn.close()
        print(f"reclassified: asn +{asn}  requests retagged {retagged}  "
              f"sessions rebuilt {sessions}")
        return 0
    reqs = ingest_caddy(conn)
    logins = ingest_keycloak(conn)
    geo = resolve_geo(conn)
    asn = resolve_asn(conn)
    sessions = sessionise(conn)
    pruned = prune(conn)
    conn.execute("PRAGMA optimize")
    conn.close()
    print(
        f"requests +{reqs}  logins +{logins}  geo +{geo}  asn +{asn}  "
        f"sessions {sessions}  pruned {pruned}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
