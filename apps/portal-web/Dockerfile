# GratisGIS portal-web production image. Multi-stage:
#
#   - build: pnpm install + next build (output: standalone) at the
#     repo root so workspace deps (shared-types, ui, form-schema)
#     resolve. Next's tracer collects the runtime subset.
#   - runtime: node slim with the standalone server, public
#     assets, and prebuilt static chunks. Tiny image, no pnpm or
#     build chain.
#
# Built from the repo root:  docker build -f apps/portal-web/Dockerfile .
#
# Base is PINNED to an exact LTS version on purpose. The floating
# node:25 tag silently moved to 25.9.0 mid-day and its fetch broke
# ReadableStream request bodies ("expected non-null body source"),
# which took down every POST through the BFF proxy. Non-LTS current
# lines do not belong under prod, and floating tags turn upstream
# releases into unreviewed deploys. Bump this deliberately.

FROM node:24.18.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# See apps/portal-api/Dockerfile for the rationale on this block:
# install pnpm via npm (Node 25+ dropped bundled corepack) + delete
# bundled npm CLI + apt-get upgrade. Keeps Trivy noise down and
# picks up base OS patches.
RUN npm install -g pnpm@9.12.0 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
# pnpm's --frozen-lockfile expects EVERY workspace package referenced
# in the lockfile to exist in the tree. Copying the full apps/ subtree
# is the simplest way to satisfy that without per-package COPY juggling.
# .dockerignore on each app strips the heavy stuff (node_modules,
# .next, dist), so the build context stays small.
COPY apps ./apps
RUN pnpm install --frozen-lockfile

# @gratis-gis/shared-types and @gratis-gis/form-schema declare
# "main": "./dist/index.js" so they must be tsc-compiled before
# downstream packages can import from them (form-schema moved to a
# compiled dist when portal-api started running the shared form
# validator server-side; both apps now consume the same build).
# ui stays pure-TS (it exposes ./src/index.ts directly) so it needs
# no build step. transpilePackages in next.config.mjs covers the
# source-only packages at compile time.
RUN pnpm -C packages/shared-types build
RUN pnpm -C packages/form-schema build

# Telemetry is a noisy build-time stderr; not useful here.
ENV NEXT_TELEMETRY_DISABLED=1

# #274: NEXT_PUBLIC_* env vars must be present at build time so
# Next.js can inline them into the client bundle. Setting them in
# the runtime container env doesn't reach client components. The
# canonical gratisgis.org deployment passes
# NEXT_PUBLIC_PROJECT_LANDING=1 as a build arg from compose so the
# project marketing section renders below the Hero. Per-tenant
# deployments leave it unset and the Hero stands alone.
ARG NEXT_PUBLIC_PROJECT_LANDING=
ENV NEXT_PUBLIC_PROJECT_LANDING=$NEXT_PUBLIC_PROJECT_LANDING
ARG NEXT_PUBLIC_GITHUB_REPO=
ENV NEXT_PUBLIC_GITHUB_REPO=$NEXT_PUBLIC_GITHUB_REPO
# #141: set to "1" on public-testing deployments so the landing
# page renders the demo-credentials banner.  Defaults to empty so
# per-tenant forks don't accidentally advertise tester accounts.
ARG NEXT_PUBLIC_PUBLIC_TESTING=
ENV NEXT_PUBLIC_PUBLIC_TESTING=$NEXT_PUBLIC_PUBLIC_TESTING

# Self-host the DuckDB-WASM spatial extension (#175 unit 2). The
# browser Analyze panel loads spatial via
# `SET custom_extension_repository = '<origin>/duckdb-ext'`, and
# DuckDB resolves <repo>/<core-version>/<platform>/spatial... itself,
# so the directory layout here must mirror the official repository
# exactly. Downloading at image build time (network available) keeps
# the air-gap rule: prod visitors never hit extensions.duckdb.org.
# The version/platform pair MUST match the @duckdb/duckdb-wasm
# package's compiled-in core: verified v1.4.3 / wasm_eh for 1.32.0 by
# running the engine under Node and asking `SELECT version()` +
# `PRAGMA platform`. Bump these args when bumping the npm package.
# The file is a byte-identical mirror, so DuckDB's extension
# signature check still passes. curl -f fails the build on a bad
# download rather than baking a broken file.
ARG DUCKDB_WASM_CORE_VERSION=v1.4.3
ARG DUCKDB_WASM_PLATFORM=wasm_eh
# spatial is what the Analyze panel asks for explicitly; parquet /
# json / icu are extensions the WASM build ships DYNAMICALLY (they
# are statically linked in native DuckDB but autoloaded on demand in
# wasm; read_parquet proved it live by 404ing against a spatial-only
# mirror). With the repository pointed at our origin, every autoload
# resolves here, so the mirror must carry the full plausible set.
RUN mkdir -p "apps/portal-web/public/duckdb-ext/${DUCKDB_WASM_CORE_VERSION}/${DUCKDB_WASM_PLATFORM}" \
    && for ext in spatial parquet json icu; do \
      curl -fsSL --retry 3 \
        -o "apps/portal-web/public/duckdb-ext/${DUCKDB_WASM_CORE_VERSION}/${DUCKDB_WASM_PLATFORM}/${ext}.duckdb_extension.wasm" \
        "https://extensions.duckdb.org/${DUCKDB_WASM_CORE_VERSION}/${DUCKDB_WASM_PLATFORM}/${ext}.duckdb_extension.wasm" \
      || exit 1; \
    done

