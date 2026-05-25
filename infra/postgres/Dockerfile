# GratisGIS Postgres image. Extends postgis/postgis with pg_partman
# so the engine's `observation` table can be range-partitioned by
# `tx_time` (see ROADMAP Phase 8 + the engine pivot doc). The base
# image already ships PostgreSQL 16 + PostGIS 3.5 + the PostgreSQL
# Global Development Group's apt repository, so `apt-get install`
# resolves the PG16-targeted partman package directly.
#
# Why we extend instead of using a third-party "postgis-partman"
# image: this keeps the upstream chain short (postgres -> postgis ->
# us) and lets us track postgis security updates without a second
# maintainer in the loop.
#
# Postgres 17 bump: pinned to 16-3.5 pending a coordinated prod
# pg_upgrade window. Bumping to 17 here without the upgrade plan
# would break prod on next deploy (PG16 data dir is unreadable by
# the PG17 binary). See docs/handoff/postgres-17-upgrade.md (TBD)
# for the migration steps.
FROM postgis/postgis:17-3.5

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-partman \
        postgresql-16-repack \
    && rm -rf /var/lib/apt/lists/*

# pg_repack rebuilds tables online (no full table lock, just brief
# trigger-install windows) so we can reclaim disk after big deletes
# without scheduling downtime. Used after the #115 P11 orphan-
# cleanup migration to actually shrink the observation partitions.
# CREATE EXTENSION lives in the migration that first uses it; this
# Dockerfile just needs to ship the binaries.
