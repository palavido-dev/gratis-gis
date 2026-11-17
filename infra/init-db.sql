-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Runs once, on first postgres container boot.
-- Enables extensions we rely on across the platform.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A schema that pg_tileserv can safely publish from. Tenant feature tables
-- will live in per-org schemas named `org_<uuid>`.
CREATE SCHEMA IF NOT EXISTS tiles;
GRANT USAGE ON SCHEMA tiles TO gratisgis;
