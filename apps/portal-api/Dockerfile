# GratisGIS portal-api production image. Multi-stage:
#
#   - build: pnpm install + prisma generate + nest build, run from
#     repo root so the workspace dependencies (shared-types,
#     form-schema) resolve cleanly. We deploy the api workspace to a
#     self-contained /out directory via `pnpm deploy --prod` so the
#     runtime image only carries what's needed.
#   - runtime: node slim + GDAL + OpenSSL only. Drops the build
#     chain and dev deps. Runs as a non-root `app` user.
#
# Built from the repo root so the build context can see the whole
# monorepo:  docker build -f apps/portal-api/Dockerfile .
#
# Base is PINNED to an exact LTS version on purpose; see the note
# in apps/portal-web/Dockerfile (the floating node:25 tag moved to
# a release with a fetch regression and broke prod writes). Bump
# deliberately, both Dockerfiles together.

FROM node:24.18.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Three things in one RUN to keep the layer count tight:
#  1. Install pnpm via npm (the version is pinned to match the
#     packageManager field in root package.json so workspace
#     resolution stays consistent). Node 25 dropped the bundled
#     corepack, so we install pnpm directly rather than going
#     through `corepack enable`.
#  2. Remove the bundled npm CLI after pnpm is in place. The
#     node:*-bookworm-slim image ships npm with its own bundled
#     cross-spawn / glob / minimatch / tar under
#     /usr/local/lib/node_modules/npm/node_modules, and those
#     vendored copies lag the upstream patched versions by months.
#     Trivy reports CVEs against those bundled deps. We don't use
#     npm at runtime, so deleting it removes ~25 noisy HIGH
#     findings outright.
#  3. apt-get upgrade picks up base-image OS patches (libcap,
#     systemd, etc.) without waiting for a fresh node:* image
#     rebuild.
RUN npm install -g pnpm@9.12.0 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/*

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

# Build pmtiles from source so the embedded Go stdlib is current
# (see the pmtiles section in the runtime stage below for the
# rationale). golang:1.26-bookworm tracks the latest Go 1.26.x
# patch, which carries the stdlib fixes for CVE-2026-39823/-39825/
# -39826. Pinned to the same version constant the runtime stage
# uses so a bump propagates atomically.
FROM golang:1.26-bookworm AS pmtiles-build
ARG PMTILES_VERSION=1.30.3
# GOTOOLCHAIN=auto (the default) lets Go honour go-pmtiles' go.mod
# directive and pull the matching toolchain if the image's Go is
# older than declared. CGO=0 produces a static binary that runs on
# any glibc; no need for the runtime image to carry libgo.
ENV CGO_ENABLED=0
RUN go install "github.com/protomaps/go-pmtiles@v${PMTILES_VERSION}"

FROM base AS runtime
WORKDIR /app
# Runtime deps for GDAL, the Prisma engine, and TLS. No build chain.
#
# postgresql-client-17 is required by BackupService.runPgDump (#277):
# the nightly cron shells out to `pg_dump` against the prod Postgres 17
# server (postgis/postgis:17-3.5, see infra/postgres/Dockerfile), so the
# binary needs to be on PATH inside this image AND match the server's
# major version (pg_dump refuses to dump a newer server; keep this in
# lockstep with infra/postgres/Dockerfile's base image major version).
# Debian bookworm only ships postgresql-client (15), so we pull 17 from
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
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

# Remove the globally-installed pnpm from the runtime image.
# pnpm is only needed at build time (for `pnpm install` and
# `pnpm deploy`); the runtime invokes node and the Prisma CLI directly
# from /app/node_modules/.bin. Stripping it deletes the bundled tar,
# minimatch, glob, and cross-spawn copies under
# /usr/local/lib/node_modules/pnpm/dist/node_modules that Trivy keeps
# flagging as HIGH CVEs (CVE-2025-69262/-69263, CVE-2026-23745/-23950/
# -24842/-26960 in tar, CVE-2026-26996/-27903/-27904 in minimatch,
# CVE-2025-64756 in glob, CVE-2024-21538 in cross-spawn). Same pattern
# as the npm cleanup in the base stage.
RUN rm -rf /pnpm /usr/local/lib/node_modules/pnpm \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/pnpm-cjs

# #179: pmtiles Go CLI for converting MBTiles / zipped XYZ tile
# directories into PMTiles at upload time. Single static binary
# (~10 MB), no transitive deps. Pinned to a known-good release;
# bump explicitly.
#
# We build it from source instead of grabbing the upstream release
# tarball because the upstream binary at v1.30.3 is still compiled
# with Go 1.26.1, which Trivy flags as HIGH for three Go stdlib
# CVEs (CVE-2026-39823 html/template meta-tag escape, CVE-2026-39825
# net/http ReverseProxy query forwarding, CVE-2026-39826 html/template
# script-tag escape). None of those code paths are reachable from
# pmtiles' CLI usage, but Trivy can't see that from the binary alone.
# Rebuilding against the current `golang:1.26-bookworm` toolchain
# embeds a patched stdlib version into the binary so the alerts
# resolve at the source rather than via .trivyignore.
ARG PMTILES_VERSION=1.30.3
COPY --from=pmtiles-build /go/bin/go-pmtiles /usr/local/bin/pmtiles
RUN /usr/local/bin/pmtiles version

# Drop privileges. Postgres connections, file uploads, and GDAL all
# work fine for a non-root user.
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

COPY --from=build --chown=app:app /out /app
# Prisma migrations live alongside schema.prisma and aren't part of the
# deploy output. Mount them in by hand so `prisma migrate deploy` works
# from this image.
COPY --from=build --chown=app:app /repo/apps/portal-api/prisma /app/prisma

# Vendored OSM preset catalog (#OSM).  Lives under portal-web's
# content/ tree so the Next.js standalone build traces it for the
# web tier; the portal-api also needs it (OsmService loads it to
# build Overpass QL clauses), so copy the same file in here under
# a path the preset-catalog resolver looks for.
COPY --from=build --chown=app:app /repo/apps/portal-web/content/osm /app/apps/portal-web/content/osm

# Bundled sample datasets for "Load sample data" (#147). Copied
# explicitly (same pattern as the OSM catalog above) so the
# SamplesService resolver finds them regardless of what `pnpm deploy`
# chose to include in /out.
COPY --from=build --chown=app:app /repo/apps/portal-api/content /app/apps/portal-api/content

# Bake the DuckDB spatial extension for GeoParquet ingest. Prod runs
# air-gapped at runtime, so DuckDB must never fetch extensions on
# demand; this step INSTALLs spatial while the build still has
# network. The target directory is DUCKDB_EXTENSION_DIR, a constant
# exported by parquet-reader.ts. We require the compiled module and
# call its bakeSpatialExtension() instead of repeating the path here,
# so the path lives in exactly one place. The bake also LOADs the
# extension and runs a spatial query, so a corrupt download fails the
# image build rather than the first import in prod. Runs as root
# (before USER app): the baked files end up read-only for the app
# user, which is all LOAD needs. portal-worker shares this image
# (same Dockerfile, different CMD), so one bake covers both.
RUN node -e "require('/app/dist/ingest/parquet-reader.js').bakeSpatialExtension().then(function(dir){console.log('duckdb spatial baked at ' + dir)}).catch(function(err){console.error(err);process.exit(1)})"

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
