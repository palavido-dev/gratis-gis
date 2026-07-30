#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Render the demo traffic dashboard to a self-contained HTML file.

Reads the SQLite store written by collect.py and emits
$GG_ANALYTICS_DIR/dashboard.html with no external assets, no network
calls and no build step, so it can be copied anywhere and opened.

Charts are inline SVG. Every chart plots a single series, so none of
them carry a legend; the title says what is plotted and the tables at
the bottom are the table view for the whole page.
"""
from __future__ import annotations

import html
import json
import os
import re
import sqlite3
import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ANALYTICS_DIR = Path(os.environ.get("GG_ANALYTICS_DIR", "/var/lib/gg-analytics"))
DB_PATH = ANALYTICS_DIR / "analytics.db"
OUT_PATH = Path(os.environ.get("GG_DASHBOARD_OUT", ANALYTICS_DIR / "dashboard.html"))

WINDOW_DAYS = 30

TZ_NAME = os.environ.get("GG_TZ", "UTC")
try:
    TZ = ZoneInfo(TZ_NAME)
except Exception:
    TZ, TZ_NAME = timezone.utc, "UTC"
# A visit with no page view is a bot that fetched one asset, a health
# probe, or a preview bot. Human counts use this floor throughout.
HUMAN = (
    "is_bot = 0 AND page_views >= 1 AND (hits - page_views - api_calls) > 0"
)

# The three views the filter pills switch between, each a session
# predicate. Human is first because it is the default: the question
# the dashboard exists to answer is "did anyone come by", and bot
# traffic drowns that out. Everything else is still one click away
# rather than silently discarded, which is the point of showing all
# three counts on the pills themselves.
#
# "All" is deliberately not "human + bots": a session with no page
# view and no bot verdict (an asset fetch, a health probe, a
# connection that hung up) belongs to neither, and hiding it from
# every view would make the totals lie.
AUDIENCES: list[tuple[str, str, str]] = [
    ("human", "Human", HUMAN),
    ("bot", "Bots", "is_bot = 1"),
    ("all", "All", "1=1"),
]

# Maintainer accounts. Their sign-ins are not visitor traffic, and
# counting them makes a quiet week look busier than it was. Every
# address that has ever authenticated as one of these is treated as a
# maintainer address, so the browsing sessions from the same machine
# drop out too, including sessions signed in as a tester-* account or
# not signed in at all. Override with a comma-separated list; set it
# to an empty string to count everything.
OWNER_ACCOUNTS = [
    a.strip()
    for a in os.environ.get("GG_OWNER_ACCOUNTS", "admin").split(",")
    if a.strip()
]


def q(conn, sql, *args):
    return conn.execute(sql, args).fetchall()


def local(ts: float) -> datetime:
    """Epoch seconds to a datetime in the display timezone."""
    return datetime.fromtimestamp(ts, TZ)


def owner_addresses(conn) -> list[str]:
    """Addresses that have ever signed in as a maintainer account."""
    if not OWNER_ACCOUNTS:
        return []
    marks = ",".join("?" * len(OWNER_ACCOUNTS))
    rows = conn.execute(
        f"SELECT DISTINCT ip FROM login WHERE username IN ({marks})"
        " AND ip IS NOT NULL AND ip <> ''",
        OWNER_ACCOUNTS,
    ).fetchall()
    return [r["ip"] for r in rows]


def not_owner(ips: list[str], column: str = "ip") -> str:
    """SQL fragment excluding maintainer addresses. Inlined rather than
    parameterised because it is spliced into a dozen queries; the
    values come from our own database and are matched against a strict
    address shape first."""
    safe = [i for i in ips if re.fullmatch(r"[0-9a-fA-F:.]{3,45}", i or "")]
    if not safe:
        return "1=1"
    quoted = ",".join(f"'{i}'" for i in safe)
    return f"{column} NOT IN ({quoted})"


def fmt_duration(seconds: float | None) -> str:
    if not seconds or seconds < 1:
        return "0s"
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    return f"{s // 3600}h {(s % 3600) // 60:02d}m"


def compact(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 10_000:
        return f"{n / 1000:.1f}K"
    return f"{n:,}"


# --------------------------------------------------------------- charts
#
# Mark specs come from the design system: bars capped at 24px with a 4px
# rounded data-end squared at the baseline, 1px solid recessive
# gridlines, values on the tip rather than on every mark, and text in
# ink tokens rather than the series color.

BAR_CAP = 24.0
RADIUS = 4.0


def column_chart(rows: list[tuple[str, int, str]], height: int = 190) -> str:
    """Vertical columns over time. rows = [(label, value, tooltip)]."""
    if not rows:
        return '<p class="empty">No traffic recorded yet.</p>'
    width, pad_l, pad_b, pad_t = 900, 34, 22, 14
    plot_h = height - pad_b - pad_t
    peak = max(v for _, v, _ in rows) or 1
    # Round the top gridline to something clean so ticks read as numbers
    # a person would choose.
    step = max(1, -(-peak // 4))
    top = step * 4
    band = (width - pad_l) / len(rows)
    bar_w = min(BAR_CAP, max(3.0, band - 6))

    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="Daily visits for the last {len(rows)} days" class="chart">'
    ]
    for i in range(5):
        val = top * i / 4
        y = pad_t + plot_h - (val / top) * plot_h
        parts.append(
            f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width}" y2="{y:.1f}" class="grid"/>'
            f'<text x="{pad_l - 8}" y="{y + 4:.1f}" class="tick" text-anchor="end">'
            f"{int(val):,}</text>"
        )
    peak_i = max(range(len(rows)), key=lambda i: rows[i][1])
    for i, (label, value, tip) in enumerate(rows):
        h = (value / top) * plot_h
        x = pad_l + i * band + (band - bar_w) / 2
        y = pad_t + plot_h - h
        if h > 0:
            r = min(RADIUS, h)
            # Rounded at the data end, square on the baseline.
            parts.append(
                f'<path d="M{x:.1f},{pad_t + plot_h:.1f} V{y + r:.1f} '
                f"a{r},{r} 0 0 1 {r},-{r} H{x + bar_w - r:.1f} "
                f'a{r},{r} 0 0 1 {r},{r} V{pad_t + plot_h:.1f} Z" '
                f'class="bar" data-tip="{html.escape(tip)}"/>'
            )
        else:
            parts.append(
                f'<rect x="{x:.1f}" y="{pad_t + plot_h - 1:.1f}" width="{bar_w:.1f}" '
                f'height="1" class="bar-zero" data-tip="{html.escape(tip)}"/>'
            )
        if i == peak_i and value:
            parts.append(
                f'<text x="{x + bar_w / 2:.1f}" y="{y - 5:.1f}" class="value" '
                f'text-anchor="middle">{value:,}</text>'
            )
        if len(rows) <= 14 or i % 5 == 0 or i == len(rows) - 1:
            parts.append(
                f'<text x="{x + bar_w / 2:.1f}" y="{height - 6}" class="tick" '
                f'text-anchor="middle">{html.escape(label)}</text>'
            )
    parts.append(
        f'<line x1="{pad_l}" y1="{pad_t + plot_h}" x2="{width}" '
        f'y2="{pad_t + plot_h}" class="axis"/></svg>'
    )
    return "".join(parts)


def bar_chart(rows: list[tuple[str, int, str]], unit: str = "") -> str:
    """Horizontal bars for ranked categories. rows = [(label, value, tip)]."""
    if not rows:
        return '<p class="empty">Nothing recorded yet.</p>'
    row_h, width, label_w = 30, 620, 190
    height = row_h * len(rows) + 6
    peak = max(v for _, v, _ in rows) or 1
    track = width - label_w - 62
    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" class="chart">'
    ]
    for i, (label, value, tip) in enumerate(rows):
        y = i * row_h + 3
        w = max(2.0, (value / peak) * track)
        bar_h = min(BAR_CAP, row_h - 12)
        by = y + (row_h - bar_h) / 2 - 3
        r = min(RADIUS, w)
        parts.append(
            f'<text x="0" y="{y + row_h / 2:.1f}" class="row-label">'
            f"{html.escape(label[:34])}</text>"
            f'<path d="M{label_w},{by:.1f} H{label_w + w - r:.1f} '
            f"a{r},{r} 0 0 1 {r},{r} V{by + bar_h - r:.1f} "
            f'a{r},{r} 0 0 1 -{r},{r} H{label_w} Z" class="bar" '
            f'data-tip="{html.escape(tip)}"/>'
            f'<text x="{label_w + w + 8:.1f}" y="{y + row_h / 2:.1f}" '
            f'class="value-inline">{value:,}{html.escape(unit)}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


# ------------------------------------------------------------------ page


def panel(conn, key: str, label: str, where: str, owner_ips: list[str],
          now: datetime, geo_note: str) -> str:
    """Every stat on the page, computed for one audience.

    `where` is the session predicate that defines the audience, so the
    hero figure, the tiles, both charts, the visit table and the
    sign-in table all describe the same population. The page renders
    this three times and the pills swap which one is visible: the
    numbers can never drift out of step with the filter because there
    is only one code path producing them.
    """
    since = (now - timedelta(days=WINDOW_DAYS)).timestamp()
    since_7 = (now - timedelta(days=7)).timestamp()
    NOT_OWNER = not_owner(owner_ips)
    NOT_OWNER_S = not_owner(owner_ips, "s.ip")
    NOT_OWNER_L = not_owner(owner_ips, "l.ip")
    # Sign-ins belong to whoever was browsing from that address, so the
    # audience filter reaches them through the sessions they came with.
    # ("All" skips the subquery entirely rather than paying for it.)
    login_scope = (
        "1=1" if key == "all"
        else f"l.ip IN (SELECT ip FROM session WHERE {where})"
    )

    visitors = q(
        conn, f"SELECT COUNT(DISTINCT ip) c FROM session WHERE {where} AND started >= ?"
        f" AND {NOT_OWNER}", since,
    )[0]["c"]
    visitors_7 = q(
        conn, f"SELECT COUNT(DISTINCT ip) c FROM session WHERE {where} AND started >= ?"
        f" AND {NOT_OWNER}", since_7,
    )[0]["c"]
    visits = q(
        conn, f"SELECT COUNT(*) c FROM session WHERE {where} AND started >= ?"
        f" AND {NOT_OWNER}", since,
    )[0]["c"]
    logins = q(
        conn, f"SELECT COUNT(*) c FROM login l WHERE l.type = 'LOGIN' AND l.ts >= ?"
        f" AND {NOT_OWNER_L} AND {login_scope}", since,
    )[0]["c"]
    login_users = q(
        conn,
        f"SELECT COUNT(DISTINCT l.username) c FROM login l WHERE l.type='LOGIN'"
        f" AND l.ts >= ? AND {NOT_OWNER_L} AND {login_scope}", since,
    )[0]["c"]

    durations = [
        r["duration"]
        for r in q(
            conn,
            f"SELECT duration FROM session WHERE {where} AND started >= ? AND hits > 1"
            f" AND {NOT_OWNER}",
            since,
        )
    ]
    median = statistics.median(durations) if durations else 0
    longest = max(durations) if durations else 0

    # Daily columns.
    buckets: dict[str, list] = {}
    for r in q(
        conn,
        f"SELECT started, ip FROM session WHERE {where} AND started >= ?"
        f" AND {NOT_OWNER}",
        since,
    ):
        bucket_key = local(r["started"]).strftime("%Y-%m-%d")
        entry = buckets.setdefault(bucket_key, [0, set()])
        entry[0] += 1
        entry[1].add(r["ip"])
    days = []
    for i in range(WINDOW_DAYS, -1, -1):
        day = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        n, ips = buckets.get(day, (0, set()))
        days.append((day[5:], n, f"{day}: {n} visit(s), {len(ips)} unique IP(s)"))

    # Locations.
    loc_rows = q(
        conn,
        f"SELECT COALESCE(g.city || ', ' || g.country, g.country, 'Unknown') place,"
        f" COUNT(*) n, COUNT(DISTINCT s.ip) u FROM session s"
        f" LEFT JOIN ip_geo g ON g.ip = s.ip"
        f" WHERE {where} AND s.started >= ? AND {NOT_OWNER_S}"
        f" GROUP BY place ORDER BY n DESC LIMIT 12",
        since,
    )
    locations = [
        (r["place"], r["n"], f"{r['n']} visit(s) from {r['u']} address(es)")
        for r in loc_rows
    ]
    countries = q(
        conn,
        f"SELECT COUNT(DISTINCT g.country) c FROM session s JOIN ip_geo g ON g.ip = s.ip"
        f" WHERE {where} AND s.started >= ? AND {NOT_OWNER_S} AND g.country IS NOT NULL",
        since,
    )[0]["c"]

    # Activities: a visit counts once per feature it touched.
    tally: Counter[str] = Counter()
    for r in q(
        conn, f"SELECT activities FROM session WHERE {where} AND started >= ?"
        f" AND {NOT_OWNER}", since
    ):
        for tag in set(json.loads(r["activities"] or "[]")):
            if tag not in ("other", "api"):
                tally[tag] += 1
    activities = [
        (tag, n, f"{n} visit(s) touched {tag}") for tag, n in tally.most_common(12)
    ]

    recent = q(
        conn,
        f"SELECT s.*, g.city, g.country FROM session s LEFT JOIN ip_geo g ON g.ip = s.ip"
        f" WHERE {where} AND {NOT_OWNER_S} ORDER BY s.started DESC LIMIT 30",
    )
    recent_logins = q(
        conn,
        "SELECT l.*, g.city, g.country FROM login l LEFT JOIN ip_geo g ON g.ip = l.ip"
        f" WHERE l.type IN ('LOGIN','LOGIN_ERROR') AND {NOT_OWNER_L} AND {login_scope}"
        f" ORDER BY l.ts DESC LIMIT 25",
    )

    # The "why" column only earns its width where bots can appear.
    show_why = key != "human"
    why_head = "<th>Why flagged</th>" if show_why else ""
    span = 7 if show_why else 6

    def visit_rows() -> str:
        out = []
        for r in recent:
            place = ", ".join(x for x in (r["city"], r["country"]) if x) or "Unknown"
            tags = ", ".join(json.loads(r["activities"] or "[]")[:4]) or "-"
            when = local(r["started"])
            why = ""
            if show_why:
                reason = (r["bot_reason"] if "bot_reason" in r.keys() else None) or ""
                why = f'<td class="muted-cell">{html.escape(reason) or "-"}</td>'
            out.append(
                "<tr>"
                f"<td>{when:%b %d %H:%M}</td>"
                f"<td>{html.escape(place)}</td>"
                f'<td class="num">{fmt_duration(r["duration"])}</td>'
                f'<td class="num">{r["page_views"]}</td>'
                f"<td>{html.escape(tags)}</td>"
                f'<td class="ip">{html.escape(r["ip"])}</td>'
                f"{why}"
                "</tr>"
            )
        return "".join(out) or (
            f'<tr><td colspan="{span}" class="empty">No visits in this view.</td></tr>'
        )

    def login_rows() -> str:
        out = []
        for r in recent_logins:
            place = ", ".join(x for x in (r["city"], r["country"]) if x) or "Unknown"
            when = local(r["ts"])
            status = "failed" if r["type"] == "LOGIN_ERROR" else "ok"
            out.append(
                "<tr>"
                f"<td>{when:%b %d %H:%M}</td>"
                f'<td>{html.escape(r["username"] or "-")}</td>'
                f'<td><span class="pill {status}">{status}</span>'
                f'{" " + html.escape(r["error"]) if r["error"] else ""}</td>'
                f"<td>{html.escape(place)}</td>"
                f'<td class="ip">{html.escape(r["ip"] or "-")}</td>'
                "</tr>"
            )
        return "".join(out) or '<tr><td colspan="5" class="empty">No sign-ins in this view.</td></tr>'

    noun = {"human": "visitors", "bot": "bot addresses", "all": "addresses"}[key]
    blurb = {
        "human": "Visits that loaded the application and asked for at least one page.",
        "bot": "Visits ruled machinery, with the rule that decided it.",
        "all": "Everything recorded, people and machinery together.",
    }[key]

    return f"""
