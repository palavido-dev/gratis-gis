# GratisGIS portal-api production image. Multi-stage:
#
#   - build: pnpm install + prisma generate + nest build, run from
#     repo root so the workspace dependencies (shared-types,
#     form-schema) resolve cleanly. We deploy the api workspace to a
#     self-contained /out directory via `pnpm deploy --prod` so the
#     runtime image only carries what's needed.
#   - runtime: node:20 + GDAL + OpenSSL only. Drops the build chain
#     and dev deps. Runs as a non-root `app` user.
#
# Built from the repo root so the build context can see the whole
# monorepo:  docker build -f apps/portal-api/Dockerfile .

FROM node:26-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
# Build deps: gdal-async, prisma, and the @nestjs/cli all need build
# tools at install/generate time. Removed in the runtime stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      pkg-config \
      libgdal-dev \
      gdal-bin \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Layer caching: copy lockfile-relevant files first so pnpm install
# only re-runs when deps actually change.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
# pnpm's --frozen-lockfile expects EVERY workspace package referenced
# in the lockfile to exist in the tree. Copying the full apps/ subtree
# is the simplest way to satisfy that without per-package COPY juggling.
# .dockerignore on each app strips the heavy stuff (node_modules,
# .next, dist), so the build context stays small.
COPY apps ./apps

RUN pnpm install --frozen-lockfile

# @gratis-gis/shared-types and @gratis-gis/engine both declare
# "main": "./dist/index.js" so they must be tsc-compiled before
# downstream packages can import from them; the runtime image is
# plain Node and cannot parse a workspace package whose entrypoint
# is raw TypeScript. form-schema and ui are pure-TS (they expose
# ./src/index.ts directly) so they don't need a separate build
# step here -- nothing in the api runtime requires them. Building
# everything via turbo would also work but takes longer and pulls
# in the apps too.
RUN pnpm -C packages/shared-types build
RUN pnpm -C packages/engine build

# Prisma client (generated into node_modules/.prisma/client) and the
# Nest build (dist/) both happen here.
RUN pnpm -C apps/portal-api exec prisma generate
RUN pnpm -C apps/portal-api build

# Carve out a self-contained directory for the runtime stage. pnpm
# deploy follows the workspace links and produces a flat node_modules
# we can copy into a clean image. We deliberately keep dev deps
# because the prisma CLI lives there and we run `prisma migrate
# deploy` from the entrypoint at boot.
RUN pnpm deploy --filter=@gratis-gis/portal-api /out

FROM base AS runtime
WORKDIR /app
# Runtime deps for GDAL, the Prisma engine, and TLS. No build chain.
#
# postgresql-client-16 is required by BackupService.runPgDump (#277):
# the nightly cron shells out to `pg_dump` against the prod Postgres 16
# server, so the binary needs to be on PATH inside this image AND match
# the server's major version (pg_dump refuses to dump a newer server).
# Debian bookworm only ships postgresql-client (15), so we pull 16 from
# the official PGDG apt repo. gnupg is needed to dearmor the repo key.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgdal-dev \
      gdal-bin \
      openssl \
      ca-certificates \
      curl \
      gnupg \
      tini \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

# #179: pmtiles Go CLI for converting MBTiles / zipped XYZ tile
# directories into PMTiles at upload time. Single static binary
# (~10 MB), no transitive deps. Pinned to a known-good release;
# bump explicitly. The architecture suffix is mapped from the
# Docker BUILDPLATFORM (amd64 -> Linux_x86_64; arm64 ->
# Linux_arm64) so a multi-arch build picks the right binary.
ARG TARGETARCH=amd64
ARG PMTILES_VERSION=1.30.2
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) PMTILES_ARCH=Linux_x86_64 ;; \
      arm64) PMTILES_ARCH=Linux_arm64 ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/pmtiles.tar.gz \
      "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_${PMTILES_ARCH}.tar.gz"; \
    tar -xzf /tmp/pmtiles.tar.gz -C /tmp pmtiles; \
    mv /tmp/pmtiles /usr/local/bin/pmtiles; \
    chmod +x /usr/local/bin/pmtiles; \
    rm /tmp/pmtiles.tar.gz; \
    /usr/local/bin/pmtiles version

# Drop privileges. Postgres connections, file uploads, and GDAL all
# work fine for a non-root user.
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

COPY --from=build --chown=app:app /out /app
# Prisma migrations live alongside schema.prisma and aren't part of the
# deploy output. Mount them in by hand so `prisma migrate deploy` works
# from this image.
COPY --from=build --chown=app:app /repo/apps/portal-api/prisma /app/prisma

# BackupService writes archives to BACKUP_DIR (default ./backups), and
# that has to be a writable path for the non-root `app` user. Pre-create
# it with the right ownership so a volume mount onto this path inherits
# the same uid/gid (Docker volumes inherit the underlying directory's
# ownership when first attached).
#
# /var/lib/gg-staging is the cross-container staging dir for the
# async-import worker (#115 P8). Same ownership trick: the `gg-staging`
# named volume needs to inherit app:app at first attach so the
# IngestStagingService can mkdir under it as the non-root `app` user.
# Without this pre-create, the volume mount lands as root:root and
# every `/ingest/stage` POST hits EACCES.
RUN mkdir -p /app/backups /app/data /var/lib/gg-staging && chown -R app:app /app/backups /app/data /var/lib/gg-staging

# Entrypoint: apply migrations, then start. Idempotent on a current
# DB (no-op when nothing pending). Surfaces migration errors as exit
# codes so the container fails fast on a bad deploy.
COPY --chown=app:app apps/portal-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER app
EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
