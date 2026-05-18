# GratisGIS portal-web production image. Multi-stage:
#
#   - build: pnpm install + next build (output: standalone) at the
#     repo root so workspace deps (shared-types, ui, form-schema)
#     resolve. Next's tracer collects the runtime subset.
#   - runtime: node:20-slim with the standalone server, public assets,
#     and prebuilt static chunks. Tiny image, no pnpm or build chain.
#
# Built from the repo root:  docker build -f apps/portal-web/Dockerfile .

FROM node:26-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
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

# @gratis-gis/shared-types declares "main": "./dist/index.js" so it
# must be tsc-compiled before downstream packages can import from it.
# form-schema and ui are pure-TS (they expose ./src/index.ts directly)
# so they don't need a separate build step. transpilePackages in
# next.config.mjs covers the source-only packages at compile time.
RUN pnpm -C packages/shared-types build

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

RUN pnpm -C apps/portal-web build

FROM base AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

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