<div class="audience" data-audience="{key}" {'hidden' if key != 'human' else ''}>
<div class="card hero">
  <div>
    <div class="figure">{compact(visitors)}</div>
    <div class="label">unique {noun}, last {WINDOW_DAYS} days</div>
  </div>
  <div>
    <div class="label">{visitors_7} in the last 7 days &middot;
      {compact(visits)} visits total</div>
    <div class="label muted">{blurb}</div>
  </div>
</div>

<div class="tiles">
  <div class="card tile"><div class="label">Visits</div>
    <div class="value">{compact(visits)}</div>
    <div class="foot">{label.lower()} sessions in the window</div></div>
  <div class="card tile"><div class="label">Median visit length</div>
    <div class="value">{fmt_duration(median)}</div>
    <div class="foot">longest {fmt_duration(longest)}</div></div>
  <div class="card tile"><div class="label">Sign-ins</div>
    <div class="value">{logins:,}</div>
    <div class="foot">{login_users} distinct account(s)</div></div>
  <div class="card tile"><div class="label">Countries</div>
    <div class="value">{countries}</div>
    <div class="foot">resolved from visitor IPs</div></div>
</div>

<div class="card">
  <h2>Visits per day</h2>
  <p class="sub">{blurb} Hover a column for the count.</p>
  {column_chart(days)}
