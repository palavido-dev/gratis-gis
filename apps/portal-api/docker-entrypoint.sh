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

# Startup progress for the status page (src/startup-status.ts). Only
# when GG_STATUS_FILE is set: the NAS stack sets it on portal-api. Each
# step's output is also kept in a scratch log, so a failure can show
# its last lines on the page instead of only in `docker logs`.
STARTUP_LOG=""
if [[ -n "${GG_STATUS_FILE:-}" ]]; then
  STARTUP_LOG="$(mktemp 2>/dev/null || echo /tmp/gg-startup.log)"
  : > "$STARTUP_LOG" 2>/dev/null || STARTUP_LOG=""
fi
status() {
  [[ -n "${GG_STATUS_FILE:-}" ]] || return 0
  node /app/dist/startup-status.main.js "$@" >/dev/null 2>&1 || true
}
# Run one step, echoing its output as before and keeping a copy.
step() {
  if [[ -n "$STARTUP_LOG" ]]; then
    "$@" 2>&1 | tee -a "$STARTUP_LOG"
  else
    "$@"
  fi
}
on_exit() {
  local code=$?
  if [[ "$code" -ne 0 ]]; then
    status failed "$STARTUP_LOG"
  fi
}
trap on_exit EXIT
status starting

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL is not set" | tee -a "${STARTUP_LOG:-/dev/null}" >&2
  exit 1
fi

# pnpm deploy doesn't reliably carry the generated `.prisma/client/`
# directory (it's a sibling of @prisma/client, not a tracked file in
# the workspace), so the runtime image runs `prisma generate` once at
# boot to produce the platform-specific client + query engine. Cheap
# (~3 seconds) and idempotent on a subsequent restart.
if [[ -x /app/node_modules/.bin/prisma ]]; then
  echo "[entrypoint] generating prisma client"
  step /app/node_modules/.bin/prisma generate --schema=/app/prisma/schema.prisma
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
  # A new Postgres base image can change the C library's sort rules
  # under existing text indexes (#748). Rebuild them before anything
  # reads through them. A no-op when the databases are current.
  status database-check
  step node /app/dist/collation-refresh.main.js
  status database-update
  echo "[entrypoint] applying prisma migrations against $(echo "$DATABASE_URL" | sed -E 's#://[^@]+@#://***@#')"
  step /app/node_modules/.bin/prisma migrate deploy --schema=/app/prisma/schema.prisma
fi

status app-starting
# The app reports `ready` or `failed` itself from here (src/main.ts).
trap - EXIT
[[ -n "$STARTUP_LOG" ]] && rm -f "$STARTUP_LOG"
echo "[entrypoint] starting: $*"
exec "$@"
