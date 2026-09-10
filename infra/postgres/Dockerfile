# GratisGIS Postgres image. Extends postgis/postgis with pg_partman
# so the engine's `observation` table can be range-partitioned by
# `tx_time` (see ROADMAP Phase 8 + the engine pivot doc). The base
# image ships PostgreSQL 17 + PostGIS 3.5 + the PostgreSQL Global
# Development Group's apt repository, so `apt-get install` resolves
# the PG17-targeted partman package directly.
#
# Why we extend instead of using a third-party "postgis-partman"
# image: this keeps the upstream chain short (postgres -> postgis ->
# us) and lets us track postgis security updates without a second
# maintainer in the loop.
#
# Upgrade from 16 to 17 (executed 2026-05-25): the PG16 data dir is
# unreadable by the PG17 binary, so the upgrade is pg_dumpall on
# the 16 instance, swap the image, then psql -f the dump into the
# fresh 17 instance. The old data dir is preserved as
# /var/lib/docker/volumes/gratis-gis-prod_pgdata/_data.pg16.backup
# in case the restore needs to be reverted.
FROM postgis/postgis:17-3.5

# Check-Valid-Until=false because this image is bullseye based and
# bullseye-security has reached end of life. Its Release file stopped
# being refreshed and expired on 2026-09-08, at which point apt-get
# update began failing with exit 100 and every deploy died here, on a
# layer that has nothing to do with what was being released.
#
# This relaxes freshness, not trust. The repository is still signed and
# the signature is still verified; the only check dropped is the
# "Valid-Until" window, and since the suite is EOL there is no newer
# metadata to be withheld from us. The packages we install come from
# apt.postgresql.org anyway, which is current.
#
# Remove this when the base moves off bullseye. postgis/postgis
# publishes no bookworm variant of 17-3.5 today (checked 2026-09-10:
# only 17-3.5 and 17-3.5-alpine exist), so that is a base image change
# under the production database rather than a tag bump, and wants its
# own care.
RUN apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
        postgresql-17-partman \
        postgresql-17-repack \
    && rm -rf /var/lib/apt/lists/*

# pg_repack rebuilds tables online (no full table lock, just brief
# trigger-install windows) so we can reclaim disk after big deletes
# without scheduling downtime. Used after the #115 P11 orphan-
# cleanup migration to actually shrink the observation partitions.
# CREATE EXTENSION lives in the migration that first uses it; this
# Dockerfile just needs to ship the binaries.