# MobileSAM mask decoder for the magic-outline tool: served as a
# static asset and executed in the browser via onnxruntime-web.
# Pulled from our pinned model release (Apache-2.0 provenance in
# the release notes) and hash-verified. Not committed to git: 16MB
# of weights don't belong in the repo; local dev without the file
# gets a plain "tool not installed" message in the editor.
RUN mkdir -p apps/portal-web/public/models \
    && curl -fsSL --retry 3 \
      -o apps/portal-web/public/models/mobilesam-decoder.onnx \
      "https://github.com/palavido-dev/gratis-gis/releases/download/models-mobilesam-v1/mobilesam-decoder.onnx" \
    && echo "b748cd34954653a52582745e4a853ae1f785a485b24a20a5c58565ab4c5f30a5  apps/portal-web/public/models/mobilesam-decoder.onnx" | sha256sum -c -

# onnxruntime-web executes the decoder; its wasm binaries must be
# self-hosted (prod never reaches a CDN). ort resolves them from
# env.wasm.wasmPaths = '/models/ort/' (set in lib/sam-outline.ts).
RUN mkdir -p apps/portal-web/public/models/ort \
    && cp node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist/*.wasm \
      apps/portal-web/public/models/ort/ \
    && cp node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist/*.mjs \
      apps/portal-web/public/models/ort/ 2>/dev/null || true

# GG_DEPLOYMENT_ID feeds next.config's `deploymentId`, which appends
# a per-deploy query param to every /_next asset URL. Required
# because Turbopack (the Next 16 default bundler) reuses chunk
# FILENAMES across builds while their contents change, and the
# chunks are served with a one-year immutable Cache-Control:
# returning browsers kept running the previous deploy's JS
# indefinitely. The nanosecond timestamp makes each image build a
# distinct deployment, so caches revalidate exactly once per
# deploy.
RUN GG_DEPLOYMENT_ID="$(date +%s%N)" pnpm -C apps/portal-web build

FROM base AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Remove the globally-installed pnpm from the runtime image.
# pnpm is only needed at build time (for `pnpm install` and the
# per-package builds); the Next.js standalone output runs from node
# directly. Stripping pnpm deletes the bundled tar, minimatch, glob,
# and cross-spawn copies under
# /usr/local/lib/node_modules/pnpm/dist/node_modules that Trivy
# flags as HIGH CVEs (CVE-2025-69262/-69263 in pnpm itself, plus
# CVE-2026-23745/-23950/-24842/-26960 in tar, CVE-2026-26996/-27903/
# -27904 in minimatch, CVE-2025-64756 in glob, CVE-2024-21538 in
# cross-spawn). Same pattern as the npm cleanup in the base stage.
RUN rm -rf /pnpm /usr/local/lib/node_modules/pnpm \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/pnpm-cjs

RUN groupadd -r app && useradd -r -g app -m -d /home/app app

# Standalone output. Next's tracer roots at /repo (outputFileTracingRoot
# in next.config.mjs) so the standalone tree mirrors that prefix; we
# flatten it back to /app here. The first COPY brings the server.js +
# minimal node_modules. The next two pull in /public and /.next/static
# which the standalone server can't include but expects to find at
# their original paths.
COPY --from=build --chown=app:app /repo/apps/portal-web/.next/standalone /app
COPY --from=build --chown=app:app /repo/apps/portal-web/public /app/apps/portal-web/public
COPY --from=build --chown=app:app /repo/apps/portal-web/.next/static /app/apps/portal-web/.next/static

USER app
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/ || exit 1

# The standalone server lives at <package>/server.js relative to the
# tracing root. Our root is the repo, so the server lands at
# /app/apps/portal-web/server.js.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/portal-web/server.js"]