</div>

<div class="cols">
  <div class="card">
    <h2>Where they are</h2>
    <p class="sub">Visits by resolved location.</p>
    {geo_note}
    {bar_chart(locations)}
  </div>
  <div class="card">
    <h2>What they did</h2>
    <p class="sub">Visits that touched each area at least once.</p>
    {bar_chart(activities)}
  </div>
</div>

<div class="card">
  <h2>Recent visits</h2>
  <p class="sub">Most recent 30 {label.lower()} sessions.</p>
  <table><thead><tr><th>When</th><th>Location</th><th>Length</th>
    <th>Pages</th><th>Areas visited</th><th>IP</th>{why_head}</tr></thead>
  <tbody>{visit_rows()}</tbody></table>
</div>

<div class="card">
  <h2>Recent sign-ins</h2>
  <p class="sub">Keycloak authentication events from addresses in this view.</p>
  <table><thead><tr><th>When</th><th>Account</th><th>Result</th>
    <th>Location</th><th>IP</th></tr></thead>
  <tbody>{login_rows()}</tbody></table>
</div>
</div>
"""


def build(conn: sqlite3.Connection) -> str:
    now = datetime.now(TZ)
    since = (now - timedelta(days=WINDOW_DAYS)).timestamp()

    # Maintainer traffic is excluded from every number on the page.
    owner_ips = owner_addresses(conn)
    NOT_OWNER = not_owner(owner_ips)
    hidden_logins = q(
        conn,
        f"SELECT COUNT(*) c FROM login WHERE ts >= ? AND NOT ({NOT_OWNER})",
        since,
    )[0]["c"]
    hidden_visits = q(
        conn,
        f"SELECT COUNT(*) c FROM session WHERE {HUMAN} AND started >= ?"
        f" AND NOT ({NOT_OWNER})",
        since,
    )[0]["c"]

    counts = {
        key: q(
            conn,
            f"SELECT COUNT(*) c FROM session WHERE {where} AND started >= ?"
            f" AND {NOT_OWNER}",
            since,
        )[0]["c"]
        for key, _, where in AUDIENCES
    }

    countries = q(
        conn,
        f"SELECT COUNT(DISTINCT g.country) c FROM session s JOIN ip_geo g ON g.ip = s.ip"
        f" WHERE {HUMAN} AND s.started >= ? AND {not_owner(owner_ips, 's.ip')}"
        f" AND g.country IS NOT NULL",
        since,
    )[0]["c"]
    first_seen = q(conn, "SELECT MIN(ts) t FROM login")[0]["t"]

    history_note = (
        f"History starts {local(first_seen):%Y-%m-%d}."
        if first_seen
        else "No authentication events recorded yet."
    )

    # The note fires both when nothing has been resolved yet and when
    # the database was never installed (no ip_geo rows at all).
    tz_label = now.strftime("%Z") or TZ_NAME

    owner_note = ""
    if hidden_logins or hidden_visits:
        bits = []
        if hidden_visits:
            bits.append(f"{hidden_visits} visit(s)")
        if hidden_logins:
            bits.append(f"{hidden_logins} sign-in(s)")
        owner_note = (
            " &middot; excluding " + " and ".join(bits) + " from "
            + ", ".join(OWNER_ACCOUNTS) + " and their addresses"
        )

    geo_note = ""
    if countries == 0:
        geo_note = (
            '<p class="note">Locations are unresolved: the GeoLite2 database is not '
            "installed yet. Run <code>infra/analytics/geoip-update.sh</code> with a "
            "MaxMind licence key and locations fill in on the next collection.</p>"
        )

    def pill(key: str, label: str) -> str:
        # Built with concatenation rather than one f-string: the
        # attribute needs escaped quotes, and an f-string expression
        # cannot contain a backslash before Python 3.12. Prod is 3.11.
        current = ' aria-current="true"' if key == "human" else ""
        return (
            '<button type="button" class="filter" data-filter="' + key + '"'
            + current + ">" + label
            + ' <span class="count">' + f"{counts[key]:,}" + "</span></button>"
        )

    pills = "".join(pill(key, label) for key, label, _ in AUDIENCES)
    panels = "".join(
        panel(conn, key, label, where, owner_ips, now, geo_note)
        for key, label, where in AUDIENCES
    )

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GratisGIS demo traffic</title>
<style>
  :root {{
    color-scheme: light;
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6; --good: #0ca30c; --critical: #d03b3b;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      color-scheme: dark;
      --surface-1: #1a1a19; --page: #0d0d0d;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 28px 22px 60px; background: var(--page);
    color: var(--text-primary);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  .wrap {{ max-width: 1000px; margin: 0 auto; }}
  h1 {{ font-size: 19px; margin: 0 0 2px; }}
  h2 {{ font-size: 14px; margin: 0 0 2px; }}
  .sub {{ color: var(--muted); font-size: 12px; margin: 0 0 22px; }}
  .card {{ background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }}
  .card h2 + .sub {{ margin-bottom: 14px; }}
  .hero {{ display: flex; gap: 30px; align-items: flex-end; flex-wrap: wrap; }}
  .hero .figure {{ font-size: 52px; font-weight: 600; line-height: 1; }}
  .hero .label {{ color: var(--text-secondary); font-size: 13px; }}
  .tiles {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 14px; margin-bottom: 14px; }}
  .tile .label {{ color: var(--text-secondary); font-size: 12px; }}
  .tile .value {{ font-size: 25px; font-weight: 600; margin-top: 2px; }}
  .tile .foot {{ color: var(--muted); font-size: 11px; margin-top: 3px; }}
  .chart {{ width: 100%; height: auto; overflow: visible; }}
  .bar {{ fill: var(--series-1); }}
  .bar-zero {{ fill: var(--axis); }}
  .grid {{ stroke: var(--grid); stroke-width: 1; }}
  .axis {{ stroke: var(--axis); stroke-width: 1; }}
  .tick {{ fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }}
  .value {{ fill: var(--text-secondary); font-size: 11px; font-weight: 600; }}
  .value-inline {{ fill: var(--text-secondary); font-size: 11px;
    dominant-baseline: middle; font-variant-numeric: tabular-nums; }}
  .row-label {{ fill: var(--text-secondary); font-size: 12px; dominant-baseline: middle; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12.5px; }}
  th {{ text-align: left; color: var(--muted); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: .04em; padding: 0 8px 7px 0;
    border-bottom: 1px solid var(--border); }}
  td {{ padding: 7px 8px 7px 0; border-bottom: 1px solid var(--border);
    color: var(--text-secondary); }}
  td.num, .ip {{ font-variant-numeric: tabular-nums; }}
  .ip {{ color: var(--muted); font-size: 11.5px; }}
  .pill {{ display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; }}
  .pill.ok {{ background: color-mix(in srgb, var(--good) 15%, transparent); color: var(--good); }}
  .pill.failed {{ background: color-mix(in srgb, var(--critical) 15%, transparent);
    color: var(--critical); }}
  .filters {{ display: flex; gap: 8px; margin: 0 0 16px; flex-wrap: wrap; }}
  .filter {{ font: inherit; font-size: 12.5px; color: var(--text-secondary);
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 999px; padding: 5px 13px; cursor: pointer; }}
  .filter:hover {{ border-color: var(--axis); }}
  .filter[aria-current="true"] {{ background: var(--text-primary);
    border-color: var(--text-primary); color: var(--surface-1); }}
  .filter .count {{ font-variant-numeric: tabular-nums; opacity: .65;
    margin-left: 4px; }}
  .hero .label.muted, td.muted-cell {{ color: var(--muted); }}
  .hero .label.muted {{ font-size: 12px; margin-top: 4px; }}
  .empty, .note {{ color: var(--muted); font-size: 12.5px; }}
  .note code {{ font-size: 11.5px; }}
  .cols {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }}
  @media (max-width: 780px) {{ .cols {{ grid-template-columns: 1fr; }} }}
  #tip {{ position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--text-primary); color: var(--surface-1); padding: 5px 9px;
    border-radius: 6px; font-size: 12px; z-index: 9; white-space: nowrap; }}
</style></head>
<body><div class="wrap">

<h1>GratisGIS demo traffic</h1>
<p class="sub">gratisgis.org &middot; generated {now:%Y-%m-%d %H:%M} &middot;
  window: last {WINDOW_DAYS} days &middot; times in {tz_label}{owner_note}
  &middot; {history_note}</p>

<div class="filters" role="group" aria-label="Which traffic to show">
  {pills}
</div>

{panels}

</div><div id="tip"></div>
<script>
  // Audience filter. Each view is rendered server-side and the pills
  // just swap which one is shown, so every number on the page comes
  // from the same query the pill describes. The choice survives a
  // reload because the page regenerates every 15 minutes and losing
  // your filter on each refresh would be maddening.
  const KEY = 'gg-traffic-audience';
  function applyFilter(name) {{
    document.querySelectorAll('.audience').forEach(el => {{
      el.hidden = el.dataset.audience !== name;
    }});
    document.querySelectorAll('.filter').forEach(el => {{
      if (el.dataset.filter === name) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }});
    try {{ localStorage.setItem(KEY, name); }} catch (e) {{ /* private mode */ }}
  }}
  document.querySelectorAll('.filter').forEach(el => {{
    el.addEventListener('click', () => applyFilter(el.dataset.filter));
  }});
  try {{
    const saved = localStorage.getItem(KEY);
    if (saved && document.querySelector('.audience[data-audience="' + saved + '"]')) {{
      applyFilter(saved);
    }}
  }} catch (e) {{ /* private mode */ }}
</script>
<script>
  // Hover layer. Every mark carries data-tip; the tooltip follows the
  // pointer and never blocks the mark under it.
  const tip = document.getElementById('tip');
  document.addEventListener('mouseover', e => {{
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    tip.textContent = t.getAttribute('data-tip');
    tip.style.opacity = '1';
  }});
  document.addEventListener('mousemove', e => {{
    if (tip.style.opacity !== '1') return;
    const pad = 14;
    tip.style.left = Math.min(e.clientX + pad, innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY - tip.offsetHeight - 10) + 'px';
  }});
  document.addEventListener('mouseout', e => {{
    if (e.target.closest('[data-tip]')) tip.style.opacity = '0';
  }});
</script>
</body></html>
"""


def main() -> int:
    if not DB_PATH.exists():
        print(f"no analytics database at {DB_PATH}; run collect.py first")
        return 1
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    OUT_PATH.write_text(build(conn), encoding="utf-8")
    conn.close()
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
