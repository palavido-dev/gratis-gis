-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Demo traffic analytics store.
--
-- Lives in its own SQLite file OUTSIDE the application database on
-- purpose: gg-reset-demo.timer restores the golden snapshot over
-- `gratisgis` every night at 04:00 UTC, so anything recorded in the
-- app DB is gone by morning. This file sits on the data volume and
-- is never touched by the reset.
--
-- Raw requests are pruned on a rolling window (see RAW_RETENTION_DAYS
-- in collect.py); sessions, logins and geo lookups are kept forever
-- because they are small and the whole point is the long trend.

PRAGMA journal_mode = WAL;

-- Ingest bookmarks. One row per source so a re-run picks up exactly
-- where the last one stopped: 'caddy:<inode>' holds
-- '<head fingerprint>:<byte offset>', 'keycloak' holds the last
-- event_time seen (ms since epoch). The fingerprint is load bearing,
-- not decoration: rotation recycles inodes, so the offset is only
-- meaningful once the file's head confirms it is the same file.
CREATE TABLE IF NOT EXISTS ingest_state (
  source     TEXT PRIMARY KEY,
  position   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per HTTP request off the Caddy access log.
CREATE TABLE IF NOT EXISTS request (
  id        INTEGER PRIMARY KEY,
  ts        REAL    NOT NULL,          -- epoch seconds
  ip        TEXT    NOT NULL,
  method    TEXT,
  path      TEXT,
  status    INTEGER,
  duration  REAL,                      -- seconds, as Caddy reports it
  bytes     INTEGER,
  ua        TEXT,
  referer   TEXT,
  host      TEXT,
  is_bot    INTEGER NOT NULL DEFAULT 0,
  is_asset  INTEGER NOT NULL DEFAULT 0,-- static chunk, font, tile, model
  activity  TEXT,                      -- coarse feature tag, NULL for assets
  -- Router prefetch, from a request header the rest of this row does
  -- not keep. Stored because it cannot be recovered from `path`: a
  -- reclassify pass would otherwise recompute the row and hand a
  -- prefetch its activity tag back.
  prefetch  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS request_ts_idx ON request (ts);
CREATE INDEX IF NOT EXISTS request_ip_idx ON request (ip, ts);
-- Makes re-reading a log line a no-op instead of a second row, so a
-- bookmark that has to be reset can backfill without inflating the
-- counts. Caddy's `ts` is epoch seconds to the microsecond, so a
-- collision here means the same request seen twice, not two requests.
-- coalesce() because SQLite treats NULLs as distinct in a UNIQUE
-- index, which would quietly exempt any column that ever goes null.
CREATE UNIQUE INDEX IF NOT EXISTS request_dedupe_idx ON request (
  ts, ip, coalesce(method,''), coalesce(path,''),
  coalesce(status,-1), coalesce(bytes,-1)
);

-- Visits, derived from `request` by grouping on (ip, user agent) and
-- cutting a new session after SESSION_GAP_MINUTES of silence.
-- Rebuilt for the recent window on every run, so a visit that is
-- still in progress gets its duration corrected on the next pass.
CREATE TABLE IF NOT EXISTS session (
  id          INTEGER PRIMARY KEY,
  ip          TEXT NOT NULL,
  ua_hash     TEXT NOT NULL,
  ua          TEXT,
  started     REAL NOT NULL,
  ended       REAL NOT NULL,
  duration    REAL NOT NULL,           -- seconds between first and last hit
  hits        INTEGER NOT NULL,        -- every request, assets included
  page_views  INTEGER NOT NULL,        -- HTML navigations only
  api_calls   INTEGER NOT NULL,
  activities  TEXT,                    -- JSON array of feature tags, most used first
  is_bot      INTEGER NOT NULL DEFAULT 0,
  bot_reason  TEXT,                    -- which rule fired, NULL for humans
  UNIQUE (ip, ua_hash, started)
);
CREATE INDEX IF NOT EXISTS session_started_idx ON session (started);

-- Keycloak authentication events, copied out of the keycloak DB so
-- they survive both realm-level event expiry and any future reset of
-- that database.
CREATE TABLE IF NOT EXISTS login (
  event_id TEXT PRIMARY KEY,
  ts       REAL NOT NULL,
  ip       TEXT,
  username TEXT,
  type     TEXT NOT NULL,              -- LOGIN, LOGOUT, LOGIN_ERROR, ...
  client   TEXT,
  error    TEXT
);
CREATE INDEX IF NOT EXISTS login_ts_idx ON login (ts);

-- Cached GeoLite2 ASN lookups. Separate from ip_geo because the ASN
-- database is a separate download that a deployment may not have; an
-- empty table here just means the network-based bot rule sits out.
CREATE TABLE IF NOT EXISTS ip_asn (
  ip        TEXT PRIMARY KEY,
  asn       INTEGER,
  org       TEXT,
  is_hosting INTEGER NOT NULL DEFAULT 0,
  looked_up TEXT NOT NULL
);

-- Cached GeoLite2 lookups, one row per address. Cached rather than
-- resolved on read so the dashboard stays fast and so a later
-- database refresh does not silently rewrite history.
CREATE TABLE IF NOT EXISTS ip_geo (
  ip         TEXT PRIMARY KEY,
  country    TEXT,
  country_cc TEXT,
  region     TEXT,
  city       TEXT,
  lat        REAL,
  lon        REAL,
  looked_up  TEXT NOT NULL
);
