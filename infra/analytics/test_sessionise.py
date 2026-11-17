# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sessions rebuilt across the rolling cutoff keep their whole visit.

    GG_ANALYTICS_DIR=$(mktemp -d) python3 infra/analytics/test_sessionise.py
"""
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("GG_ANALYTICS_DIR", tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).parent))
import collect  # noqa: E402

DAY = 86400.0


def visit(conn, start, minutes, ip="198.51.100.7"):
    for m in range(0, minutes + 1, 2):
        ts = start + m * 60
        conn.execute(
            "INSERT INTO request (ts, ip, ua, is_bot, is_asset, activity, path, status, method, bytes)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ts, ip, "Mozilla/5.0", 0, 1 if m % 4 == 0 else 0, None,
             "/app.js" if m % 4 == 0 else f"/p{m}", 200, "GET", 100 + m),
        )


def sessions(conn):
    return [dict(r) for r in conn.execute("SELECT started, ended, hits FROM session ORDER BY started")]


def main() -> int:
    conn = collect.connect()
    base = 1_700_000_000.0
    visit(conn, base, 40)
    conn.commit()
    real_time = time.time
    fails = 0
    try:
        time.time = lambda: base + 5 * 60
        collect.sessionise(conn)
        whole = sessions(conn)
        # Step the clock so the 3-day cutoff sweeps across the visit.
        for minute in (10, 25, 40, 55):
            time.time = lambda m=minute: base + collect.SESSION_REBUILD_DAYS * DAY + m * 60
            collect.sessionise(conn)
            now = sessions(conn)
            if now != whole:
                print(f"FAIL cutoff at +{minute} min: {now} != {whole}")
                fails += 1
        # A full rebuild keeps sessions whose requests are already pruned.
        conn.execute("INSERT INTO session (ip, ua_hash, ua, started, ended, duration, hits,"
                     " page_views, api_calls, activities, is_bot) VALUES"
                     " ('203.0.113.1','x','ua',?,?,60,5,3,0,'[]',0)", (base - 90 * DAY, base - 90 * DAY + 60))
        conn.commit()
        collect.sessionise(conn, full=True)
        old = conn.execute("SELECT count(*) n FROM session WHERE started < ?", (base - DAY,)).fetchone()["n"]
        if old != 1:
            print("FAIL full rebuild deleted sessions older than the raw window")
            fails += 1
        if sessions(conn)[-1] != whole[-1]:
            print("FAIL full rebuild changed the recent visit")
            fails += 1
    finally:
        time.time = real_time
    print("sessionise:", "ok" if not fails else f"{fails} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
