#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# portal-api container entrypoint. Applies pending Prisma migrations
# against $DATABASE_URL, then exec's the CMD. Idempotent: a fully-
# migrated DB no-ops in seconds.
#
# Migration failures (schema drift, contention) abort the boot so the
# container restart policy surfaces them as crash loops rather than a
# silent half-migrated state.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL is not set" >&2
  exit 1
fi

# pnpm deploy doesn't reliably carry the generated `.prisma/client/`
# directory (it's a sibling of @prisma/client, not a tracked file in
# the workspace), so the runtime image runs `prisma generate` once at
# boot to produce the platform-specific client + query engine. Cheap
# (~3 seconds) and idempotent on a subsequent restart.
if [[ -x /app/node_modules/.bin/prisma ]]; then
  echo "[entrypoint] generating prisma client"
  /app/node_modules/.bin/prisma generate --schema=/app/prisma/schema.prisma
else
  echo "FATAL: prisma CLI not found at /app/node_modules/.bin/prisma" >&2
  exit 1
fi

# Migration application is gated by SKIP_MIGRATE so we can run a
# dedicated one-shot `portal-migrate` service that owns the schema
# transition while every other container (api replicas, worker)
# starts past it without racing.
#
# Backwards compatible: if SKIP_MIGRATE is unset or any value other
# than "true", the entrypoint still applies migrations -- mirrors the
# pre-replicas single-container behavior.
if [[ "${SKIP_MIGRATE:-}" == "true" ]]; then
  echo "[entrypoint] SKIP_MIGRATE=true; assuming portal-migrate ran first."
else
  echo "[entrypoint] applying prisma migrations against $(echo "$DATABASE_URL" | sed -E 's#://[^@]+@#://***@#')"
  /app/node_modules/.bin/prisma migrate deploy --schema=/app/prisma/schema.prisma
fi

echo "[entrypoint] starting: $*"
exec "$@"
