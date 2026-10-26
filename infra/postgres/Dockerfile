# GratisGIS Postgres image. Extends postgis/postgis with pg_partman
# so the engine's `observation` table can be range-partitioned by
# `tx_time` (see ROADMAP Phase 8 + the engine pivot doc). The base
# image ships PostgreSQL 18 + PostGIS 3.6 + the PostgreSQL Global
# Development Group's apt repository, so `apt-get install` resolves
# the PG18-targeted partman package directly.
#
# Why we extend instead of using a third-party "postgis-partman"
# image: this keeps the upstream chain short (postgres -> postgis ->
# us) and lets us track postgis security updates without a second
# maintainer in the loop.
#
# Upgrade history:
#   - 16 → 17 (executed 2026-05-25): pg_dumpall on 16, swap image,
#     psql -f into fresh 17. Old data dir kept as
#     /var/lib/docker/volumes/gratis-gis-prod_pgdata/_data.pg16.backup.
#   - 17 → 18 (#306): same dump/restore dance. The PG17 data dir is
#     unreadable by the PG18 binary. Prefer pg_dumpall (or
#     pg_upgrade with matching binaries) before swapping this image
#     on any deployment that already has a volume. Compose mounts
#     also move from /var/lib/postgresql/data → /var/lib/postgresql
#     (docker-library/postgres#1259 major-version subdirs).
#
# Base OS: postgis/postgis:18-3.6 is Debian 13 (trixie). That retires
# the bullseye archive.debian.org / apt-archive.postgresql.org
# workarounds that the 17-3.5 Dockerfile needed after bullseye EOL.
FROM postgis/postgis:18-3.6

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-18-partman \
        postgresql-18-repack \
    && rm -rf /var/lib/apt/lists/*

# pg_repack rebuilds tables online (no full table lock, just brief
# trigger-install windows) so we can reclaim disk after big deletes
# without scheduling downtime. Used after the #115 P11 orphan-
# cleanup migration to actually shrink the observation partitions.
# CREATE EXTENSION lives in the migration that first uses it; this
# Dockerfile just needs to ship the binaries.
