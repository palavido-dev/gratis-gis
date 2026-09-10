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

# This image is bullseye based and bullseye reached end of life, which
# broke every deploy here on 2026-09-08, on a layer that has nothing to
# do with whatever was being released. Two separate failures, in order:
#
#   1. bullseye-security's Release file stopped being refreshed and
#      expired, so apt-get update refused to proceed.
#   2. With freshness relaxed, the .deb files themselves 404, because
#      EOL suites are moved off deb.debian.org onto archive.debian.org.
#
# So the sources are repointed at the archive, which still carries
# bullseye and bullseye-updates. The security lines are dropped rather
# than repointed: the archive does not serve bullseye-security, and the
# suite is EOL so there is nothing new in it to miss.
#
# Be clear about the tradeoff. This layer no longer receives Debian
# security updates for the base OS. It does not receive them anywhere
# else either, because none are being published for bullseye, so this
# reflects reality rather than creating it. Check-Valid-Until stays off
# because archive Release files are old by design. Signatures are still
# verified. The two packages installed come from apt.postgresql.org,
# which is current and untouched by any of this.
#
# The actual fix is moving off bullseye, and it is deliberately not
# done here: postgis/postgis publishes no bookworm variant of 17-3.5
# (checked 2026-09-10, only 17-3.5 and 17-3.5-alpine), so it is a base
# image swap under the production database, which needs its own change
# and its own dump-and-restore plan rather than riding along with a
# release.
RUN sed -i '/security/d' /etc/apt/sources.list \
    && sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
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
