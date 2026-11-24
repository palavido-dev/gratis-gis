# GratisGIS Postgres image. Extends postgis/postgis with pg_partman
# so the engine's `observation` table can be range-partitioned by
# `tx_time` (see ROADMAP Phase 8 + the engine pivot doc). The base
# image ships PostgreSQL 17 + PostGIS 3.6 + the PostgreSQL Global
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
#
# PG18 (#306) was attempted on the tip and aborted on the demo host
# (2026-10-27): the official 18 image refuses a flat PG17 volume under
# /var/lib/postgresql. Stay on 17. The deliberate upgrade (image,
# mount, and dump/restore) is docs/upgrades/postgres-18.md, linked from
# docs/UPGRADING.md. Do not flip this tag to 18 on its own.
# infra/postgres/check-major.sh refuses a data directory whose
# PG_VERSION does not match this image. It does not change the tag.
#
# Debian trixie (#748). Up to 1.6 this was 17-3.5, built on bullseye,
# which is end of life: apt had to be pointed at archive.debian.org and
# apt-archive.postgresql.org, and the base OS got no security updates.
# 17-3.6 is built on postgres:17-trixie, so the stock Debian and PGDG
# sources work again and partman and repack install from them.
#
# The move changes glibc under existing data directories (2.31 to
# 2.41), and text indexes are sorted by glibc's rules. Postgres opens
# the old directory (same major) and warns about the collation version.
# portal-api rebuilds the indexes and records the new version before it
# migrates (src/maintenance/collation-refresh.ts), and runs the PostGIS
# extension upgrade (3.5 to 3.6) at the same point.
#
# Keep the tag exact. Moving it to another Debian release is the same
# kind of change and needs the same care.
FROM postgis/postgis:17-3.6

RUN apt-get update \
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

# pgBackRest for the opt-in continuous backup overlay
# (infra/docker-compose.pitr.yml, docs/cloud/backup-design.md). Unused
# unless that overlay is on: nothing runs it and no config points at a
# repository. It comes from the PGDG repository the base image already
# uses; Debian's own trixie package is older. Releases before 2.59.3
# made weak encryption salts (pgBackRest security notice, 2026-10-04),
# so the build stops on anything older. The version is read from dpkg,
# not by running pgbackrest: 2.59 and later refuse most commands as
# root, and the build runs as root. The directories are created
# here so the postgres user can write its queue and lock files.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends pgbackrest; \
    rm -rf /var/lib/apt/lists/*; \
    v="$(dpkg-query -W -f='${Version}' pgbackrest)"; \
    if ! dpkg --compare-versions "$v" ge 2.59.3; then \
      echo "pgbackrest $v is older than 2.59.3" >&2; exit 1; \
    fi; \
    install -d -o postgres -g postgres -m 750 \
      /var/spool/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest; \
    install -d -m 755 /etc/pgbackrest

# First-boot SQL and the Keycloak database script. The production
# compose also bind-mounts these files over the same paths. A NAS
# install has no checkout, so the copies in the image are what run.
# Build context is infra/ (the parent of this directory).
COPY init-prod-db.sql /docker-entrypoint-initdb.d/10-init.sql
COPY init-prod-db.sh /docker-entrypoint-initdb.d/20-init-keycloak-db.sh
RUN chmod 755 /docker-entrypoint-initdb.d/20-init-keycloak-db.sh

# Same identity stamp as the app images. This image does not serve
# the API; the stamp keeps REQUIRED_COMPOSE_REV in one place to bump.
ARG GG_VERSION=dev
ARG GIT_SHA=
ARG REQUIRED_COMPOSE_REV=3
ENV GG_VERSION=$GG_VERSION \
    GIT_SHA=$GIT_SHA \
    REQUIRED_COMPOSE_REV=$REQUIRED_COMPOSE_REV

# Set by deploy.sh to a hash of this image's inputs. Last, so it never
# invalidates the layers above.
ARG GG_PG_INPUTS=
LABEL org.gratisgis.pg-inputs=$GG_PG_INPUTS
