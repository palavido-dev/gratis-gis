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

FROM node:26.7.0-bookworm-slim AS base
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

# Layer caching, pnpm fetch pattern: populate the store from the
# LOCKFILE ALONE before any manifest or source file enters the
# image. `pnpm fetch` ignores package.json files entirely, so this
# layer's cache key is just pnpm-lock.yaml (+ the workspace file
# for store settings). The previous shape copied the whole apps/
# tree before `pnpm install`, which meant every source edit busted
# the install layer and re-resolved + re-downloaded all deps: on
# the 4-core prod box that dominated deploy time.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Manifests + sources come in only after the store is warm. pnpm's
# --frozen-lockfile expects EVERY workspace package referenced in
# the lockfile to exist in the tree. Copying the full apps/ subtree
# is the simplest way to satisfy that without per-package COPY
# juggling; the repo-root .dockerignore strips the heavy stuff
# (node_modules, .next, dist), so the build context stays small.
COPY package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# --offline: link strictly from the store `pnpm fetch` just
# populated. A miss fails the build loudly, which is what we want:
# it would mean the fetch layer no longer matches the lockfile.
# (Lifecycle scripts such as prisma's engine download still run
# normally; --offline only constrains pnpm's own registry access.)
RUN pnpm install --frozen-lockfile --offline

# @gratis-gis/shared-types, @gratis-gis/engine, and
# @gratis-gis/form-schema all declare "main": "./dist/index.js" so
# they must be tsc-compiled before downstream packages can import
# from them; the runtime image is plain Node and cannot parse a
# workspace package whose entrypoint is raw TypeScript. form-schema
# joined the compiled set when the api started running the shared
# form validator server-side (forms.service submit path). ui stays
# pure-TS (nothing in the api runtime requires it). Building
# everything via turbo would also work but takes longer and pulls
# in the apps too.
RUN pnpm -C packages/shared-types build
RUN pnpm -C packages/engine build
RUN pnpm -C packages/form-schema build

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
# CVE-2026-56852, HIGH: go-pmtiles pins golang.org/x/text v0.35.0 and
# still does at v1.31.2, so bumping PMTILES_VERSION does not clear it.
# Fixed upstream in x/text 0.39.0.
ARG PMTILES_XTEXT_VERSION=0.39.0
# CVE-2026-46600, HIGH: go-pmtiles pulls golang.org/x/net v0.52.0, which
# bumping PMTILES_VERSION does not clear. Fixed upstream in x/net 0.56.0.
# Pinned here the same way as x/text so Trivy sees a patched version
# embedded in the binary. Watch for go-pmtiles adopting >=0.56.0 itself,
# at which point this pin can drop.
ARG PMTILES_XNET_VERSION=0.56.0
# GOTOOLCHAIN=auto (the default) lets Go honour go-pmtiles' go.mod
# directive and pull the matching toolchain if the image's Go is
# older than declared. CGO=0 produces a static binary that runs on
# any glibc; no need for the runtime image to carry libgo.
ENV CGO_ENABLED=0
# Built through a throwaway wrapper module rather than `go install`.
# go install resolves dependencies from the target module's own
# go.mod and cannot be told to upgrade one, whereas building the same
# main package from inside a module we control picks up our upgraded
# x/text. Keep the two `go get` lines in this order: the second one
# only sticks once go-pmtiles is in the graph.
RUN mkdir -p /pmtiles-build && cd /pmtiles-build \
    && go mod init pmtiles-build \
    && go get "github.com/protomaps/go-pmtiles@v${PMTILES_VERSION}" \
    && go get "golang.org/x/text@v${PMTILES_XTEXT_VERSION}" \
    && go get "golang.org/x/net@v${PMTILES_XNET_VERSION}" \
    && go build -o /go/bin/go-pmtiles github.com/protomaps/go-pmtiles \
    && go version -m /go/bin/go-pmtiles | grep -q "golang.org/x/text[[:space:]]*v${PMTILES_XTEXT_VERSION}" \
    && go version -m /go/bin/go-pmtiles | grep -q "golang.org/x/net[[:space:]]*v${PMTILES_XNET_VERSION}"

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
# resolve at the source rather than via .trivyignore. The same stage
# upgrades golang.org/x/text past CVE-2026-56852 and golang.org/x/net
# past CVE-2026-46600 for the same reason.
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

# Strip gdal-async's BUNDLED tar copy (7.5.9, flagged by Trivy as
# CVE-2026-59873/-59874 HIGH). It ships inside the package tarball
# as a bundledDependency, so the workspace-level pnpm override
# (tar ^7.5.16) cannot reach it. It exists solely for
# node-pre-gyp's INSTALL path (unpacking the prebuilt .node
# binary, which pnpm install already did in the build stage); the
# runtime path is `require('@mapbox/node-pre-gyp').find()`, which
# never loads the install module. Same delete-the-installer
# pattern as the pnpm strip above. gdal-async has no newer release
# to update to (3.12.3 is latest as of 2026-07).
RUN rm -rf /app/node_modules/.pnpm/gdal-async@*/node_modules/gdal-async/node_modules/tar \
    /app/node_modules/gdal-async/node_modules/tar

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
